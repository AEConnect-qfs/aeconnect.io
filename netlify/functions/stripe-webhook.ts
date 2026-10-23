import type Stripe from 'stripe';
import { prisma } from './_lib/prisma.js';
import { stripe, STRIPE_WEBHOOK_SECRET } from './_lib/stripe.js';
import { writeAudit } from './_lib/audit.js';
import { requireMethod, ok, bad, serverError, unavailable, type FnEvent } from './_lib/http.js';

/**
 * Stripe webhook. Refuses every call unless both the Stripe client and
 * STRIPE_WEBHOOK_SECRET are configured, then verifies the signature against the
 * raw body before any plan change.
 */
export async function handler(event: FnEvent & { isBase64Encoded?: boolean }) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return unavailable('Stripe webhooks are not configured.', 'WEBHOOK_DISABLED');
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig) return bad('Missing Stripe signature');

  let evt: Stripe.Event;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch {
    console.error('[stripe-webhook] signature rejected');
    return bad('Invalid Stripe signature');
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
        break;
    }
  } catch (e) {
    console.error('[stripe-webhook] handler failed', e instanceof Error ? e.message : e);
    return serverError('Webhook handling failed');
  }

  return ok({ received: true });
}
