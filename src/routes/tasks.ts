import { Router, Request, Response, NextFunction } from 'express';
import { taskService } from '../services/task-service';
import { validateCreateTask, validateUpdateTask, normalizePagination } from '../middleware/validator';
import { AppError } from '../types';

const router = Router();

// POST /api/tasks/bulk-update (must be before /:id routes)
router.post('/bulk-update', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task_ids, updates } = req.body;
    if (!Array.isArray(task_ids) || !updates) {
      throw new AppError('VALIDATION_ERROR', 400, 'task_ids (array) and updates (object) are required');
    }
    const result = taskService.bulkUpdate(task_ids, updates);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = validateCreateTask(req.body);
    const task = taskService.createTask(data);
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, offset } = normalizePagination(req.query as Record<string, unknown>);
    const result = taskService.getTasks({
      status: req.query.status as string | undefined,
      priority: req.query.priority as string | undefined,
      assignee_id: req.query.assignee_id as string | undefined,
      tag: req.query.tag as string | undefined,
      overdue: req.query.overdue as string | undefined,
      sort: req.query.sort as string | undefined,
      order: req.query.order as string | undefined,
      page,
      limit,
      offset,
    });
    res.json({ tasks: result.tasks, total: result.total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id
router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = taskService.getTaskById(req.params.id as string);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const updates = validateUpdateTask(req.body);
    const task = taskService.updateTask(req.params.id as string, updates);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    taskService.deleteTask(req.params.id as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/assign
router.post('/:id/assign', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { assignee_id } = req.body;
    if (!assignee_id) {
      throw new AppError('VALIDATION_ERROR', 400, 'assignee_id is required');
    }
    const task = taskService.assignTask(req.params.id as string, assignee_id);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/unassign
router.post('/:id/unassign', (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = taskService.unassignTask(req.params.id as string);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

export default router;
