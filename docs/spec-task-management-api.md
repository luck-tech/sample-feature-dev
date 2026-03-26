# タスク管理API 仕様書

## 1. 概要

チーム向けタスク管理APIサーバー。タスクの作成・更新・割り当て・ステータス遷移を管理し、期限ベースの優先度自動エスカレーション、担当者のワークロードバランシング、ステータスの状態遷移制約を備える。

技術スタック: Node.js / Express / TypeScript / PostgreSQL

---

## 2. データモデル

### 2.1 ユーザー (users)

| カラム | 型 | 説明 |
|--------|------|------|
| id | UUID | 主キー |
| name | string | ユーザー名（必須、2〜50文字） |
| email | string | メールアドレス（必須、一意、メール形式） |
| role | enum | `admin`, `member`, `viewer` |
| max_tasks | integer | 同時担当可能タスク上限（デフォルト: 10） |
| created_at | timestamp | 作成日時 |

### 2.2 タスク (tasks)

| カラム | 型 | 説明 |
|--------|------|------|
| id | UUID | 主キー |
| title | string | タイトル（必須、5〜200文字） |
| description | string | 説明（任意、最大2000文字） |
| status | enum | `todo`, `in_progress`, `in_review`, `done`, `cancelled` |
| priority | enum | `low`, `medium`, `high`, `critical` |
| assignee_id | UUID | 担当者（任意、usersへの外部キー） |
| reporter_id | UUID | 報告者（必須、usersへの外部キー） |
| due_date | date | 期限日（任意） |
| estimated_hours | decimal | 見積もり工数（任意、0.5〜100.0） |
| tags | string[] | タグ配列（任意、各タグ1〜30文字、最大10個） |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

### 2.3 タスク履歴 (task_histories)

| カラム | 型 | 説明 |
|--------|------|------|
| id | UUID | 主キー |
| task_id | UUID | 対象タスク |
| changed_by | UUID | 変更者 |
| field | string | 変更されたフィールド名 |
| old_value | string | 変更前の値 |
| new_value | string | 変更後の値 |
| created_at | timestamp | 変更日時 |

---

## 3. APIエンドポイント

### 3.1 ユーザー管理

#### POST /api/users
- ユーザーを新規作成する
- リクエストボディ: `{ name, email, role? }`
- roleが省略された場合は `member` をデフォルトとする
- emailが既に存在する場合は 409 Conflict を返す
- バリデーションエラーは 400 Bad Request を返す

#### GET /api/users
- ユーザー一覧を取得する
- クエリパラメータ: `role`（フィルタリング）、`page`（デフォルト1）、`limit`（デフォルト20、最大100）
- レスポンス: `{ users: [...], total: number, page: number, limit: number }`

#### GET /api/users/:id
- 指定IDのユーザーを取得する
- 存在しない場合は 404 Not Found を返す

### 3.2 タスク管理

#### POST /api/tasks
- タスクを新規作成する
- リクエストボディ: `{ title, description?, priority?, assignee_id?, reporter_id, due_date?, estimated_hours?, tags? }`
- priorityが省略された場合は `medium` をデフォルトとする
- statusは常に `todo` で作成される
- assignee_idが指定された場合、担当者のワークロード上限チェックを行う（セクション4.2参照）
- reporter_idが存在しないユーザーの場合は 400 Bad Request を返す
- due_dateが過去日の場合は 400 Bad Request を返す
- タスク作成時にtask_historiesに「created」レコードを追加する

#### GET /api/tasks
- タスク一覧を取得する
- クエリパラメータ:
  - `status`: ステータスフィルタ（カンマ区切りで複数指定可）
  - `priority`: 優先度フィルタ
  - `assignee_id`: 担当者フィルタ
  - `tag`: タグフィルタ（指定タグを含むタスクを返す）
  - `overdue`: `true`の場合、期限切れタスクのみ返す
  - `sort`: ソート項目（`created_at`, `due_date`, `priority`, `updated_at`）
  - `order`: `asc` または `desc`（デフォルト `desc`）
  - `page`, `limit`: ページネーション
- レスポンス: `{ tasks: [...], total: number, page: number, limit: number }`

#### GET /api/tasks/:id
- 指定IDのタスクを取得する
- レスポンスにはタスク履歴（task_histories）も含める

#### PATCH /api/tasks/:id
- タスクを更新する
- 更新可能フィールド: `title`, `description`, `status`, `priority`, `assignee_id`, `due_date`, `estimated_hours`, `tags`
- statusの変更はステータス遷移ルールに従う（セクション4.1参照）
- assignee_idの変更時はワークロード上限チェックを行う（セクション4.2参照）
- 変更されたフィールドごとにtask_historiesにレコードを追加する
- updated_atを現在時刻に更新する

