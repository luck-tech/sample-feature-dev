import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import {
  NotificationRow, NotificationResponse, NotificationRuleRow, NotificationRuleResponse,
  NotificationEvent, NotificationEventType, NotificationPriority,
  TaskRow, TaskPriority,
  AppError,
  VALID_NOTIFICATION_EVENT_TYPES, VALID_NOTIFICATION_PRIORITIES,
  NOTIFICATION_PRIORITY_ORDER,
  AGGREGATION_WINDOW_MS, MAX_AGGREGATION_COUNT,
} from '../types';

// ============ Message Templates ============

function generateNotificationTitle(eventType: NotificationEventType): string {
  const titles: Record<NotificationEventType, string> = {
    task_created: 'タスクが作成されました',
    task_assigned: 'タスクが割り当てられました',
    task_unassigned: 'タスクの割り当てが解除されました',
    status_changed: 'タスクのステータスが変更されました',
    task_overdue: 'タスクが期限切れです',
    priority_changed: 'タスクの優先度が変更されました',
    comment_added: 'タスクにコメントが追加されました',
  };
  return titles[eventType];
}

function generateNotificationMessage(event: NotificationEvent): string {
  const taskTitle = event.task.title;
  switch (event.type) {
    case 'task_created':
      return `「${taskTitle}」があなたに割り当てられました`;
    case 'task_assigned':
      return `「${taskTitle}」があなたに割り当てられました`;
    case 'task_unassigned':
      return `「${taskTitle}」の割り当てが解除されました`;
    case 'status_changed':
      return `「${taskTitle}」が ${event.old_value} から ${event.new_value} に変更されました`;
    case 'task_overdue':
      return `「${taskTitle}」の期限が過ぎています（期限: ${event.task.due_date}）`;
    case 'priority_changed':
      return `「${taskTitle}」の優先度が ${event.old_value} から ${event.new_value} に変更されました`;
    case 'comment_added':
      return `「${taskTitle}」にコメントが追加されました`;
  }
}

// ============ Priority Calculation ============

function calculateNotificationPriority(event: NotificationEvent): NotificationPriority {
  const task = event.task;
  const candidates: NotificationPriority[] = [];

  // Task priority mapping
  if (task.priority === 'critical') {
    candidates.push('urgent');
  } else if (task.priority === 'high') {
    candidates.push('high');
  }

  // Overdue event
  if (event.type === 'task_overdue') {
    candidates.push('urgent');
  }

  // Due date proximity
  if (task.due_date) {
    const now = new Date();
    const due = new Date(task.due_date);
    const diffMs = due.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (diffDays <= 1 && (task.priority === 'medium' || task.priority === 'high' || task.priority === 'critical')) {
      candidates.push('high');
    }
    if (diffDays <= 3 && (task.priority === 'high' || task.priority === 'critical')) {
      candidates.push('high');
    }
  }

  // Done/cancelled status change => low
  if (event.type === 'status_changed' && (event.new_value === 'done' || event.new_value === 'cancelled')) {
    candidates.push('low');
  }

  if (candidates.length === 0) {
    return 'normal';
  }

  // Return highest priority
  return candidates.reduce((highest, current) => {
    return NOTIFICATION_PRIORITY_ORDER[current] > NOTIFICATION_PRIORITY_ORDER[highest] ? current : highest;
  });
}

function higherPriority(a: NotificationPriority, b: NotificationPriority): NotificationPriority {
  return NOTIFICATION_PRIORITY_ORDER[a] >= NOTIFICATION_PRIORITY_ORDER[b] ? a : b;
}

// ============ Aggregation Key ============

function generateAggregationKey(taskId: string, userId: string, timestampMs: number): string {
  const bucket = Math.floor(timestampMs / AGGREGATION_WINDOW_MS);
  return `${taskId}:${userId}:${bucket}`;
}

// ============ Target Users ============

