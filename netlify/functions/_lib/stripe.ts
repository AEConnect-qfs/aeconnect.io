import Stripe from 'stripe';

/**
 * Stripe client. Payments are optional in dev: when STRIPE_SECRET_KEY is unset,
 * `stripe` is null and the checkout flow falls back to directly activating the
 * plan (so the trial→Core flow stays testable without Stripe keys).
 */
const key = process.env.STRIPE_SECRET_KEY;
export const stripe = key ? new Stripe(key) : null;
export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

/** Base URL for Checkout success/cancel redirects. */
export function siteUrl(event: { headers: Record<string, string | undefined> }): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'] || event.headers['Host'] || 'localhost:8787';
  return `${proto}://${host}`;
}
