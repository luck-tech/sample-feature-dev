import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import {
  TaskRow, TaskResponse, TaskHistoryRow, TaskStatus, TaskPriority,
  AppError, VALID_STATUS_TRANSITIONS, PRIORITY_ORDER, SortField, SortOrder,
} from '../types';
import { userService } from './user-service';
import { normalizeTags } from '../middleware/validator';

export class TaskService {

  // ---- Priority Escalation (Section 4.3) ----
  private escalatePriority(task: TaskRow): { priority: TaskPriority; escalated: boolean } {
    if (!task.due_date || task.status === 'done' || task.status === 'cancelled') {
      return { priority: task.priority, escalated: false };
    }

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const due = new Date(task.due_date);
    due.setHours(0, 0, 0, 0);
    const diffMs = due.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    let newPriority = task.priority;
    let escalated = false;

    if (diffDays < 0 && task.priority !== 'critical') {
      // Overdue
      newPriority = 'critical';
      escalated = true;
    } else if (diffDays <= 1 && (task.priority === 'low' || task.priority === 'medium')) {
      newPriority = 'high';
      escalated = true;
    } else if (diffDays <= 3 && task.priority === 'low') {
      newPriority = 'medium';
      escalated = true;
    }

    return { priority: newPriority, escalated };
  }

  private toResponse(task: TaskRow, includeHistories = false): TaskResponse {
    const tags: string[] = task.tags ? JSON.parse(task.tags) : [];
    const { priority, escalated } = this.escalatePriority(task);

    const response: TaskResponse = {
      ...task,
      tags,
      priority,
    };

    if (escalated) {
      response.priority_escalated = true;
    }

    if (includeHistories) {
      const db = getDb();
      response.histories = db.prepare(
        'SELECT * FROM task_histories WHERE task_id = ? ORDER BY created_at ASC'
      ).all(task.id) as TaskHistoryRow[];
    }

    return response;
  }

  private addHistory(taskId: string, changedBy: string, field: string, oldValue: string | null, newValue: string | null): void {
    const db = getDb();
    db.prepare(
      'INSERT INTO task_histories (id, task_id, changed_by, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), taskId, changedBy, field, oldValue, newValue, new Date().toISOString());
  }

  // ---- Status transition validation (Section 4.1) ----
  private validateStatusTransition(current: TaskStatus, next: TaskStatus, task: TaskRow): void {
    const allowed = VALID_STATUS_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new AppError(
        'INVALID_STATUS_TRANSITION',
        400,
        `Cannot transition from '${current}' to '${next}'`
      );
    }

    if (next === 'in_progress' && !task.assignee_id) {
      throw new AppError('VALIDATION_ERROR', 400, 'Cannot start work without an assignee');
    }

    if (next === 'in_review' && task.estimated_hours == null) {
      throw new AppError('VALIDATION_ERROR', 400, 'Cannot move to review without estimated hours');
    }
  }

  // ---- CRUD ----

