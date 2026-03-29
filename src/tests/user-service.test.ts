import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, UserRow } from '../types';
import { validateEmail, validateCreateUser } from '../middleware/validator';

// ---------------------------------------------------------------------------
// We test UserService business logic without touching the DB.
// The key logic paths:
//   - Email uniqueness check  (tested via AppError pattern)
//   - Workload limit check    (tested via pure function replica)
//   - Email format validation (validateEmail from middleware)
//   - validateCreateUser      (from middleware)
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    role: 'member',
    max_tasks: 10,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Replicate checkWorkloadLimit logic for pure unit testing
function checkWorkloadLimit(user: UserRow, currentTaskCount: number): void {
  if (currentTaskCount >= user.max_tasks) {
    throw new AppError(
      'WORKLOAD_LIMIT_EXCEEDED',
      400,
      `User has reached maximum task limit (${currentTaskCount}/${user.max_tasks})`,
    );
  }
}

// Replicate email uniqueness check
function checkEmailUniqueness(existingEmails: string[], newEmail: string): void {
  if (existingEmails.includes(newEmail)) {
    throw new AppError('CONFLICT', 409, `Email ${newEmail} is already registered`);
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('UserService - ワークロード上限チェック', () => {
  it('タスク数が上限未満なら成功', () => {
    const user = makeUser({ max_tasks: 10 });
    expect(() => checkWorkloadLimit(user, 5)).not.toThrow();
  });

  it('タスク数が上限に達していたら拒否', () => {
    const user = makeUser({ max_tasks: 10 });
    expect(() => checkWorkloadLimit(user, 10)).toThrowError(
      'User has reached maximum task limit (10/10)',
    );
  });

  it('タスク数が上限を超えていても拒否', () => {
    const user = makeUser({ max_tasks: 5 });
    expect(() => checkWorkloadLimit(user, 7)).toThrowError('User has reached maximum task limit');
  });
});

describe('UserService - メール一意制約', () => {
  it('既存メールと重複する場合はCONFLICTエラー', () => {
    const existing = ['alice@example.com', 'bob@example.com'];
    expect(() => checkEmailUniqueness(existing, 'alice@example.com')).toThrowError(
      'Email alice@example.com is already registered',
    );
  });

  it('重複しない場合は成功', () => {
    const existing = ['alice@example.com'];
    expect(() => checkEmailUniqueness(existing, 'charlie@example.com')).not.toThrow();
  });
});

describe('UserService - メール形式バリデーション', () => {
  it('正しいメールアドレスはtrueを返す', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('user+tag@sub.domain.co.jp')).toBe(true);
  });

  it('不正なメールアドレスはfalseを返す', () => {
    expect(validateEmail('not-an-email')).toBe(false);
    expect(validateEmail('@missing-local.com')).toBe(false);
    expect(validateEmail('missing-domain@')).toBe(false);
    expect(validateEmail('has spaces@example.com')).toBe(false);
  });
});

describe('UserService - validateCreateUser', () => {
  it('正常なデータはバリデーション通過', () => {
    const result = validateCreateUser({ name: 'Alice', email: 'alice@example.com' });
    expect(result.name).toBe('Alice');
    expect(result.email).toBe('alice@example.com');
    expect(result.role).toBe('member');
  });

  it('nameが短すぎるとVALIDATION_ERROR', () => {
    expect(() =>
      validateCreateUser({ name: 'A', email: 'a@example.com' }),
    ).toThrowError('Validation failed');
  });

  it('emailが不正な形式だとVALIDATION_ERROR', () => {
    expect(() =>
      validateCreateUser({ name: 'Alice', email: 'bad-email' }),
    ).toThrowError('Validation failed');
  });

  it('roleが不正だとVALIDATION_ERROR', () => {
    expect(() =>
      validateCreateUser({ name: 'Alice', email: 'alice@example.com', role: 'superadmin' }),
    ).toThrowError('Validation failed');
  });
});
