import Fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { registerAuth } from './plugins/auth.js';

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
        const field = issue.instancePath.slice(1);
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

  app.get('/health', async () => ({ status: 'ok' }));
  app.register(authRoutes, { prefix: '/api/auth' });

  return app;
}
