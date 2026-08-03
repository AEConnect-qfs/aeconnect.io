import { prisma } from './_lib/prisma.js';
import { stripe, STRIPE_PRICE_ID, siteUrl } from './_lib/stripe.js';
import { subscribeToCore, getUsage } from './_lib/billing.js';
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

  // Dev fallback — no Stripe keys: activate directly.
  if (!stripe || !STRIPE_PRICE_ID) {
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
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/app?checkout=success`,
      cancel_url: `${base}/app?checkout=cancel`,
      metadata: { userId },
    });
    return ok({ url: checkout.url });
  } catch (e: any) {
    return serverError('Stripe checkout failed: ' + (e?.message || 'unknown'));
  }
}
