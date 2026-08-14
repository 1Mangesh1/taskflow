import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';
import * as controller from './controller.js';

const orgParams = z.object({ orgId: z.uuid() });
const projectParams = orgParams.extend({ projectId: z.uuid() });
const name = z.string().min(1).max(200);
const description = z.string().max(2000);
const projectResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const taskCounts = z.object({
  todo: z.number(),
  in_progress: z.number(),
  review: z.number(),
  done: z.number(),
});

// Registered inside the org-scoped plugin in ../orgs/routes.ts, whose preHandler hook
// resolves request.org from the caller's own membership: no route here can be reached
// without that check, and none of them ever reads an org id from the request.
export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/',
    {
      schema: {
        params: orgParams,
        body: z.object({ name, description: description.optional() }),
        response: { 201: projectResponse.omit({ updatedAt: true }) },
      },
    },
    controller.create,
  );

  app.get(
    '/',
    {
      schema: {
        params: orgParams,
        querystring: paginationQuery,
        response: {
          200: z.object({
            data: z.array(projectResponse),
            total: z.number(),
            page: z.number(),
            limit: z.number(),
          }),
        },
      },
    },
    controller.list,
  );

  app.get(
    '/:projectId',
    { schema: { params: projectParams, response: { 200: projectResponse } } },
    controller.get,
  );

  app.patch(
    '/:projectId',
    {
      schema: {
        params: projectParams,
        body: z
          .object({ name: name.optional(), description: description.optional() })
          .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update'),
        response: { 200: projectResponse },
      },
    },
    controller.update,
  );

  app.delete(
    '/:projectId',
    { preHandler: app.requireOrgAdmin, schema: { params: projectParams } },
    controller.remove,
  );

  app.get(
    '/:projectId/dashboard',
    {
      schema: {
        params: projectParams,
        response: {
          200: z.object({ projectId: z.uuid(), counts: taskCounts, total: z.number() }),
        },
      },
    },
    controller.dashboard,
  );
};
