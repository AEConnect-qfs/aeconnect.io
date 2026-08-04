import { prisma } from './_lib/prisma.js';
import { stripe } from './_lib/stripe.js';
import { subscribeToCore, getUsage } from './_lib/billing.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, parseBody, requireMethod, ok, bad, unauthorized, forbidden, serverError, type FnEvent } from './_lib/http.js';

/**
 * Confirm a completed Stripe Checkout on return to /app (belt-and-suspenders with
 * the webhook, so activation works even without a webhook secret configured).
 * Retrieves the Checkout Session, verifies it belongs to the caller and is paid,
 * then activates Core.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();
  const userId = session.id;

  const { sessionId } = parseBody<{ sessionId?: string }>(event);
  if (!sessionId) return bad('sessionId is required');

  // Dev (no Stripe): nothing to confirm — the dev checkout already activated.
  if (!stripe) return ok(await getUsage(userId));

  try {
    const cs = await stripe.checkout.sessions.retrieve(sessionId);
    if (cs.client_reference_id !== userId) return forbidden('Checkout session does not belong to this account');

    const paid = cs.payment_status === 'paid' || cs.status === 'complete';
    if (paid) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
      if (user && user.plan !== 'core') {
        await prisma.user.update({
          where: { id: userId },
          data: {
            plan: 'core',
            subscribedAt: new Date(),
            subscriptionStatus: 'active',
            stripeCustomerId: (cs.customer as string) || undefined,
            stripeSubscriptionId: (cs.subscription as string) || undefined,
          },
        });
        await subscribeToCore(userId); // idempotent — ensures subscribedAt/plan set
        await writeAudit({ userId, action: 'SUBSCRIBED_CORE', detail: { via: 'checkout-confirm', session: sessionId } });
      }
    }
    return ok({ paid, ...(await getUsage(userId)) });
  } catch (e: any) {
    return serverError('Checkout confirm failed: ' + (e?.message || 'unknown'));
  }
}
