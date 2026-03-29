// ============ Enums ============

export type UserRole = 'admin' | 'member' | 'viewer';
export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type SortField = 'created_at' | 'due_date' | 'priority' | 'updated_at';
export type SortOrder = 'asc' | 'desc';

// ============ Database Row Types ============

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  max_tasks: number;
  created_at: string;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  reporter_id: string;
  due_date: string | null;
  estimated_hours: number | null;
  tags: string | null; // JSON array stored as string
  created_at: string;
  updated_at: string;
}

export interface TaskHistoryRow {
  id: string;
  task_id: string;
  changed_by: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

// ============ API Request Types ============

export interface CreateUserRequest {
  name: string;
  email: string;
  role?: UserRole;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee_id?: string;
  reporter_id: string;
  due_date?: string;
  estimated_hours?: number;
  tags?: string[];
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee_id?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  tags?: string[];
}

export interface AssignTaskRequest {
  assignee_id: string;
}

export interface BulkUpdateRequest {
  task_ids: string[];
  updates: {
    status?: TaskStatus;
    priority?: TaskPriority;
    assignee_id?: string;
  };
}

// ============ API Response Types ============

export interface TaskResponse extends Omit<TaskRow, 'tags'> {
  tags: string[];
  priority_escalated?: boolean;
  histories?: TaskHistoryRow[];
}

export interface PaginatedResponse<T> {
  total: number;
  page: number;
  limit: number;
  [key: string]: T[] | number;
}

export interface BulkUpdateResponse {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

export interface OverviewStats {
  total_tasks: number;
  by_status: Record<TaskStatus, number>;
  by_priority: Record<TaskPriority, number>;
  overdue_count: number;
  avg_completion_hours: number;
}

export interface UserStats {
  assigned_tasks: number;
  completed_tasks: number;
  overdue_tasks: number;
  workload_percentage: number;
}

// ============ Notification Types ============

export type NotificationEventType =
  | 'task_created'
  | 'task_assigned'
  | 'task_unassigned'
  | 'status_changed'
  | 'task_overdue'
  | 'priority_changed'
  | 'comment_added';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export const VALID_NOTIFICATION_EVENT_TYPES: NotificationEventType[] = [
  'task_created', 'task_assigned', 'task_unassigned',
  'status_changed', 'task_overdue', 'priority_changed', 'comment_added',
];

export const VALID_NOTIFICATION_PRIORITIES: NotificationPriority[] = ['low', 'normal', 'high', 'urgent'];

export const NOTIFICATION_PRIORITY_ORDER: Record<NotificationPriority, number> = {
  low: 0, normal: 1, high: 2, urgent: 3,
};

export const AGGREGATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_AGGREGATION_COUNT = 10;

export interface NotificationRow {
  id: string;
  user_id: string;
  task_id: string;
  event_type: NotificationEventType;
  title: string;
  message: string;
  priority: NotificationPriority;
  is_read: number; // 0 or 1
  read_at: string | null;
  aggregation_key: string | null;
  aggregated_count: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationResponse {
  id: string;
  user_id: string;
  task_id: string;
  event_type: NotificationEventType;
  title: string;
  message: string;
  priority: NotificationPriority;
  is_read: boolean;
  read_at: string | null;
  aggregated_count: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationRuleRow {
  id: string;
  user_id: string;
  event_type: string; // NotificationEventType or '*'
  enabled: number; // 0 or 1
  created_at: string;
}

export interface NotificationRuleResponse {
  id: string;
  user_id: string;
  event_type: string;
  enabled: boolean;
  created_at: string;
}

export interface CreateNotificationRuleRequest {
  user_id: string;
  event_type: string;
  enabled: boolean;
}

export interface NotificationEvent {
  type: NotificationEventType;
  task: TaskRow;
  actor_id: string; // user who triggered the event
  old_value?: string | null;
  new_value?: string | null;
}

// ============ Error Types ============

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_STATUS_TRANSITION'
  | 'WORKLOAD_LIMIT_EXCEEDED'
  | 'CANNOT_DELETE_ACTIVE_TASK'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ============ Status Transition Map ============

export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['in_review', 'todo', 'cancelled'],
  in_review: ['done', 'in_progress'],
  done: [],
  cancelled: ['todo'],
};

export const VALID_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];
export const VALID_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'critical'];
export const VALID_ROLES: UserRole[] = ['admin', 'member', 'viewer'];
export const PRIORITY_ORDER: Record<TaskPriority, number> = { low: 0, medium: 1, high: 2, critical: 3 };
