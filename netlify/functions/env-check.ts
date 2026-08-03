import { ok, type FnEvent } from './_lib/http.js';

/**
 * Diagnostic: reports which expected env vars are visible to the functions —
 * booleans only, never the values. Safe to expose; remove after deploy is green.
 */
export async function handler(_event: FnEvent) {
  const names = [
    'DATABASE_URL',
    'JWT_SECRET',
    'ANTHROPIC_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_ID',
    'STRIPE_WEBHOOK_SECRET',
    'SITE_URL',
  ];
  const present: Record<string, boolean> = {};
  for (const n of names) present[n] = typeof process.env[n] === 'string' && process.env[n] !== '';
  return ok({ present, node: process.version });
}
