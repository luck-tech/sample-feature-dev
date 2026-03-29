import { Router, Request, Response, NextFunction } from 'express';
import { notificationService } from '../services/notification-service';
import { AppError, VALID_NOTIFICATION_PRIORITIES, VALID_NOTIFICATION_EVENT_TYPES } from '../types';
import { normalizePagination } from '../middleware/validator';

const router = Router();

// GET /api/notifications
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    const { page, limit, offset } = normalizePagination(req.query as Record<string, unknown>);

    // Validate priority filter if provided
    if (req.query.priority) {
      const priorities = (req.query.priority as string).split(',').map(p => p.trim());
      for (const p of priorities) {
        if (!VALID_NOTIFICATION_PRIORITIES.includes(p as never)) {
          throw new AppError('VALIDATION_ERROR', 400, `Invalid priority: ${p}. Must be one of: ${VALID_NOTIFICATION_PRIORITIES.join(', ')}`);
        }
      }
    }

    // Validate event_type filter if provided
    if (req.query.event_type) {
      const eventType = req.query.event_type as string;
      if (!VALID_NOTIFICATION_EVENT_TYPES.includes(eventType as never)) {
        throw new AppError('VALIDATION_ERROR', 400, `Invalid event_type: ${eventType}`);
      }
    }

    const result = notificationService.getNotifications({
      user_id: userId,
      is_read: req.query.is_read as string | undefined,
      priority: req.query.priority as string | undefined,
      event_type: req.query.event_type as string | undefined,
      task_id: req.query.task_id as string | undefined,
      sort: req.query.sort as string | undefined,
      order: req.query.order as string | undefined,
      page,
      limit,
      offset,
    });

    res.json({
      total: result.total,
      unread_count: result.unread_count,
      page,
      limit,
      notifications: result.notifications,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    const result = notificationService.getUnreadCount(userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/rules
router.get('/rules', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    const rules = notificationService.getRules(userId);
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, task_id, priority } = req.body;
    if (!user_id) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    if (priority && !VALID_NOTIFICATION_PRIORITIES.includes(priority)) {
      throw new AppError('VALIDATION_ERROR', 400, `Invalid priority: ${priority}`);
    }

    const updatedCount = notificationService.markAllAsRead(user_id, { task_id, priority });
    res.json({ updated_count: updatedCount });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    const result = notificationService.markAsRead(req.params.id as string, user_id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/rules/:id
router.delete('/rules/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    notificationService.deleteRule(req.params.id as string, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/:id
router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }

    notificationService.deleteNotification(req.params.id as string, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/rules
router.post('/rules', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, event_type, enabled } = req.body;

    if (!user_id) {
      throw new AppError('VALIDATION_ERROR', 400, 'user_id is required');
    }
    if (!event_type) {
      throw new AppError('VALIDATION_ERROR', 400, 'event_type is required');
    }
    if (typeof enabled !== 'boolean') {
      throw new AppError('VALIDATION_ERROR', 400, 'enabled must be a boolean');
    }

    const result = notificationService.createOrUpdateRule(user_id, event_type, enabled);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
