import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';
import * as controller from './controller.js';

const taskParams = z.object({ orgId: z.uuid(), projectId: z.uuid(), taskId: z.uuid() });
// Trimmed before the length check, so a whitespace-only comment is too short rather than
// an empty bubble in the thread.
export const commentBody = z.object({ body: z.string().trim().min(1).max(2000) });
const commentResponse = z.object({
  id: z.uuid(),
  body: z.string(),
  author: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: z.date(),
});

// Registered inside the org-scoped plugin in ../orgs/routes.ts, whose preHandler hook
// resolves request.org from the caller's own membership: no route here can be reached
// without that check, and none of them ever reads an org id from the request.
export const commentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/',
    {
      schema: {
        tags: ['comments'],
        summary: 'Comment on a task',
        errors: [400, 401, 403, 404],
        params: taskParams,
        body: commentBody,
        response: { 201: commentResponse },
      },
    },
    controller.create,
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['comments'],
        summary: 'List the comments on a task, oldest first',
        errors: [400, 401, 403, 404],
        params: taskParams,
        querystring: paginationQuery,
        response: {
          200: z.object({
            data: z.array(commentResponse),
            total: z.number(),
            page: z.number(),
            limit: z.number(),
          }),
        },
      },
    },
    controller.list,
  );

  app.delete(
    '/:commentId',
    {
      schema: {
        tags: ['comments'],
        summary: 'Delete a comment, which only its author may do',
        errors: [400, 401, 403, 404],
        params: taskParams.extend({ commentId: z.uuid() }),
      },
    },
    controller.remove,
  );
};
