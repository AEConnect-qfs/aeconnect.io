import { prisma } from './_lib/prisma.js';
import { stripe } from './_lib/stripe.js';
import { subscribeToCore, getUsage } from './_lib/billing.js';
import { writeAudit } from './_lib/audit.js';
import { requireSession, isResponse, parseBody, requireMethod, ok, bad, forbidden, serverError, type FnEvent } from './_lib/http.js';

/**
 * Confirm a completed Stripe Checkout on return to /app. Retrieves the session
 * with the secret key, checks it belongs to the caller and is paid, then
 * activates Core. Does nothing when Stripe is not configured.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = await requireSession(event);
  if (isResponse(session)) return session;
  const userId = session.id;

  const { sessionId } = parseBody<{ sessionId?: string }>(event);
  if (!sessionId) return bad('sessionId is required');

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
    console.error('[checkout-confirm]', e instanceof Error ? e.message : e);
    return serverError('Checkout confirm failed');
  }
}
