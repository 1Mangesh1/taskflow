import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationFields, toPage } from '../../lib/pagination.js';
import * as controller from './controller.js';

const orgParams = z.object({ orgId: z.uuid() });
const projectParams = orgParams.extend({ projectId: z.uuid() });
const taskParams = projectParams.extend({ taskId: z.uuid() });

// Trimmed before the length check, so a whitespace-only title is too short rather than
// a task that renders blank in every list.
const title = z.string().trim().min(1).max(200);
const description = z.string().max(5000);
const status = z.enum(['todo', 'in_progress', 'review', 'done']);
const priority = z.enum(['low', 'medium', 'high', 'urgent']);
// Offsets are accepted because due_date is a timestamptz: the client may say when it
// means in its own zone, and the column stores the instant either way.
const dueDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

// Multi-value filters take one comma-separated value (?status=todo,review); a repeated
// key is rejected rather than quietly supported as a second convention.
const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((raw) => raw.split(','))
    .pipe(z.array(item));

// Filters and the page arrive in the same querystring, so the shared pagination fields
// are extended rather than parsed separately: one validation path, one set of bounds.
export const taskListQuery = paginationFields
  .extend({
    status: csv(status).optional(),
    priority: csv(priority).optional(),
    assigneeId: z.uuid().optional(),
    dueFrom: dueDate.optional(),
    dueTo: dueDate.optional(),
  })
  .transform(({ page, limit, ...filters }) => ({ ...toPage({ page, limit }), filters }));

const searchQuery = paginationFields
  .extend({ q: z.string().trim().min(1) })
  .transform(({ page, limit, q }) => ({ ...toPage({ page, limit }), q }));

const taskResponse = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status,
  priority,
  dueDate: z.date().nullable(),
  createdBy: z.uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const taskPage = z.object({
  data: z.array(taskResponse),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});
const taskDetailResponse = taskResponse.extend({
  assignees: z.array(z.object({ userId: z.uuid(), email: z.email(), name: z.string() })),
  commentCount: z.number(),
});

export const assigneeBody = z.object({ userId: z.uuid() });
const assignmentResponse = z.object({
  taskId: z.uuid(),
  userId: z.uuid(),
  assignedBy: z.uuid(),
  createdAt: z.date(),
  // The id of the notification job, for GET /api/jobs/:id. Null when the enqueue failed:
  // the assignment itself is committed either way.
  jobId: z.string().nullable(),
});

// Both plugins are registered inside the org-scoped plugin in ../orgs/routes.ts, whose
// preHandler hook resolves request.org from the caller's own membership: no route here
// can be reached without that check, and none of them ever reads an org id from the
// request.
export const projectTaskRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Create a task in a project',
        errors: [400, 401, 403, 404],
        params: projectParams,
        body: z.object({
          title,
          description: description.optional(),
          status: status.optional(),
          priority: priority.optional(),
          dueDate: dueDate.optional(),
        }),
        response: { 201: taskResponse },
      },
    },
    controller.create,
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['tasks'],
        summary: 'List the tasks of a project, filtered and paginated',
        errors: [400, 401, 403, 404],
        params: projectParams,
        querystring: taskListQuery,
        response: { 200: taskPage },
      },
    },
    controller.list,
  );

  app.get(
    '/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Get a task with its assignees and comment count',
        errors: [400, 401, 403, 404],
        params: taskParams,
        response: { 200: taskDetailResponse },
      },
    },
    controller.get,
  );

  app.patch(
    '/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Update a task',
        errors: [400, 401, 403, 404],
        params: taskParams,
        body: z
          .object({
            title: title.optional(),
            description: description.nullable().optional(),
            status: status.optional(),
            priority: priority.optional(),
            // An explicit null clears the due date; leaving the key out leaves the date
            // alone, which is the only way to tell "no change" from "no due date".
            dueDate: dueDate.nullable().optional(),
          })
          .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update'),
        response: { 200: taskResponse },
      },
    },
    controller.update,
  );

  app.delete(
    '/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Delete a task',
        errors: [400, 401, 403, 404],
        params: taskParams,
      },
    },
    controller.remove,
  );

  app.post(
    '/:taskId/assignees',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Assign an organization member to a task and queue their notification email',
        errors: [400, 401, 403, 404, 409],
        params: taskParams,
        body: assigneeBody,
        response: { 201: assignmentResponse },
      },
    },
    controller.assign,
  );

  app.delete(
    '/:taskId/assignees/:userId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Unassign a member from a task',
        errors: [400, 401, 403, 404],
        params: taskParams.extend({ userId: z.uuid() }),
      },
    },
    controller.unassign,
  );
};

export const orgTaskRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/bulk-status',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Set the status of up to 100 tasks of the organization at once',
        errors: [400, 401, 403],
        params: orgParams,
        body: z.object({ taskIds: z.array(z.uuid()).min(1).max(100), status }),
        response: { 200: z.object({ updated: z.number() }) },
      },
    },
    controller.bulkStatus,
  );

  app.get(
    '/search',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Full-text search the tasks of the organization by title and description',
        errors: [400, 401, 403],
        params: orgParams,
        querystring: searchQuery,
        response: { 200: taskPage },
      },
    },
    controller.search,
  );
};
