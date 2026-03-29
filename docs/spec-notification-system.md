# 通知システム API 仕様書

## 1. 概要

タスク管理APIに統合される通知システム。タスクライフサイクルイベントに応じて自動的に通知を生成し、ユーザーへ配信する。通知ルールエンジン、集約機能、優先度自動設定を備える。

---

## 2. 通知イベント

以下のタスクイベントが通知をトリガーする：

| イベント種別 | トリガー条件 | 通知対象 |
|---|---|---|
| `task_created` | タスクが新規作成された | 割当者（存在する場合） |
| `task_assigned` | タスクに担当者が割り当てられた | 新しい割当者 |
| `task_unassigned` | タスクの担当者が解除された | 元の割当者 |
| `status_changed` | タスクのステータスが変更された | 割当者・報告者（変更者自身を除く） |
| `task_overdue` | タスクの期限が過ぎた | 割当者・報告者 |
| `priority_changed` | タスクの優先度が変更された | 割当者（変更者自身を除く） |
| `comment_added` | タスクにコメントが追加された（将来拡張用） | 割当者・報告者（コメント者自身を除く） |

### 2.1 通知対象の決定ルール

- **変更者自身には通知しない**（自分で変更したものの通知は不要）
- **viewerロールのユーザーにも通知する**（閲覧権限でも通知は受け取れる）
- **同一ユーザーが複数の対象条件に該当する場合は1通のみ**

---

## 3. データモデル

### 3.1 notifications テーブル

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `user_id` | TEXT | NOT NULL, FK(users.id) | 通知先ユーザー |
| `task_id` | TEXT | NOT NULL, FK(tasks.id) ON DELETE CASCADE | 関連タスク |
| `event_type` | TEXT | NOT NULL | イベント種別（Section 2参照） |
| `title` | TEXT | NOT NULL | 通知タイトル |
| `message` | TEXT | NOT NULL | 通知本文 |
| `priority` | TEXT | NOT NULL, DEFAULT 'normal' | `low` / `normal` / `high` / `urgent` |
| `is_read` | INTEGER | NOT NULL, DEFAULT 0 | 0=未読, 1=既読 |
| `read_at` | TEXT | NULL | 既読にした日時 |
| `aggregation_key` | TEXT | NULL | 集約キー（task_id + 時間窓で生成） |
| `aggregated_count` | INTEGER | NOT NULL, DEFAULT 1 | 集約された変更数 |
| `created_at` | TEXT | NOT NULL, DEFAULT datetime('now') | 作成日時 |
| `updated_at` | TEXT | NOT NULL, DEFAULT datetime('now') | 更新日時 |

### 3.2 notification_rules テーブル

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `user_id` | TEXT | NOT NULL, FK(users.id) | ルール所有者 |
| `event_type` | TEXT | NOT NULL | 対象イベント種別（`*` で全イベント） |
| `enabled` | INTEGER | NOT NULL, DEFAULT 1 | 0=無効, 1=有効 |
| `created_at` | TEXT | NOT NULL, DEFAULT datetime('now') | 作成日時 |

**一意制約**: `(user_id, event_type)` でユニーク

### 3.3 インデックス

```sql
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read);
CREATE INDEX idx_notifications_task_id ON notifications(task_id);
CREATE INDEX idx_notifications_aggregation_key ON notifications(aggregation_key);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);
CREATE INDEX idx_notification_rules_user_id ON notification_rules(user_id);
```

---

## 4. 通知優先度の自動設定

通知の優先度はタスクの状態から自動推定する：

| 条件 | 通知優先度 |
|---|---|
| タスク優先度が `critical` | `urgent` |
| タスク優先度が `high` | `high` |
| タスクが期限切れ（`task_overdue`） | `urgent` |
| タスク期限まで1日以内 + 優先度 `medium` 以上 | `high` |
| タスク期限まで3日以内 + 優先度 `high` 以上 | `high` |
| ステータスが `done` に変更 | `low` |
| ステータスが `cancelled` に変更 | `low` |
| 上記以外 | `normal` |

### 4.1 優先度決定の優先順位

