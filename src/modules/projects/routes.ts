import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';
import * as controller from './controller.js';

const orgParams = z.object({ orgId: z.uuid() });
const projectParams = orgParams.extend({ projectId: z.uuid() });
// Trimmed before the length check, so a whitespace-only name is too short rather
// than a project that renders blank in every list.
const name = z.string().trim().min(1).max(200);
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
        tags: ['projects'],
        summary: 'Create a project',
        errors: [400, 401, 403],
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
        tags: ['projects'],
        summary: 'List the projects of an organization',
        errors: [400, 401, 403],
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
    {
      schema: {
        tags: ['projects'],
        summary: 'Get a project',
        errors: [400, 401, 403, 404],
        params: projectParams,
        response: { 200: projectResponse },
      },
    },
    controller.get,
  );

  app.patch(
    '/:projectId',
    {
      schema: {
        tags: ['projects'],
        summary: 'Update a project',
        errors: [400, 401, 403, 404],
        params: projectParams,
        body: z
          .object({ name: name.optional(), description: description.nullable().optional() })
          .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update'),
        response: { 200: projectResponse },
      },
    },
    controller.update,
  );

  app.delete(
    '/:projectId',
    {
      preHandler: app.requireOrgAdmin,
      schema: {
        tags: ['projects'],
        summary: 'Soft delete a project and its tasks',
        errors: [400, 401, 403, 404],
        params: projectParams,
      },
    },
    controller.remove,
  );

  app.get(
    '/:projectId/dashboard',
    {
      schema: {
        tags: ['projects'],
        summary: 'Count the tasks of a project by status',
        errors: [400, 401, 403, 404],
        params: projectParams,
        response: {
          200: z.object({ projectId: z.uuid(), counts: taskCounts, total: z.number() }),
        },
      },
    },
    controller.dashboard,
  );
};
