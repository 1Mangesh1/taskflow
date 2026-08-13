import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildTestApp } from '../helpers/app.js';
import { truncateAll } from '../helpers/db.js';

const credentials = { email: 'nora.ellis@acme-corp.example', password: 'Password123!' };
const registerBody = { ...credentials, name: 'Nora Ellis' };

let app: FastifyInstance;

const register = () => app.inject({ method: 'POST', url: '/api/auth/register', body: registerBody });
const login = () => app.inject({ method: 'POST', url: '/api/auth/login', body: credentials });
const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: '/api/auth/refresh', body: { refreshToken } });

const decodePayload = (accessToken: string) =>
  JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

test('register then login then logout-all with the access token', async () => {
  const registered = await register();
  expect(registered.statusCode).toBe(201);
  expect(registered.json()).toEqual({
    user: { id: expect.any(String), email: credentials.email, name: 'Nora Ellis' },
  });

  const loggedIn = await login();
  expect(loggedIn.statusCode).toBe(200);
  const { accessToken, user } = loggedIn.json();
  expect(user).toEqual({ id: registered.json().user.id, email: credentials.email, name: 'Nora Ellis' });

  const payload = decodePayload(accessToken);
  expect(payload.sub).toBe(user.id);
  expect(payload.exp - payload.iat).toBe(900);
  expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);

  const loggedOut = await app.inject({
    method: 'POST',
    url: '/api/auth/logout-all',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(loggedOut.statusCode).toBe(204);
});

test('logout-all without an access token is unauthorized', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/logout-all' });

  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: expect.any(String), code: 'UNAUTHORIZED', details: {} });
});

test('a wrong password and an unknown email fail identically', async () => {
  await register();

  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { ...credentials, password: 'WrongPassword123!' },
  });
  const unknownEmail = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'ghost.harper@acme-corp.example', password: credentials.password },
  });

  expect(wrongPassword.statusCode).toBe(401);
  expect(wrongPassword.json()).toEqual({
    error: expect.any(String),
    code: 'INVALID_CREDENTIALS',
    details: {},
  });
  expect(unknownEmail.statusCode).toBe(401);
  expect(unknownEmail.json()).toEqual(wrongPassword.json());
});

test('registering a taken email conflicts', async () => {
  await register();

  const duplicate = await register();

  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toEqual({ error: expect.any(String), code: 'EMAIL_TAKEN', details: {} });
});

test('the same address in a different casing is the same account', async () => {
  const mixedCaseEmail = 'Nora.Ellis@Acme-Corp.example';

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    body: { ...registerBody, email: mixedCaseEmail },
  });
  expect(registered.statusCode).toBe(201);
  expect(registered.json().user.email).toBe(credentials.email);

  const duplicate = await register();
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toEqual({ error: expect.any(String), code: 'EMAIL_TAKEN', details: {} });

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { ...credentials, email: mixedCaseEmail },
  });
  expect(loggedIn.statusCode).toBe(200);
  expect(loggedIn.json().user.id).toBe(registered.json().user.id);
});

test('a rotated refresh token cannot be used twice', async () => {
  await register();
  const { refreshToken } = (await login()).json();

  const rotated = await refresh(refreshToken);
  expect(rotated.statusCode).toBe(200);
  expect(rotated.json().refreshToken).not.toBe(refreshToken);

  const replayed = await refresh(refreshToken);
  expect(replayed.statusCode).toBe(401);
  expect(replayed.json()).toEqual({
    error: expect.any(String),
    code: 'INVALID_REFRESH_TOKEN',
    details: {},
  });
});

test('concurrent refreshes of one token rotate it exactly once', async () => {
  await register();
  const { refreshToken } = (await login()).json();

  const responses = await Promise.all(Array.from({ length: 5 }, () => refresh(refreshToken)));

  const statusCodes = responses.map((res) => res.statusCode).sort((a, b) => a - b);
  expect(statusCodes).toEqual([200, 401, 401, 401, 401]);
  for (const rejected of responses.filter((res) => res.statusCode === 401)) {
    expect(rejected.json()).toEqual({
      error: expect.any(String),
      code: 'INVALID_REFRESH_TOKEN',
      details: {},
    });
  }
});

