import { prisma } from '../../src/lib/prisma.js';

export { prisma };

// CASCADE from these two roots reaches every other table in the schema.
export const truncateAll = () => prisma.$executeRawUnsafe('TRUNCATE users, organizations CASCADE');

// Cost-12 hash of "Password123!". Tests that are not about registration insert users
// directly: hashing costs ~270 ms per user and none of them log in with a password.
const PASSWORD_HASH = '$2b$12$8y3RNfKHrPdY6Nos2lvuA.GCBmiCsiGMuJqlO7I.sY4mHN6xcQI.6';

export const createUser = (email: string, name: string) =>
  prisma.user.create({
    data: { email, name, passwordHash: PASSWORD_HASH },
    select: { id: true, email: true, name: true },
  });
