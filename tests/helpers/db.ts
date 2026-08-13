import { prisma } from '../../src/lib/prisma.js';

export { prisma };

// CASCADE from these two roots reaches every other table in the schema.
export const truncateAll = () => prisma.$executeRawUnsafe('TRUNCATE users, organizations CASCADE');
