import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { commentRoutes } from '../comments/routes.js';
import { projectRoutes } from '../projects/routes.js';
import { orgTaskRoutes, projectTaskRoutes } from '../tasks/routes.js';
import * as controller from './controller.js';

const orgRole = z.enum(['org_admin', 'member']);
// Validated before the org plugin runs, so a malformed id never reaches the uuid column.
const orgParams = z.object({ orgId: z.uuid() });
const memberParams = orgParams.extend({ userId: z.uuid() });
const orgResponse = z.object({ id: z.uuid(), name: z.string(), role: orgRole });
const memberResponse = z.object({
  userId: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: orgRole,
});

// Every route registered here is guarded by the membership hook below, which resolves
// request.org from the caller's own membership row. Org-scoped routes must be added
// inside this scope so membership can never be left unverified.
const orgScopedRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireOrgMember);

  app.get(
    '/members',
    {
      schema: {
        params: orgParams,
        response: {
          200: z.object({ data: z.array(memberResponse.extend({ joinedAt: z.date() })) }),
        },
      },
    },
    controller.listMembers,
  );

  app.post(
    '/members',
    {
      preHandler: app.requireOrgAdmin,
      schema: {
        params: orgParams,
        body: z.object({ email: z.email(), role: orgRole }),
        response: { 201: memberResponse },
      },
    },
    controller.addMember,
  );

  app.patch(
    '/members/:userId',
    {
      preHandler: app.requireOrgAdmin,
      schema: {
        params: memberParams,
        body: z.object({ role: orgRole }),
        response: { 200: z.object({ userId: z.uuid(), role: orgRole }) },
      },
    },
    controller.updateMemberRole,
  );

  app.delete(
    '/members/:userId',
    { preHandler: app.requireOrgAdmin, schema: { params: memberParams } },
    controller.removeMember,
  );

  // Child plugins inherit the membership hook above, so mounting a module here is what
  // makes its routes org-scoped.
  app.register(projectRoutes, { prefix: '/projects' });
  app.register(projectTaskRoutes, { prefix: '/projects/:projectId/tasks' });
  app.register(commentRoutes, { prefix: '/projects/:projectId/tasks/:taskId/comments' });
  // Bulk update and search span the whole org rather than one project.
  app.register(orgTaskRoutes, { prefix: '/tasks' });
};

export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: schema validation runs in between, and an anonymous
  // caller must get 401 rather than feedback on a malformed id.
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/',
    { schema: { body: z.object({ name: z.string().min(1) }), response: { 201: orgResponse } } },
    controller.create,
  );

  app.get(
    '/',
    { schema: { response: { 200: z.object({ data: z.array(orgResponse) }) } } },
    controller.list,
  );

  app.register(orgScopedRoutes, { prefix: '/:orgId' });
};
