import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Prisma } from '../../generated/prisma/client.js';
import {
  EmailTakenError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

const BCRYPT_COST = 12;
// Cost-12 hash of the empty string: compared against when the email is unknown so that
// path burns the same ~270 ms as a real one and cannot be timed apart. Hardcoded rather
// than hashed at import time to keep 270 ms of bcrypt off every process start.
const DUMMY_HASH = '$2b$12$ilnr4V5t.ziCiZfoEWuiDepNr28b9vBJRjUcCLdFXfGpXCft.OmKi';
const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RegisterInput = { email: string; password: string; name: string };
export type LoginInput = { email: string; password: string };
export type SignAccessToken = (userId: string) => string;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// The raw token only ever exists in the response; the row keeps its hash.
async function issueRefreshToken(userId: string, client: Prisma.TransactionClient = prisma) {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  await client.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return token;
}

export async function register(input: RegisterInput) {
  try {
    return await prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
      },
      select: { id: true, email: true, name: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new EmailTakenError();
    }
    throw err;
  }
}

export async function login(input: LoginInput, signAccessToken: SignAccessToken) {
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  const passwordMatches = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordMatches) {
    throw new InvalidCredentialsError();
  }

  return {
    accessToken: signAccessToken(user.id),
    refreshToken: await issueRefreshToken(user.id),
    user: { id: user.id, email: user.email, name: user.name },
  };
}

export async function refresh(token: string, signAccessToken: SignAccessToken) {
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!stored) throw new InvalidRefreshTokenError();

  // Revoking under the same conditions we validate makes rotation atomic: two
  // concurrent refreshes of one token cannot both succeed. Both statements share
  // one transaction so a failed issue cannot leave the client with no valid token.
  const refreshToken = await prisma.$transaction(async (tx) => {
    const revoked = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw new InvalidRefreshTokenError();

    return issueRefreshToken(stored.userId, tx);
  });

  return { accessToken: signAccessToken(stored.userId), refreshToken };
}

export async function logout(token: string) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAll(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