複数条件に該当する場合は**最も高い優先度**を採用する。優先度の高い順：`urgent` > `high` > `normal` > `low`

---

## 5. 通知集約

### 5.1 集約ルール

同一タスクに対して **5分以内** に複数の変更が発生した場合、同一ユーザーへの通知を1つにまとめる。

- **集約キー**: `{task_id}:{user_id}:{5分単位のタイムバケット}`
  - タイムバケット: `Math.floor(timestamp_ms / (5 * 60 * 1000))`
- 既存の未読通知が同じ集約キーを持つ場合、新規通知は作成せず既存通知を更新する
- 更新内容：
  - `message` を最新のイベント内容で上書き
  - `aggregated_count` をインクリメント
  - `updated_at` を更新
  - `priority` は既存と新規で高い方を採用
  - `event_type` は最新のイベントで上書き

### 5.2 集約の例外

以下のイベントは集約せず、常に個別通知を生成する：
- `task_overdue`（期限切れ通知は重要なため）

### 5.3 集約制限

- `aggregated_count` が **10** を超えた場合は新しい通知を作成する（1通知に集約しすぎない）

---

## 6. API エンドポイント

### 6.1 GET /api/notifications

ログインユーザーの通知一覧を取得する。

**クエリパラメータ**:

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `user_id` | string | 必須 | 対象ユーザーID |
| `is_read` | `true`/`false` | - | 既読/未読フィルタ |
| `priority` | string | - | 優先度フィルタ（カンマ区切り可） |
| `event_type` | string | - | イベント種別フィルタ |
| `task_id` | string | - | タスクIDフィルタ |
| `page` | number | 1 | ページ番号 |
| `limit` | number | 20 | 1ページあたりの件数（最大100） |
| `sort` | string | `created_at` | ソートフィールド（`created_at`, `priority`, `updated_at`） |
| `order` | string | `desc` | ソート順（`asc`/`desc`） |

**レスポンス** (200):
```json
{
  "total": 42,
  "unread_count": 15,
  "page": 1,
  "limit": 20,
  "notifications": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "task_id": "uuid",
      "event_type": "status_changed",
      "title": "タスクのステータスが変更されました",
      "message": "「機能Aの実装」が in_progress から in_review に変更されました",
      "priority": "normal",
      "is_read": false,
      "read_at": null,
      "aggregated_count": 3,
      "created_at": "2026-03-26T10:00:00.000Z",
      "updated_at": "2026-03-26T10:04:30.000Z"
    }
  ]
}
```

### 6.2 GET /api/notifications/unread-count

未読通知数を返す。

**クエリパラメータ**:

| パラメータ | 型 | 説明 |
|---|---|---|
| `user_id` | string | 必須 |

**レスポンス** (200):
```json
{
  "unread_count": 15,
  "by_priority": {
    "urgent": 2,
    "high": 5,
    "normal": 7,
    "low": 1
  }
}
```

### 6.3 PATCH /api/notifications/:id/read

通知を既読にする。

**リクエストボディ**:
```json
{
  "user_id": "uuid"
}
```

**ビジネスルール**:
- `user_id` が通知の所有者でなければ `403 Forbidden`
- 既に既読の通知を再度既読にしても `200` を返す（冪等）

**レスポンス** (200):
```json
{
  "id": "uuid",
  "is_read": true,
  "read_at": "2026-03-26T10:05:00.000Z"
}
```

### 6.4 PATCH /api/notifications/read-all

ユーザーの全未読通知を一括既読にする。

**リクエストボディ**:
```json
{
  "user_id": "uuid",
  "task_id": "uuid (optional, 特定タスクの通知のみ)",
  "priority": "high (optional, 特定優先度以上のみ)"
}
```

**レスポンス** (200):
```json
{
  "updated_count": 15
}
```

### 6.5 DELETE /api/notifications/:id

通知を削除する。

**クエリパラメータ**:

| パラメータ | 型 | 説明 |
|---|---|---|
| `user_id` | string | 必須 |

