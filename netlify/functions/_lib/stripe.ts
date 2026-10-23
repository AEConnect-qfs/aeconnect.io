import Stripe from 'stripe';

/**
 * Stripe client. Null when STRIPE_SECRET_KEY is unset. Checkout does not grant
 * Core in that case unless ALLOW_DEV_SUBSCRIBE=true. The webhook fails closed
 * when this client or STRIPE_WEBHOOK_SECRET is missing.
 */
const key = process.env.STRIPE_SECRET_KEY;
export const stripe = key ? new Stripe(key) : null;
export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

export { siteUrl } from './site.js';
