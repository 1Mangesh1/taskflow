import { readFileSync } from 'node:fs';
import swagger, { type SwaggerTransform } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { config } from '../config.js';

// The document version is the package version: one number to bump, and no second copy
// of it to forget.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Every handled failure answers with the same envelope, so the document defines it once
// and each route refers to it by the codes it can answer with.
const errorDescriptions = {
  400: 'The request failed validation, or names something the caller may not use',
  401: 'The access token is missing, expired, or invalid, or the credentials were rejected',
  403: 'The caller is not a member of the organization, or lacks the org_admin role',
  404: 'No such resource, or none this caller can see',
  409: 'The request conflicts with the current state of the resource',
  429: 'Too many auth requests from this IP',
  503: 'The job queue is unreachable',
} as const;

type ErrorStatus = keyof typeof errorDescriptions;

declare module 'fastify' {
  interface FastifySchema {
    // The failures a route documents. Listed per route rather than derived from the url,
    // because which errors a handler can raise is not something its path shape shows.
    errors?: readonly ErrorStatus[];
  }
}

const errorResponse = (status: ErrorStatus) => ({
  description: errorDescriptions[status],
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

// Every route that declares no success schema answers 204 with an empty body, which is
// worth saying: left alone, the generator documents a 200 the API never sends.
const noContent = { 204: { description: 'No content' } };

// Runs after the zod schemas have been turned into JSON Schema, and folds each route's
// declared error codes into the response map it produced.
const transform: SwaggerTransform = (input) => {
  const { schema, url } = jsonSchemaTransform(input);
  const { errors, ...documented } = schema;

  return {
    schema: {
      ...documented,
      response: {
        ...((documented.response as Record<string, unknown>) ?? noContent),
        ...Object.fromEntries((errors ?? []).map((status) => [status, errorResponse(status)])),
      },
    },
    // A plugin mounted at a prefix registers its '/' route under both '/prefix' and
    // '/prefix/'; document the form without the slash so the paths read like the route
    // table and try-it-out sends the canonical url.
    url: url.replace(/(.)\/$/, '$1'),
  };
};

export function registerDocs(app: FastifyInstance) {
  app.register(swagger, {
    openapi: {
      // 3.1, because that is the JSON Schema dialect the zod transform emits: a
      // nullable field is `type: [..., 'null']`, which a 3.0 document cannot express.
      openapi: '3.1.0',
      info: {
        title: 'TaskFlow API',
        description:
          'Multi-tenant task management. Every route outside /health and the auth routes ' +
          'carries a bearer access token, and every resource below an organization is ' +
          "reachable only by its members: the org id in the path is checked against the caller's " +
          'own membership row on each request, and role checks hang off that same row. Lists ' +
          'are paginated, tasks carry filters and full-text search, and assigning a user queues ' +
          'a notification email whose progress is readable through the jobs endpoint.',
        version,
      },
      servers: [{ url: `http://localhost:${config.PORT}`, description: 'Local development' }],
      tags: [
        { name: 'health', description: 'Liveness probe.' },
        { name: 'auth', description: 'Registration, login, refresh rotation, and logout.' },
        {
          name: 'organizations',
          description: 'Organizations and their members. Every other resource is scoped to one.',
        },
        { name: 'projects', description: 'Projects inside an organization.' },
        {
          name: 'tasks',
          description:
            'Tasks and their assignees, plus organization-wide bulk status updates and search.',
        },
        { name: 'comments', description: 'Comments on a task.' },
        { name: 'jobs', description: 'Status of the email jobs an assignment queues.' },
      ],
      components: {
        schemas: {
          Error: {
            type: 'object',
            required: ['error', 'code', 'details'],
            properties: {
              error: { type: 'string', description: 'Human-readable message' },
              code: { type: 'string', description: 'Stable machine-readable code' },
              details: {
                type: 'object',
                additionalProperties: true,
                description: 'Per-field messages when the failure was validation, otherwise empty',
              },
            },
          },
        },
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      // Applied to every operation, so a route is authenticated in the document unless it
      // opts out with `security: []`. A route added without a thought about auth is
      // documented as needing it, which is the safe direction to be wrong in.
      security: [{ bearerAuth: [] }],
    },
    transform,
  });

  // Serves the console at /docs and the raw document at /docs/json.
  app.register(swaggerUi, { routePrefix: '/docs' });
}