**ビジネスルール**:
- `user_id` が通知の所有者でなければ `403 Forbidden`
- 未読の通知は削除できない（先に既読にする必要がある）
  - エラー: `400 Bad Request`、コード: `VALIDATION_ERROR`

**レスポンス** (204): 空レスポンス

### 6.6 POST /api/notifications/rules

通知ルールを作成/更新する。

**リクエストボディ**:
```json
{
  "user_id": "uuid",
  "event_type": "status_changed",
  "enabled": true
}
```

**ビジネスルール**:
- `event_type` は有効なイベント種別または `*`（ワイルドカード）
- 同じ `(user_id, event_type)` の組み合わせが既に存在する場合は `enabled` を更新（UPSERT）
- ユーザーが存在しない場合は `404`

**レスポンス** (200):
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "event_type": "status_changed",
  "enabled": true,
  "created_at": "2026-03-26T10:00:00.000Z"
}
```

### 6.7 GET /api/notifications/rules

ユーザーの通知ルール一覧を取得。

**クエリパラメータ**:

| パラメータ | 型 | 説明 |
|---|---|---|
| `user_id` | string | 必須 |

**レスポンス** (200):
```json
{
  "rules": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "event_type": "status_changed",
      "enabled": true,
      "created_at": "2026-03-26T10:00:00.000Z"
    }
  ]
}
```

### 6.8 DELETE /api/notifications/rules/:id

通知ルールを削除する。

**クエリパラメータ**:

| パラメータ | 型 | 説明 |
|---|---|---|
| `user_id` | string | 必須 |

**ビジネスルール**:
- `user_id` がルールの所有者でなければ `403 Forbidden`

**レスポンス** (204): 空レスポンス

---

## 7. 通知ルールエンジン

### 7.1 ルール評価フロー

1. イベント発生時、対象ユーザーを特定する（Section 2 参照）
2. 各対象ユーザーの通知ルールを確認する
3. 以下の順序でルールを評価：
   a. ワイルドカードルール（`event_type = '*'`）が存在し `enabled = false` なら**全通知を抑制**
   b. 特定イベントルールが存在し `enabled = false` なら**そのイベントを抑制**
   c. 特定イベントルールが存在し `enabled = true` なら**通知する**
   d. ルールが未設定の場合は**デフォルトで通知する**（オプトアウト方式）

### 7.2 ルール競合解決

- 特定イベントルールはワイルドカードルールより優先される
- 例: `* = disabled` かつ `task_overdue = enabled` の場合、`task_overdue` のみ通知される

---

## 8. エラーハンドリング

### 8.1 エラーコード

既存の `ErrorCode` 型に以下を追加：

| コード | HTTPステータス | 説明 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | バリデーションエラー（既存） |
| `FORBIDDEN` | 403 | 他ユーザーの通知への操作 |
| `NOT_FOUND` | 404 | 通知/ルールが存在しない（既存） |

### 8.2 エラーレスポンス形式

既存の `AppError` 形式に従う：
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to access this notification",
    "details": {}
  }
}
```

### 8.3 バリデーションルール

- `user_id` は必須。存在しないユーザーIDの場合は `404`
- `priority` フィルタの値は `low`, `normal`, `high`, `urgent` のいずれか
- `event_type` は定義済みイベント種別または `*`
- `page` は 1 以上、`limit` は 1 以上 100 以下

---

## 9. 通知メッセージテンプレート

| イベント | タイトル | メッセージ |
|---|---|---|
| `task_created` | タスクが作成されました | 「{task_title}」があなたに割り当てられました |
| `task_assigned` | タスクが割り当てられました | 「{task_title}」があなたに割り当てられました |
| `task_unassigned` | タスクの割り当てが解除されました | 「{task_title}」の割り当てが解除されました |
| `status_changed` | タスクのステータスが変更されました | 「{task_title}」が {old_status} から {new_status} に変更されました |
| `task_overdue` | タスクが期限切れです | 「{task_title}」の期限が過ぎています（期限: {due_date}） |
| `priority_changed` | タスクの優先度が変更されました | 「{task_title}」の優先度が {old_priority} から {new_priority} に変更されました |
