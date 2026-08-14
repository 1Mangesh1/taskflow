import { expect, test } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

// The document is generated from the route schemas at boot: a schema the transform
// cannot turn into JSON Schema fails here rather than the first time someone opens /docs.
test('GET /docs/json serves the generated OpenAPI document', async () => {
  const app = await buildTestApp();

  const res = await app.inject({ method: 'GET', url: '/docs/json' });

  expect(res.statusCode).toBe(200);
  const doc = res.json<{
    openapi: string;
    components: { securitySchemes: Record<string, unknown> };
    paths: Record<string, Record<string, { summary: string; tags: string[] }>>;
  }>();
  expect(doc.openapi).toMatch(/^3\./);
  expect(doc.components.securitySchemes.bearerAuth).toEqual({
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  const createTask = doc.paths['/api/orgs/{orgId}/projects/{projectId}/tasks']?.post;
  expect(createTask?.tags).toEqual(['tasks']);
  expect(createTask?.summary).toBe('Create a task in a project');
});
