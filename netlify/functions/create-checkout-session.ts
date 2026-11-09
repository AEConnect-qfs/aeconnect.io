import { prisma } from './_lib/prisma.js';
import { stripe, siteUrl } from './_lib/stripe.js';
import { subscribeToCore, getUsage } from './_lib/billing.js';
import { PRICING } from './_lib/pricing.js';
import { writeAudit } from './_lib/audit.js';
import { requireSession, isResponse, requireMethod, ok, serverError, notFound, unavailable, type FnEvent } from './_lib/http.js';

/**
 * Start the trial → Core upgrade.
 *
 * With Stripe configured: creates a Checkout Session and returns its URL. The
 * plan is activated by the webhook (or checkout-confirm) after payment.
 *
 * Without Stripe: returns 503 unless ALLOW_DEV_SUBSCRIBE=true, which is off
 * by default and must never be set in production.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = await requireSession(event);
  if (isResponse(session)) return session;
  const userId = session.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, plan: true, stripeCustomerId: true },
  });
  if (!user) return notFound('Account not found');
  if (user.plan === 'core') return ok({ alreadySubscribed: true, ...(await getUsage(userId)) });

  if (!stripe) {
    if (process.env.ALLOW_DEV_SUBSCRIBE !== 'true') {
      return unavailable('Billing is not available.', 'BILLING_UNAVAILABLE');
    }
    await subscribeToCore(userId);
    await writeAudit({ userId, action: 'SUBSCRIBED_CORE', detail: { plan: 'core', via: 'dev-activate' } });
    return ok({ activated: true, ...(await getUsage(userId)) });
  }

  try {
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
      customerId = customer.id;
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    const base = siteUrl(event);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: userId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'AE Connect Core',
            description: '25 cases/month included. Extra cases are tracked and are not billed on this plan.',
          },
          unit_amount: PRICING.coreMonthlyCents,
          recurring: { interval: 'month' },
        },
      }],
      success_url: `${base}/app?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/app?checkout=cancel`,
      metadata: { userId },
    });
    return ok({ url: checkout.url });
  } catch (e) {
    console.error('[checkout] session create failed', e instanceof Error ? e.message : e);
    return serverError('Could not start checkout');
  }
}
