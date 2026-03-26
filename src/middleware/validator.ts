import { AppError, VALID_STATUSES, VALID_PRIORITIES, VALID_ROLES, TaskStatus, TaskPriority, UserRole } from '../types';

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validateCreateUser(body: Record<string, unknown>): { name: string; email: string; role: UserRole } {
  const errors: Record<string, string> = {};

  if (!body.name || typeof body.name !== 'string') {
    errors.name = 'Name is required';
  } else if (body.name.length < 2 || body.name.length > 50) {
    errors.name = 'Name must be between 2 and 50 characters';
  }

  if (!body.email || typeof body.email !== 'string') {
    errors.email = 'Email is required';
  } else if (!validateEmail(body.email)) {
    errors.email = 'Invalid email format';
  }

  const role = (body.role as string) || 'member';
  if (!VALID_ROLES.includes(role as UserRole)) {
    errors.role = `Role must be one of: ${VALID_ROLES.join(', ')}`;
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError('VALIDATION_ERROR', 400, 'Validation failed', errors);
  }

  return { name: body.name as string, email: body.email as string, role: role as UserRole };
}

export function validateCreateTask(body: Record<string, unknown>): {
  title: string;
  description?: string;
  priority: TaskPriority;
  assignee_id?: string;
  reporter_id: string;
  due_date?: string;
  estimated_hours?: number;
  tags?: string[];
} {
  const errors: Record<string, string> = {};

  if (!body.title || typeof body.title !== 'string') {
    errors.title = 'Title is required';
  } else if (body.title.length < 5 || body.title.length > 200) {
    errors.title = 'Title must be between 5 and 200 characters';
  }

  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      errors.description = 'Description must be a string';
    } else if (body.description.length > 2000) {
      errors.description = 'Description must be at most 2000 characters';
    }
  }

  const priority = (body.priority as string) || 'medium';
  if (!VALID_PRIORITIES.includes(priority as TaskPriority)) {
    errors.priority = `Priority must be one of: ${VALID_PRIORITIES.join(', ')}`;
  }

  if (!body.reporter_id || typeof body.reporter_id !== 'string') {
    errors.reporter_id = 'Reporter ID is required';
  }

  if (body.due_date !== undefined && body.due_date !== null) {
    if (typeof body.due_date !== 'string') {
      errors.due_date = 'Due date must be a string';
    } else {
      const dueDate = new Date(body.due_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (isNaN(dueDate.getTime())) {
        errors.due_date = 'Invalid date format';
      } else if (dueDate < today) {
        errors.due_date = 'Due date cannot be in the past';
      }
    }
  }

  if (body.estimated_hours !== undefined && body.estimated_hours !== null) {
    const hours = Number(body.estimated_hours);
    if (isNaN(hours) || hours < 0.5 || hours > 100.0) {
      errors.estimated_hours = 'Estimated hours must be between 0.5 and 100.0';
    }
  }

  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags)) {
      errors.tags = 'Tags must be an array';
    } else {
      if (body.tags.length > 10) {
        errors.tags = 'Maximum 10 tags allowed';
      }
      for (const tag of body.tags) {
        if (typeof tag !== 'string' || tag.length < 1 || tag.length > 30) {
          errors.tags = 'Each tag must be between 1 and 30 characters';
          break;
        }
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError('VALIDATION_ERROR', 400, 'Validation failed', errors);
  }

  return {
    title: body.title as string,
    description: body.description as string | undefined,
    priority: priority as TaskPriority,
    assignee_id: body.assignee_id as string | undefined,
    reporter_id: body.reporter_id as string,
    due_date: body.due_date as string | undefined,
    estimated_hours: body.estimated_hours !== undefined && body.estimated_hours !== null
      ? Number(body.estimated_hours) : undefined,
    tags: body.tags as string[] | undefined,
  };
}

export function validateUpdateTask(body: Record<string, unknown>): Record<string, unknown> {
  const errors: Record<string, string> = {};
  const updates: Record<string, unknown> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.length < 5 || body.title.length > 200) {
      errors.title = 'Title must be between 5 and 200 characters';
    } else {
      updates.title = body.title;
    }
  }

  if (body.description !== undefined) {
    if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 2000)) {
      errors.description = 'Description must be at most 2000 characters';
    } else {
      updates.description = body.description;
    }
  }

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status as TaskStatus)) {
      errors.status = `Status must be one of: ${VALID_STATUSES.join(', ')}`;
    } else {
      updates.status = body.status;
    }
  }

  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(body.priority as TaskPriority)) {
      errors.priority = `Priority must be one of: ${VALID_PRIORITIES.join(', ')}`;
    } else {
      updates.priority = body.priority;
    }
  }

  if (body.assignee_id !== undefined) {
    updates.assignee_id = body.assignee_id;
  }

  if (body.due_date !== undefined) {
    updates.due_date = body.due_date;
  }

  if (body.estimated_hours !== undefined) {
    if (body.estimated_hours !== null) {
      const hours = Number(body.estimated_hours);
      if (isNaN(hours) || hours < 0.5 || hours > 100.0) {
        errors.estimated_hours = 'Estimated hours must be between 0.5 and 100.0';
      } else {
        updates.estimated_hours = hours;
      }
    } else {
      updates.estimated_hours = null;
    }
  }

  if (body.tags !== undefined) {
    if (body.tags !== null && !Array.isArray(body.tags)) {
      errors.tags = 'Tags must be an array';
    } else if (Array.isArray(body.tags)) {
      if (body.tags.length > 10) {
        errors.tags = 'Maximum 10 tags allowed';
      }
      updates.tags = body.tags;
    } else {
      updates.tags = null;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError('VALIDATION_ERROR', 400, 'Validation failed', errors);
  }

  return updates;
}

export function normalizePagination(query: Record<string, unknown>): { page: number; limit: number; offset: number } {
  let page = parseInt(query.page as string, 10) || 1;
  let limit = parseInt(query.limit as string, 10) || 20;

  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(
    tags
      .map(t => t.toLowerCase().trim())
      .filter(t => t.length > 0)
  )];
}
