import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { UserRow, UserRole, AppError } from '../types';

export class UserService {
  createUser(name: string, email: string, role: UserRole = 'member'): UserRow {
    const db = getDb();
    const id = uuidv4();

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new AppError('CONFLICT', 409, `Email ${email} is already registered`);
    }

    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO users (id, name, email, role, max_tasks, created_at) VALUES (?, ?, ?, ?, 10, ?)'
    ).run(id, name, email, role, now);

    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  }

  getUsers(filters: { role?: string; page: number; limit: number; offset: number }): { users: UserRow[]; total: number } {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.role) {
      conditions.push('role = ?');
      params.push(filters.role);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = (db.prepare(`SELECT COUNT(*) as count FROM users ${where}`).get(...params) as { count: number }).count;
    const users = db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, filters.limit, filters.offset) as UserRow[];

    return { users, total };
  }

  getUserById(id: string): UserRow {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!user) {
      throw new AppError('NOT_FOUND', 404, `User ${id} not found`);
    }
    return user;
  }

  getActiveTaskCount(userId: string): number {
    const db = getDb();
    const result = db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE assignee_id = ? AND status IN ('todo', 'in_progress', 'in_review')"
    ).get(userId) as { count: number };
    return result.count;
  }

  checkWorkloadLimit(userId: string): void {
    const user = this.getUserById(userId);
    const current = this.getActiveTaskCount(userId);
    if (current >= user.max_tasks) {
      throw new AppError(
        'WORKLOAD_LIMIT_EXCEEDED',
        400,
        `User has reached maximum task limit (${current}/${user.max_tasks})`
      );
    }
  }
}

export const userService = new UserService();
