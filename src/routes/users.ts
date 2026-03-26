import { Router, Request, Response, NextFunction } from 'express';
import { userService } from '../services/user-service';
import { validateCreateUser, normalizePagination } from '../middleware/validator';

const router = Router();

// POST /api/users
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = validateCreateUser(req.body);
    const user = userService.createUser(data.name, data.email, data.role);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

// GET /api/users
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, offset } = normalizePagination(req.query as Record<string, unknown>);
    const role = req.query.role as string | undefined;
    const result = userService.getUsers({ role, page, limit, offset });
    res.json({ users: result.users, total: result.total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = userService.getUserById(req.params.id as string);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

export default router;
