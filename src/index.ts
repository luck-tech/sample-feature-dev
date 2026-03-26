import express from 'express';
import { initializeSchema } from './db/schema';
import { errorHandler } from './middleware/error-handler';
import userRoutes from './routes/users';
import taskRoutes from './routes/tasks';
import statsRoutes from './routes/stats';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Initialize database
initializeSchema();

// Routes
app.use('/api/users', userRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/stats', statsRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Error handler (must be last)
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Task Management API server running on port ${PORT}`);
});

export default app;
