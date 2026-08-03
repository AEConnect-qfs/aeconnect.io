import { subscribeToCore, getUsage } from './_lib/billing.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, requireMethod, ok, unauthorized, serverError, type FnEvent } from './_lib/http.js';

/**
 * Move the account from trial → Core (spec §5). Payment capture is stubbed
 * (TODO: Stripe); this flips billing state and starts metered/overage billing.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();
  try {
    await subscribeToCore(session.id);
    await writeAudit({ userId: session.id, action: 'SUBSCRIBED_CORE', detail: { plan: 'core' } });
    return ok({ success: true, ...(await getUsage(session.id)) });
  } catch (e: any) {
    return serverError(e?.message || 'Failed to subscribe');
  }
}
