import { getDb } from '../db/connection';
import { OverviewStats, UserStats, TaskStatus, TaskPriority } from '../types';
import { userService } from './user-service';

export class StatsService {
  getOverview(): OverviewStats {
    const db = getDb();

    const totalResult = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };

    const statusRows = db.prepare(
      'SELECT status, COUNT(*) as count FROM tasks GROUP BY status'
    ).all() as { status: TaskStatus; count: number }[];

    const byStatus: Record<TaskStatus, number> = {
      todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0,
    };
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }

    const priorityRows = db.prepare(
      'SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority'
    ).all() as { priority: TaskPriority; count: number }[];

    const byPriority: Record<TaskPriority, number> = {
      low: 0, medium: 0, high: 0, critical: 0,
    };
    for (const row of priorityRows) {
      byPriority[row.priority] = row.count;
    }

    const overdueResult = db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE due_date < date('now') AND status NOT IN ('done', 'cancelled')"
    ).get() as { count: number };

    const avgResult = db.prepare(
      "SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) as avg_hours FROM tasks WHERE status = 'done'"
    ).get() as { avg_hours: number | null };

    return {
      total_tasks: totalResult.count,
      by_status: byStatus,
      by_priority: byPriority,
      overdue_count: overdueResult.count,
      avg_completion_hours: Math.round((avgResult.avg_hours || 0) * 100) / 100,
    };
  }

  getUserStats(userId: string): UserStats {
    const user = userService.getUserById(userId);
    const db = getDb();

    const assignedResult = db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE assignee_id = ? AND status IN ('todo', 'in_progress', 'in_review')"
    ).get(userId) as { count: number };

    const completedResult = db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE assignee_id = ? AND status = 'done'"
    ).get(userId) as { count: number };

    const overdueResult = db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE assignee_id = ? AND due_date < date('now') AND status NOT IN ('done', 'cancelled')"
    ).get(userId) as { count: number };

    const workloadPercentage = Math.round((assignedResult.count / user.max_tasks) * 100 * 100) / 100;

    return {
      assigned_tasks: assignedResult.count,
      completed_tasks: completedResult.count,
      overdue_tasks: overdueResult.count,
      workload_percentage: workloadPercentage,
    };
  }
}

export const statsService = new StatsService();
