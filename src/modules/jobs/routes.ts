import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as controller from './controller.js';

// Not org-scoped: a queue id belongs to the queue, not to a tenant. Authentication is
// the whole gate, and the response carries no tenant data beyond the job's own name.
export const jobRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            status: z.enum(['pending', 'active', 'completed', 'failed']),
            attemptsMade: z.number(),
            failedReason: z.string().optional(),
          }),
        },
      },
    },
    controller.get,
  );
};
