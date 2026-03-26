import { Router, Request, Response, NextFunction } from 'express';
import { statsService } from '../services/stats-service';

const router = Router();

// GET /api/stats/overview
router.get('/overview', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = statsService.getOverview();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/stats/users/:id
router.get('/users/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = statsService.getUserStats(req.params.id as string);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

export default router;