#### DELETE /api/tasks/:id
- タスクを削除する
- statusが `done` または `cancelled` のタスクのみ削除可能
- それ以外のステータスのタスクを削除しようとした場合は 400 Bad Request を返す
- 削除はソフトデリートではなく物理削除とする

### 3.3 タスク割り当て

#### POST /api/tasks/:id/assign
- タスクに担当者を割り当てる
- リクエストボディ: `{ assignee_id }`
- ワークロード上限チェックを行う（セクション4.2参照）
- roleが `viewer` のユーザーには割り当て不可（400 Bad Request）
- 割り当て時にstatusが `todo` の場合、自動的に `in_progress` に遷移する

#### POST /api/tasks/:id/unassign
- タスクの担当者を解除する
- statusが `in_progress` の場合、自動的に `todo` に遷移する

### 3.4 一括操作

#### POST /api/tasks/bulk-update
- 複数タスクを一括更新する
- リクエストボディ: `{ task_ids: string[], updates: { status?, priority?, assignee_id? } }`
- task_idsは最大50件まで
- 各タスクに対して個別のバリデーション（ステータス遷移、ワークロード上限）を実行する
- 一部のタスクがバリデーションエラーの場合も、成功したタスクは更新する（部分成功）
- レスポンス: `{ succeeded: string[], failed: { id: string, reason: string }[] }`

### 3.5 統計

#### GET /api/stats/overview
- 全体統計を返す
- レスポンス:
  ```json
  {
    "total_tasks": number,
    "by_status": { "todo": number, "in_progress": number, "in_review": number, "done": number, "cancelled": number },
    "by_priority": { "low": number, "medium": number, "high": number, "critical": number },
    "overdue_count": number,
    "avg_completion_hours": number
  }
  ```

#### GET /api/stats/users/:id
- 特定ユーザーの統計を返す
- レスポンス:
  ```json
  {
    "assigned_tasks": number,
    "completed_tasks": number,
    "overdue_tasks": number,
    "workload_percentage": number
  }
  ```
- workload_percentageは `assigned_tasks / max_tasks * 100` で算出する

---

## 4. ビジネスルール

### 4.1 ステータス遷移ルール

以下の遷移のみ許可する。それ以外の遷移は 400 Bad Request を返す。

```
todo → in_progress
todo → cancelled
in_progress → in_review
in_progress → todo
in_progress → cancelled
in_review → done
in_review → in_progress
done → （遷移不可）
cancelled → todo（再オープン）
```

#### 遷移時の追加ルール
- `in_progress` への遷移時、assignee_idが未設定の場合は 400 Bad Request を返す（担当者なしでは作業開始できない）
- `in_review` への遷移時、estimated_hoursが未設定の場合は 400 Bad Request を返す（工数見積もりなしではレビューに出せない）
- `done` への遷移時、updated_atとcreated_atの差分を実績工数として記録する

### 4.2 ワークロード上限チェック

- ユーザーが担当中（status が `todo`, `in_progress`, `in_review`）のタスク数が `max_tasks` に達している場合、新たなタスクの割り当てを拒否する（400 Bad Request）
- エラーメッセージ: `"User has reached maximum task limit ({current}/{max})"`

### 4.3 優先度自動エスカレーション

タスク取得時（GET）に以下のロジックを適用する（DBの値は変更しない、レスポンスのみ）:

- 期限日が **3日以内** かつ priority が `low` の場合 → レスポンスでは `medium` として返す
- 期限日が **1日以内** かつ priority が `low` または `medium` の場合 → レスポンスでは `high` として返す
- 期限が **過ぎている** かつ priority が `critical` 以外の場合 → レスポンスでは `critical` として返す
- レスポンスに `priority_escalated: true` フラグを付与する

### 4.4 タグの正規化

- タグは保存時に小文字に正規化する
- 重複するタグは自動的に除去する
- 空文字のタグは除去する

### 4.5 ページネーション

- pageが1未満の場合は1に補正する
- limitが1未満の場合は1に、100を超える場合は100に補正する
- totalがoffsetより小さい場合は空配列を返す

---

## 5. エラーレスポンス形式

すべてのエラーは以下の形式で返す:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "人間が読めるエラーメッセージ",
    "details": {}
  }
}
```

### エラーコード一覧

| コード | HTTPステータス | 説明 |
|--------|--------------|------|
| VALIDATION_ERROR | 400 | バリデーションエラー（detailsにフィールドごとのエラーを含む） |
| INVALID_STATUS_TRANSITION | 400 | 許可されていないステータス遷移 |
| WORKLOAD_LIMIT_EXCEEDED | 400 | ワークロード上限超過 |
| CANNOT_DELETE_ACTIVE_TASK | 400 | アクティブなタスクの削除不可 |
| NOT_FOUND | 404 | リソースが見つからない |
| CONFLICT | 409 | 重複（メールアドレスなど） |
| INTERNAL_ERROR | 500 | 内部エラー |
