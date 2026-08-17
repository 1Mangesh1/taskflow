import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { orgRoutes } from './modules/orgs/routes.js';
import { registerAuth } from './plugins/auth.js';
import { registerDocs } from './plugins/docs.js';
import { registerOrgContext } from './plugins/org.js';

const uiPage = new URL('../public/index.html', import.meta.url);

export function buildApp() {
  const app = Fastify({ logger: config.NODE_ENV !== 'test' }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.httpStatus)
        .send({ error: error.message, code: error.code, details: error.details });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of error.validation) {
        // A root-level issue (an object-wide refine) has an empty path: key it to the
        // body rather than letting an empty string into the error contract.
        const field = issue.instancePath.slice(1) || 'body';
        (fieldErrors[field] ??= []).push(issue.message ?? issue.keyword);
      }
      return reply
        .status(400)
        .send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: { fieldErrors } });
    }

    // Fastify's own client errors (empty or malformed JSON body, unsupported
    // media type) carry a safe message and the status the client should see.
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'BAD_REQUEST';
      return reply.status(error.statusCode).send({ error: error.message, code, details: {} });
    }

    // Anything unexpected stays server-side: no stack traces or driver errors.
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: 'Internal server error', code: 'INTERNAL_ERROR', details: {} });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'Not found', code: 'NOT_FOUND', details: {} }),
  );

  registerAuth(app);
  registerOrgContext(app);
  // Before the routes: the document is built from an onRoute hook, which only sees
  // routes added after the plugin that installs it.
  if (config.DOCS_ENABLED) registerDocs(app);

  // Added from the boot queue rather than straight onto the instance, so it lands after
  // the docs plugin above and is documented like every other route.
  app.after(() => {
    app.get(
      '/health',
      {
        schema: {
          tags: ['health'],
          summary: 'Liveness probe',
          security: [],
          response: { 200: z.object({ status: z.literal('ok') }) },
        },
      },
      async () => ({ status: 'ok' }) as const,
    );

    // Served from this process so the console shares the API's origin: no CORS setup, and
    // no static-file dependency for one page.
    app.get('/ui', { schema: { hide: true } }, async (_request, reply) =>
      reply.type('text/html').send(readFileSync(uiPage)),
    );
  });

  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(orgRoutes, { prefix: '/api/orgs' });
  app.register(jobRoutes, { prefix: '/api/jobs' });

  return app;
}