function determineTargetUsers(event: NotificationEvent): string[] {
  const task = event.task;
  const actorId = event.actor_id;
  const targets = new Set<string>();

  switch (event.type) {
    case 'task_created':
      if (task.assignee_id) targets.add(task.assignee_id);
      break;
    case 'task_assigned':
      if (task.assignee_id) targets.add(task.assignee_id);
      break;
    case 'task_unassigned':
      // old_value contains the previous assignee_id
      if (event.old_value) targets.add(event.old_value);
      break;
    case 'status_changed':
      if (task.assignee_id) targets.add(task.assignee_id);
      targets.add(task.reporter_id);
      break;
    case 'task_overdue':
      if (task.assignee_id) targets.add(task.assignee_id);
      targets.add(task.reporter_id);
      break;
    case 'priority_changed':
      if (task.assignee_id) targets.add(task.assignee_id);
      break;
    case 'comment_added':
      if (task.assignee_id) targets.add(task.assignee_id);
      targets.add(task.reporter_id);
      break;
  }

  // Remove the actor (don't notify yourself)
  targets.delete(actorId);

  return [...targets];
}

// ============ Row to Response ============

function toNotificationResponse(row: NotificationRow): NotificationResponse {
  return {
    id: row.id,
    user_id: row.user_id,
    task_id: row.task_id,
    event_type: row.event_type,
    title: row.title,
    message: row.message,
    priority: row.priority,
    is_read: row.is_read === 1,
    read_at: row.read_at,
    aggregated_count: row.aggregated_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRuleResponse(row: NotificationRuleRow): NotificationRuleResponse {
  return {
    id: row.id,
    user_id: row.user_id,
    event_type: row.event_type,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

// ============ Service ============

export class NotificationService {

  // ---- Rule Engine ----

  private isNotificationEnabled(userId: string, eventType: NotificationEventType): boolean {
    const db = getDb();

    // Check specific event rule
    const specificRule = db.prepare(
      'SELECT * FROM notification_rules WHERE user_id = ? AND event_type = ?'
    ).get(userId, eventType) as NotificationRuleRow | undefined;

    if (specificRule) {
      return specificRule.enabled === 1;
    }

    // Check wildcard rule
    const wildcardRule = db.prepare(
      "SELECT * FROM notification_rules WHERE user_id = ? AND event_type = '*'"
    ).get(userId) as NotificationRuleRow | undefined;

    if (wildcardRule) {
      return wildcardRule.enabled === 1;
    }

    // Default: enabled (opt-out model)
    return true;
  }

  // ---- Emit Notification ----

  emitNotification(event: NotificationEvent): NotificationResponse[] {
    const targetUsers = determineTargetUsers(event);
    const results: NotificationResponse[] = [];

    for (const userId of targetUsers) {
      // Check rule engine
      if (!this.isNotificationEnabled(userId, event.type)) {
        continue;
      }

      const notification = this.createOrAggregateNotification(userId, event);
      if (notification) {
        results.push(notification);
      }
    }

    return results;
  }

  private createOrAggregateNotification(userId: string, event: NotificationEvent): NotificationResponse {
    const db = getDb();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const title = generateNotificationTitle(event.type);
    const message = generateNotificationMessage(event);
    const priority = calculateNotificationPriority(event);

    // Check for aggregation (except task_overdue which is never aggregated)
    if (event.type !== 'task_overdue') {
      const aggregationKey = generateAggregationKey(event.task.id, userId, now);

      const existing = db.prepare(
        'SELECT * FROM notifications WHERE aggregation_key = ? AND is_read = 0'
      ).get(aggregationKey) as NotificationRow | undefined;

      if (existing && existing.aggregated_count < MAX_AGGREGATION_COUNT) {
        // Aggregate: update existing notification
        const newPriority = higherPriority(existing.priority, priority);
        db.prepare(`
          UPDATE notifications
          SET message = ?, priority = ?, event_type = ?, aggregated_count = aggregated_count + 1, updated_at = ?
          WHERE id = ?
        `).run(message, newPriority, event.type, nowIso, existing.id);

        const updated = db.prepare('SELECT * FROM notifications WHERE id = ?').get(existing.id) as NotificationRow;
        return toNotificationResponse(updated);
      }
    }

    // Create new notification
    const id = uuidv4();
    const aggregationKey = event.type !== 'task_overdue'
      ? generateAggregationKey(event.task.id, userId, now)
      : null;

    db.prepare(`
      INSERT INTO notifications (id, user_id, task_id, event_type, title, message, priority, is_read, read_at, aggregation_key, aggregated_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 1, ?, ?)
    `).run(id, userId, event.task.id, event.type, title, message, priority, aggregationKey, nowIso, nowIso);

    const created = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow;
    return toNotificationResponse(created);
  }

  // ---- Query Notifications ----

  getNotifications(filters: {
    user_id: string;
    is_read?: string;
    priority?: string;
    event_type?: string;
    task_id?: string;
    sort?: string;
    order?: string;
    page: number;
    limit: number;
    offset: number;
  }): { notifications: NotificationResponse[]; total: number; unread_count: number } {
    const db = getDb();
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [filters.user_id];

    if (filters.is_read !== undefined) {
      conditions.push('is_read = ?');
      params.push(filters.is_read === 'true' ? 1 : 0);
    }

    if (filters.priority) {
      const priorities = filters.priority.split(',').map(p => p.trim());
      conditions.push(`priority IN (${priorities.map(() => '?').join(',')})`);
      params.push(...priorities);
    }

    if (filters.event_type) {
      conditions.push('event_type = ?');
      params.push(filters.event_type);
    }

    if (filters.task_id) {
      conditions.push('task_id = ?');
      params.push(filters.task_id);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const total = (db.prepare(`SELECT COUNT(*) as count FROM notifications ${where}`).get(...params) as { count: number }).count;

    // Unread count for this user (not filtered)
    const unread_count = (db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(filters.user_id) as { count: number }).count;

    // Sort
    const validSorts = ['created_at', 'priority', 'updated_at'];
    let sortField = 'created_at';
    if (filters.sort && validSorts.includes(filters.sort)) {
      sortField = filters.sort;
    }

    let orderByClause: string;
    const dir = filters.order === 'asc' ? 'asc' : 'desc';
    if (sortField === 'priority') {
      orderByClause = `ORDER BY CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 END ${dir}`;
    } else {
      orderByClause = `ORDER BY ${sortField} ${dir}`;
    }

    const rows = db.prepare(
      `SELECT * FROM notifications ${where} ${orderByClause} LIMIT ? OFFSET ?`
    ).all(...params, filters.limit, filters.offset) as NotificationRow[];

    return {
      notifications: rows.map(toNotificationResponse),
      total,
      unread_count,
    };
  }

  getUnreadCount(userId: string): { unread_count: number; by_priority: Record<NotificationPriority, number> } {
    const db = getDb();

    const total = (db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(userId) as { count: number }).count;

    const byPriority: Record<NotificationPriority, number> = { low: 0, normal: 0, high: 0, urgent: 0 };
    const rows = db.prepare(
      'SELECT priority, COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0 GROUP BY priority'
    ).all(userId) as { priority: NotificationPriority; count: number }[];

    for (const row of rows) {
      byPriority[row.priority] = row.count;
    }

    return { unread_count: total, by_priority: byPriority };
  }

  // ---- Mark Read ----

  markAsRead(notificationId: string, userId: string): NotificationResponse {
    const db = getDb();
    const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId) as NotificationRow | undefined;

    if (!notification) {
      throw new AppError('NOT_FOUND', 404, `Notification ${notificationId} not found`);
    }

    if (notification.user_id !== userId) {
      throw new AppError('FORBIDDEN', 403, 'You do not have permission to access this notification');
    }

    if (notification.is_read === 0) {
      const now = new Date().toISOString();
      db.prepare('UPDATE notifications SET is_read = 1, read_at = ?, updated_at = ? WHERE id = ?').run(now, now, notificationId);
    }

    const updated = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId) as NotificationRow;
    return toNotificationResponse(updated);
  }

  markAllAsRead(userId: string, options?: { task_id?: string; priority?: string }): number {
    const db = getDb();
    const conditions: string[] = ['user_id = ?', 'is_read = 0'];
    const params: unknown[] = [userId];

    if (options?.task_id) {
      conditions.push('task_id = ?');
      params.push(options.task_id);
    }

    if (options?.priority) {
      // Mark all with this priority or higher
      const minOrder = NOTIFICATION_PRIORITY_ORDER[options.priority as NotificationPriority];
      if (minOrder !== undefined) {
        const qualifying = VALID_NOTIFICATION_PRIORITIES.filter(
          p => NOTIFICATION_PRIORITY_ORDER[p] >= minOrder
        );
        conditions.push(`priority IN (${qualifying.map(() => '?').join(',')})`);
        params.push(...qualifying);
      }
    }

    const now = new Date().toISOString();
    const where = conditions.join(' AND ');
    const result = db.prepare(`UPDATE notifications SET is_read = 1, read_at = ?, updated_at = ? WHERE ${where}`).run(now, now, ...params);
    return result.changes;
  }

  // ---- Delete ----

  deleteNotification(notificationId: string, userId: string): void {
    const db = getDb();
    const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId) as NotificationRow | undefined;

    if (!notification) {
      throw new AppError('NOT_FOUND', 404, `Notification ${notificationId} not found`);
    }

    if (notification.user_id !== userId) {
      throw new AppError('FORBIDDEN', 403, 'You do not have permission to access this notification');
    }

    if (notification.is_read === 0) {
      throw new AppError('VALIDATION_ERROR', 400, 'Cannot delete unread notifications. Mark as read first.');
    }

    db.prepare('DELETE FROM notifications WHERE id = ?').run(notificationId);
  }

  // ---- Notification Rules ----

  createOrUpdateRule(userId: string, eventType: string, enabled: boolean): NotificationRuleResponse {
    const db = getDb();

    // Validate event_type
    if (eventType !== '*' && !VALID_NOTIFICATION_EVENT_TYPES.includes(eventType as NotificationEventType)) {
      throw new AppError('VALIDATION_ERROR', 400, `Invalid event_type: ${eventType}. Must be one of: ${VALID_NOTIFICATION_EVENT_TYPES.join(', ')}, *`);
    }

    // Check user exists
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) {
      throw new AppError('NOT_FOUND', 404, `User ${userId} not found`);
    }

    // UPSERT
    const existing = db.prepare(
      'SELECT * FROM notification_rules WHERE user_id = ? AND event_type = ?'
    ).get(userId, eventType) as NotificationRuleRow | undefined;

    if (existing) {
      db.prepare('UPDATE notification_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, existing.id);
      const updated = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(existing.id) as NotificationRuleRow;
      return toRuleResponse(updated);
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO notification_rules (id, user_id, event_type, enabled, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, userId, eventType, enabled ? 1 : 0, now);

    const created = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(id) as NotificationRuleRow;
    return toRuleResponse(created);
  }

  getRules(userId: string): NotificationRuleResponse[] {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM notification_rules WHERE user_id = ? ORDER BY created_at ASC'
    ).all(userId) as NotificationRuleRow[];
    return rows.map(toRuleResponse);
  }

  deleteRule(ruleId: string, userId: string): void {
    const db = getDb();
    const rule = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(ruleId) as NotificationRuleRow | undefined;

    if (!rule) {
      throw new AppError('NOT_FOUND', 404, `Notification rule ${ruleId} not found`);
    }

    if (rule.user_id !== userId) {
      throw new AppError('FORBIDDEN', 403, 'You do not have permission to delete this rule');
    }

    db.prepare('DELETE FROM notification_rules WHERE id = ?').run(ruleId);
  }
}

export const notificationService = new NotificationService();