  createTask(data: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    assignee_id?: string;
    reporter_id: string;
    due_date?: string;
    estimated_hours?: number;
    tags?: string[];
  }): TaskResponse {
    const db = getDb();

    // Validate reporter exists
    userService.getUserById(data.reporter_id);

    // Validate assignee & workload
    if (data.assignee_id) {
      const assignee = userService.getUserById(data.assignee_id);
      if (!assignee) {
        throw new AppError('VALIDATION_ERROR', 400, 'Assignee not found');
      }
      userService.checkWorkloadLimit(data.assignee_id);
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const tags = data.tags ? normalizeTags(data.tags) : [];

    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, assignee_id, reporter_id, due_date, estimated_hours, tags, created_at, updated_at)
      VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.title,
      data.description || null,
      data.priority || 'medium',
      data.assignee_id || null,
      data.reporter_id,
      data.due_date || null,
      data.estimated_hours ?? null,
      tags.length > 0 ? JSON.stringify(tags) : null,
      now,
      now
    );

    this.addHistory(id, data.reporter_id, 'created', null, 'Task created');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
    return this.toResponse(task);
  }

  getTasks(filters: {
    status?: string;
    priority?: string;
    assignee_id?: string;
    tag?: string;
    overdue?: string;
    sort?: string;
    order?: string;
    page: number;
    limit: number;
    offset: number;
  }): { tasks: TaskResponse[]; total: number } {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      const statuses = filters.status.split(',').map(s => s.trim());
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }

    if (filters.priority) {
      conditions.push('priority = ?');
      params.push(filters.priority);
    }

    if (filters.assignee_id) {
      conditions.push('assignee_id = ?');
      params.push(filters.assignee_id);
    }

    if (filters.tag) {
      conditions.push("tags LIKE ?");
      params.push(`%"${filters.tag.toLowerCase()}"%`);
    }

    if (filters.overdue === 'true') {
      conditions.push("due_date < date('now') AND status NOT IN ('done', 'cancelled')");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = (db.prepare(`SELECT COUNT(*) as count FROM tasks ${where}`).get(...params) as { count: number }).count;

    const validSorts: SortField[] = ['created_at', 'due_date', 'priority', 'updated_at'];
    let sortField = 'created_at';
    if (filters.sort && validSorts.includes(filters.sort as SortField)) {
      sortField = filters.sort;
    }
    // For priority sort, use CASE for proper ordering
    let orderByClause: string;
    if (sortField === 'priority') {
      const dir: SortOrder = filters.order === 'asc' ? 'asc' : 'desc';
      orderByClause = `ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 END ${dir}`;
    } else {
      const dir: SortOrder = filters.order === 'asc' ? 'asc' : 'desc';
      orderByClause = `ORDER BY ${sortField} ${dir}`;
    }

    const tasks = db.prepare(
      `SELECT * FROM tasks ${where} ${orderByClause} LIMIT ? OFFSET ?`
    ).all(...params, filters.limit, filters.offset) as TaskRow[];

    return { tasks: tasks.map(t => this.toResponse(t)), total };
  }

  getTaskById(id: string): TaskResponse {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {
      throw new AppError('NOT_FOUND', 404, `Task ${id} not found`);
    }
    return this.toResponse(task, true);
  }

  updateTask(id: string, updates: Record<string, unknown>, changedBy?: string): TaskResponse {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {
      throw new AppError('NOT_FOUND', 404, `Task ${id} not found`);
    }

    const changer = changedBy || task.reporter_id;

    // Status transition validation
    if (updates.status && updates.status !== task.status) {
      // Apply assignee update first if both are provided
      const effectiveTask = { ...task };
      if (updates.assignee_id !== undefined) {
        effectiveTask.assignee_id = updates.assignee_id as string | null;
      }
      if (updates.estimated_hours !== undefined) {
        effectiveTask.estimated_hours = updates.estimated_hours as number | null;
      }
      this.validateStatusTransition(task.status, updates.status as TaskStatus, effectiveTask);
    }

    // Assignee workload check
    if (updates.assignee_id && updates.assignee_id !== task.assignee_id) {
      const assignee = userService.getUserById(updates.assignee_id as string);
      if (assignee.role === 'viewer') {
        throw new AppError('VALIDATION_ERROR', 400, 'Cannot assign tasks to viewer users');
      }
      userService.checkWorkloadLimit(updates.assignee_id as string);
    }

    // Tag normalization
    if (updates.tags !== undefined && updates.tags !== null) {
      updates.tags = JSON.stringify(normalizeTags(updates.tags as string[]));
    } else if (updates.tags === null) {
      updates.tags = null;
    }

    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const setParams: unknown[] = [now];

    const fieldMap: Record<string, string> = {
      title: 'title', description: 'description', status: 'status',
      priority: 'priority', assignee_id: 'assignee_id', due_date: 'due_date',
      estimated_hours: 'estimated_hours', tags: 'tags',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        setClauses.push(`${col} = ?`);
        setParams.push(updates[key] ?? null);

        // Record history
        const oldVal = (task as unknown as Record<string, unknown>)[col];
        const oldStr = oldVal != null ? String(oldVal) : null;
        const newStr = updates[key] != null ? String(updates[key]) : null;
        if (oldStr !== newStr) {
          this.addHistory(id, changer, col, oldStr, newStr);
        }
      }
    }

    // Record actual hours on done transition
    if (updates.status === 'done') {
      const created = new Date(task.created_at).getTime();
      const nowMs = Date.now();
      const actualHours = ((nowMs - created) / (1000 * 60 * 60)).toFixed(2);
      this.addHistory(id, changer, 'actual_hours', null, actualHours);
    }

    setParams.push(id);
    db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...setParams);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
    return this.toResponse(updated, true);
  }

  deleteTask(id: string): void {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {
      throw new AppError('NOT_FOUND', 404, `Task ${id} not found`);
    }

    if (task.status !== 'done' && task.status !== 'cancelled') {
      throw new AppError(
        'CANNOT_DELETE_ACTIVE_TASK',
        400,
        'Only tasks with status done or cancelled can be deleted'
      );
    }

    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  assignTask(id: string, assigneeId: string): TaskResponse {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {
      throw new AppError('NOT_FOUND', 404, `Task ${id} not found`);
    }

    const assignee = userService.getUserById(assigneeId);
    if (assignee.role === 'viewer') {
      throw new AppError('VALIDATION_ERROR', 400, 'Cannot assign tasks to viewer users');
    }

    userService.checkWorkloadLimit(assigneeId);

    const updates: Record<string, unknown> = { assignee_id: assigneeId };

    // Auto-transition to in_progress if currently todo
    if (task.status === 'todo') {
      updates.status = 'in_progress';
    }

    return this.updateTask(id, updates, task.reporter_id);
  }

  unassignTask(id: string): TaskResponse {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {
      throw new AppError('NOT_FOUND', 404, `Task ${id} not found`);
    }

    const updates: Record<string, unknown> = { assignee_id: null };

    // Auto-transition to todo if currently in_progress
    if (task.status === 'in_progress') {
      updates.status = 'todo';
    }

    return this.updateTask(id, updates, task.reporter_id);
  }

  bulkUpdate(taskIds: string[], updates: { status?: TaskStatus; priority?: TaskPriority; assignee_id?: string }): {
    succeeded: string[];
    failed: { id: string; reason: string }[];
  } {
    if (taskIds.length > 50) {
      throw new AppError('VALIDATION_ERROR', 400, 'Maximum 50 tasks for bulk update');
    }

    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const taskId of taskIds) {
      try {
        this.updateTask(taskId, { ...updates });
        succeeded.push(taskId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        failed.push({ id: taskId, reason: message });
      }
    }

    return { succeeded, failed };
  }
}

export const taskService = new TaskService();
