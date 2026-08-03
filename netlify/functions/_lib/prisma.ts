import { PrismaClient } from '@prisma/client';

// Reuse a single client across warm function invocations.
const g = globalThis as unknown as { __prisma?: PrismaClient };
export const prisma =
  g.__prisma ?? new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
if (process.env.NODE_ENV !== 'production') g.__prisma = prisma;
