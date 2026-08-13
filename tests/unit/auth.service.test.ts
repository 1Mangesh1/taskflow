import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { beforeEach, expect, test } from 'vitest';
import * as authService from '../../src/modules/auth/service.js';
import { prisma, truncateAll } from '../helpers/db.js';

const credentials = { email: 'nora.ellis@acme-corp.example', password: 'Password123!' };
const signAccessToken = (userId: string) => `access-token-for-${userId}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const registerAndLogin = async () => {
  await authService.register({ ...credentials, name: 'Nora Ellis' });
  return authService.login(credentials, signAccessToken);
};

beforeEach(truncateAll);

test('register hashes the password with bcrypt cost 12', async () => {
  const user = await authService.register({ ...credentials, name: 'Nora Ellis' });

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(bcrypt.getRounds(stored.passwordHash)).toBe(12);
  expect(await bcrypt.compare('Password123!', stored.passwordHash)).toBe(true);
  expect(await bcrypt.compare('Password123', stored.passwordHash)).toBe(false);
});

test('login on an unknown email still pays the bcrypt compare cost', async () => {
  const started = performance.now();

  await expect(
    authService.login({ ...credentials, email: 'ghost.harper@acme-corp.example' }, signAccessToken),
  ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

  // Cost 12 measures ~270 ms here; short-circuiting before the compare returns in single digits,
  // which is the enumeration oracle this guards against.
  expect(performance.now() - started).toBeGreaterThan(100);
});

test('refresh revokes the presented token and issues a different one', async () => {
  const { refreshToken } = await registerAndLogin();

  const rotated = await authService.refresh(refreshToken, signAccessToken);

  expect(rotated.refreshToken).not.toBe(refreshToken);
  const presented = await prisma.refreshToken.findUniqueOrThrow({
    where: { tokenHash: sha256(refreshToken) },
  });
  expect(presented.revokedAt).not.toBeNull();
  const issued = await prisma.refreshToken.findUniqueOrThrow({
    where: { tokenHash: sha256(rotated.refreshToken) },
  });
  expect(issued.revokedAt).toBeNull();
});

test('refresh rejects an expired token', async () => {
  const { user } = await registerAndLogin();
  const expired = randomBytes(32).toString('hex');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(expired),
      expiresAt: new Date(Date.now() - 1000),
    },
  });

  await expect(authService.refresh(expired, signAccessToken)).rejects.toMatchObject({
    code: 'INVALID_REFRESH_TOKEN',
  });
});

test('refresh rejects an already revoked token', async () => {
  const { refreshToken } = await registerAndLogin();
  await authService.refresh(refreshToken, signAccessToken);

  await expect(authService.refresh(refreshToken, signAccessToken)).rejects.toMatchObject({
    code: 'INVALID_REFRESH_TOKEN',
  });
});
