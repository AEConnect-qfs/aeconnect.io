import { prisma } from './_lib/prisma.js';
import { stripe, siteUrl } from './_lib/stripe.js';
import { subscribeToCore, getUsage } from './_lib/billing.js';
import { PRICING } from './_lib/pricing.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, requireMethod, ok, unauthorized, serverError, notFound, type FnEvent } from './_lib/http.js';

/**
 * Start the trial → Core upgrade (spec §2/§5).
 *
 * With Stripe configured: creates a Checkout Session and returns its URL for the
 * browser to redirect to; the plan is activated by the webhook on success.
 *
 * Without Stripe keys (dev): activates the plan directly so the flow stays
 * testable, returning the fresh usage summary.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();
  const userId = session.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, plan: true, stripeCustomerId: true },
  });
  if (!user) return notFound('Account not found');
  if (user.plan === 'core') return ok({ alreadySubscribed: true, ...(await getUsage(userId)) });

  // Dev fallback — no Stripe key: activate directly.
  if (!stripe) {
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
      // Price defined inline from the locked PRICING config — no dashboard price id needed.
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          product_data: { name: 'AE Connect Core', description: 'AI case processing — 25 cases/month included, then $1/case' },
          unit_amount: PRICING.coreMonthlyCents,
          recurring: { interval: 'month' },
        },
      }],
      success_url: `${base}/app?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/app?checkout=cancel`,
      metadata: { userId },
    });
    return ok({ url: checkout.url });
  } catch (e: any) {
    return serverError('Stripe checkout failed: ' + (e?.message || 'unknown'));
  }
}