test('logout-all rejects every refresh token issued to the user', async () => {
  await register();
  const first = (await login()).json();
  const second = (await login()).json();

  const loggedOut = await app.inject({
    method: 'POST',
    url: '/api/auth/logout-all',
    headers: { authorization: `Bearer ${first.accessToken}` },
  });
  expect(loggedOut.statusCode).toBe(204);

  expect((await refresh(first.refreshToken)).statusCode).toBe(401);
  expect((await refresh(second.refreshToken)).statusCode).toBe(401);
});

test('logout revokes one token and is idempotent', async () => {
  await register();
  const { refreshToken } = (await login()).json();

  const first = await app.inject({ method: 'POST', url: '/api/auth/logout', body: { refreshToken } });
  const second = await app.inject({ method: 'POST', url: '/api/auth/logout', body: { refreshToken } });

  expect(first.statusCode).toBe(204);
  expect(second.statusCode).toBe(204);
  expect((await refresh(refreshToken)).statusCode).toBe(401);
});

test('an invalid body is rejected with field details', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    body: { email: 'not-an-email', password: 'short', name: 'Nora Ellis' },
  });

  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: {
      fieldErrors: {
        email: [expect.any(String)],
        password: [expect.any(String)],
      },
    },
  });
});

// bcrypt hashes at most 72 bytes; without an upper bound the rest is silently
// dropped and any suffix past byte 72 becomes part of no one's password.
test('a password longer than bcrypt reads is rejected, not truncated', async () => {
  const maxLength = 'A'.repeat(72);

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    body: { ...registerBody, password: `${maxLength}DIFFERENT-SUFFIX` },
  });
  expect(registered.statusCode).toBe(400);
  expect(registered.json().code).toBe('VALIDATION_ERROR');

  const truncatedLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { ...credentials, password: maxLength },
  });
  expect(truncatedLogin.statusCode).toBe(401);
  expect(truncatedLogin.json().code).toBe('INVALID_CREDENTIALS');

  const overLongLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { ...credentials, password: `${maxLength}DIFFERENT-SUFFIX` },
  });
  expect(overLongLogin.statusCode).toBe(400);
  expect(overLongLogin.json().code).toBe('VALIDATION_ERROR');

  expect((await register()).statusCode).toBe(201);
  expect((await login()).statusCode).toBe(200);
});

// The bound is bytes, not characters: 36 accented characters already spend 72 of them.
test('a multibyte password is bounded by bytes, not characters', async () => {
  const seventyTwoBytes = 'é'.repeat(36);

  const overLimit = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    body: { ...registerBody, password: `${seventyTwoBytes}X` },
  });
  expect(overLimit.statusCode).toBe(400);
  expect(overLimit.json().code).toBe('VALIDATION_ERROR');
  expect(overLimit.json().details.fieldErrors.password[0]).toMatch(/72 bytes/);

  const atLimit = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    body: { ...registerBody, password: seventyTwoBytes },
  });
  expect(atLimit.statusCode).toBe(201);

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { ...credentials, password: seventyTwoBytes },
  });
  expect(loggedIn.statusCode).toBe(200);
});

test('an empty json body is a client error, not a server error', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/logout-all',
    headers: { 'content-type': 'application/json' },
    payload: '',
  });

  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({
    error: expect.any(String),
    code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    details: {},
  });
});

test('an unknown route uses the same error envelope', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/nope' });

  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND', details: {} });
});

test('the eleventh auth request in a minute is rate limited', async () => {
  const responses = [];
  for (let i = 0; i < 11; i++) responses.push(await login());

  expect(responses.slice(0, 10).map((res) => res.statusCode)).toEqual(Array(10).fill(401));
  expect(responses[10].statusCode).toBe(429);
  expect(responses[10].json()).toEqual({
    error: expect.any(String),
    code: 'RATE_LIMIT_EXCEEDED',
    details: {},
  });
});

test('health is not rate limited by the auth limiter', async () => {
  for (let i = 0; i < 11; i++) await login();

  const health = await app.inject({ method: 'GET', url: '/health' });

  expect(health.statusCode).toBe(200);
});
