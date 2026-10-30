import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectFor, withResourceLocks, type Context } from '../context.js';
import { completeProjectPaths } from '../runtime/project-completions.js';

export function completionRoutes(app: FastifyInstance, context: Context) {
  app.get('/api/projects/:id/completions', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { query } = z.object({ query: z.string().max(4096).default('') }).parse(request.query);
    return withResourceLocks(context, [], async () => {
      const project = projectFor(context, id, request.user.id);
      return completeProjectPaths(context.workspaces, project, query);
    }, [`project:${id}`]);
  });
}
