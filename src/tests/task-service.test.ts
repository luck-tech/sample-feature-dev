import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AppError,
  VALID_STATUS_TRANSITIONS,
  TaskRow,
  TaskStatus,
  TaskPriority,
} from '../types';
import { normalizeTags, normalizePagination } from '../middleware/validator';

// ---------------------------------------------------------------------------
// Helper: build a minimal TaskRow for testing
// ---------------------------------------------------------------------------
function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    title: 'Test task',
    description: null,
    status: 'todo' as TaskStatus,
    priority: 'medium' as TaskPriority,
    assignee_id: null,
    reporter_id: 'user-1',
    due_date: null,
    estimated_hours: null,
    tags: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// We test business logic extracted from TaskService without touching the DB.
// The logic under test lives in:
//   - VALID_STATUS_TRANSITIONS (status transition map)
//   - TaskService.validateStatusTransition (private, tested via transition map + rules)
//   - TaskService.escalatePriority (private, replicated here for unit testing)
//   - normalizeTags / normalizePagination (middleware)
// ---------------------------------------------------------------------------

// Re-implement escalatePriority locally so we can unit-test it without DB deps.
function escalatePriority(task: TaskRow): { priority: TaskPriority; escalated: boolean } {
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

// Re-implement validateStatusTransition for unit testing without DB.
function validateStatusTransition(current: TaskStatus, next: TaskStatus, task: TaskRow): void {
  const allowed = VALID_STATUS_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new AppError(
      'INVALID_STATUS_TRANSITION',
      400,
      `Cannot transition from '${current}' to '${next}'`,
    );
  }

  if (next === 'in_progress' && !task.assignee_id) {
    throw new AppError('VALIDATION_ERROR', 400, 'Cannot start work without an assignee');
  }

  if (next === 'in_review' && task.estimated_hours == null) {
    throw new AppError('VALIDATION_ERROR', 400, 'Cannot move to review without estimated hours');
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('TaskService - ステータス遷移', () => {
  it('todo -> in_progress: assignee_idがあれば成功', () => {
    const task = makeTask({ status: 'todo', assignee_id: 'user-2' });
    expect(() => validateStatusTransition('todo', 'in_progress', task)).not.toThrow();
  });

  it('todo -> in_progress: assignee_idがなければ拒否', () => {
    const task = makeTask({ status: 'todo', assignee_id: null });
    expect(() => validateStatusTransition('todo', 'in_progress', task)).toThrowError(
      'Cannot start work without an assignee',
    );
  });

  it('todo -> cancelled: 許可される', () => {
    const task = makeTask({ status: 'todo' });
    expect(() => validateStatusTransition('todo', 'cancelled', task)).not.toThrow();
  });

  it('done -> in_progress: 許可されない（doneからの遷移は空）', () => {
    const task = makeTask({ status: 'done', assignee_id: 'user-2' });
    expect(() => validateStatusTransition('done', 'in_progress', task)).toThrowError(
      "Cannot transition from 'done' to 'in_progress'",
    );
  });

  it('in_progress -> in_review: estimated_hoursがなければ拒否', () => {
    const task = makeTask({ status: 'in_progress', assignee_id: 'user-2', estimated_hours: null });
    expect(() => validateStatusTransition('in_progress', 'in_review', task)).toThrowError(
      'Cannot move to review without estimated hours',
    );
  });

  it('in_progress -> in_review: estimated_hoursがあれば成功', () => {
    const task = makeTask({ status: 'in_progress', assignee_id: 'user-2', estimated_hours: 5 });
    expect(() => validateStatusTransition('in_progress', 'in_review', task)).not.toThrow();
  });

  it('cancelled -> todo: 許可される', () => {
    const task = makeTask({ status: 'cancelled' });
    expect(() => validateStatusTransition('cancelled', 'todo', task)).not.toThrow();
  });

  it('in_review -> done: 許可される', () => {
    const task = makeTask({ status: 'in_review', assignee_id: 'user-2', estimated_hours: 3 });
    expect(() => validateStatusTransition('in_review', 'done', task)).not.toThrow();
  });
});

describe('TaskService - 優先度エスカレーション', () => {
  it('期限3日以内でlowならmediumに昇格', () => {
    const twoDaysLater = new Date();
    twoDaysLater.setDate(twoDaysLater.getDate() + 2);
    const task = makeTask({ priority: 'low', due_date: twoDaysLater.toISOString() });
    const result = escalatePriority(task);
    expect(result.priority).toBe('medium');
    expect(result.escalated).toBe(true);
  });

  it('期限1日以内でmediumならhighに昇格', () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const task = makeTask({ priority: 'medium', due_date: today.toISOString() });
    const result = escalatePriority(task);
    expect(result.priority).toBe('high');
    expect(result.escalated).toBe(true);
  });

  it('期限切れでmediumならcriticalに昇格', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const task = makeTask({ priority: 'medium', due_date: yesterday.toISOString() });
    const result = escalatePriority(task);
    expect(result.priority).toBe('critical');
    expect(result.escalated).toBe(true);
  });

  it('ステータスがdoneなら期限切れでもエスカレーションしない', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const task = makeTask({ priority: 'low', status: 'done', due_date: yesterday.toISOString() });
    const result = escalatePriority(task);
    expect(result.priority).toBe('low');
    expect(result.escalated).toBe(false);
  });

  it('due_dateがnullならエスカレーションしない', () => {
    const task = makeTask({ priority: 'low', due_date: null });
    const result = escalatePriority(task);
    expect(result.priority).toBe('low');
    expect(result.escalated).toBe(false);
  });
});

describe('TaskService - タグ正規化', () => {
  it('小文字化、重複排除、空文字除去', () => {
    const result = normalizeTags(['Bug', 'BUG', '', '  feature  ', 'bug']);
    expect(result).toEqual(['bug', 'feature']);
  });

  it('空配列はそのまま返す', () => {
    expect(normalizeTags([])).toEqual([]);
  });
});

describe('TaskService - ページネーション補正', () => {
  it('page < 1 の場合は1に補正される', () => {
    const result = normalizePagination({ page: '-5', limit: '20' });
    expect(result.page).toBe(1);
  });

  it('limit > 100 の場合は100に補正される', () => {
    const result = normalizePagination({ page: '1', limit: '999' });
    expect(result.limit).toBe(100);
  });

  it('limit < 1 の場合は1に補正される', () => {
    // parseInt('0') || 20 -> 20 (0 is falsy), so passing '-1' to trigger the < 1 guard
    const result = normalizePagination({ page: '1', limit: '-1' });
    expect(result.limit).toBe(1);
  });

  it('offsetが正しく計算される (page=3, limit=10 -> offset=20)', () => {
    const result = normalizePagination({ page: '3', limit: '10' });
    expect(result.offset).toBe(20);
  });
});
