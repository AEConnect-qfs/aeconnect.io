import type Stripe from 'stripe';
import { prisma } from './_lib/prisma.js';
import { stripe, STRIPE_WEBHOOK_SECRET } from './_lib/stripe.js';
import { writeAudit } from './_lib/audit.js';
import { requireMethod, ok, bad, json, type FnEvent } from './_lib/http.js';

/**
 * Stripe webhook (spec §2 — real billing state lives server-side). Verifies the
 * signature, then reconciles the account's plan with Stripe:
 *   checkout.session.completed / subscription active  → Core
 *   subscription deleted / unpaid                      → back to trial
 *
 * Signature verification requires the RAW request body. Netlify passes it as a
 * string on `event.body` (base64 when flagged), which is what we use here.
 */
export async function handler(event: FnEvent & { isBase64Encoded?: boolean }) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');

  let evt: Stripe.Event;
  if (stripe && STRIPE_WEBHOOK_SECRET) {
    const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    if (!sig) return bad('Missing Stripe signature');
    try {
      evt = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
    } catch (e: any) {
      return bad('Signature verification failed: ' + (e?.message || 'invalid'));
    }
  } else {
    // Dev only (no webhook secret configured): accept unverified JSON.
    try { evt = JSON.parse(raw); } catch { return bad('Invalid payload'); }
  }

  try {
    switch (evt.type) {
      case 'checkout.session.completed': {
        const s = evt.data.object as Stripe.Checkout.Session;
        const userId = s.client_reference_id || (s.metadata?.userId as string | undefined);
        if (userId) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              plan: 'core',
              subscribedAt: new Date(),
              subscriptionStatus: 'active',
              stripeCustomerId: (s.customer as string) || undefined,
              stripeSubscriptionId: (s.subscription as string) || undefined,
            },
          });
          await writeAudit({ userId, action: 'SUBSCRIBED_CORE', detail: { plan: 'core', via: 'stripe', subscription: s.subscription } });
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = evt.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({ where: { stripeCustomerId: sub.customer as string } });
        if (user) {
          const active = sub.status === 'active' || sub.status === 'trialing';
          await prisma.user.update({
            where: { id: user.id },
            data: { plan: active ? 'core' : 'trial', subscriptionStatus: sub.status, stripeSubscriptionId: sub.id },
          });
          await writeAudit({ userId: user.id, action: active ? 'SUBSCRIPTION_UPDATED' : 'SUBSCRIPTION_ENDED', detail: { status: sub.status } });
        }
        break;
      }
      default:
        break; // ignore other events
    }
  } catch (e: any) {
    return json(500, { error: 'Webhook handling failed: ' + (e?.message || 'unknown') });
  }

  return ok({ received: true });
}
