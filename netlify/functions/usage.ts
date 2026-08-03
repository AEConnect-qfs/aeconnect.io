import { getUsage } from './_lib/billing.js';
import { getSession, requireMethod, ok, unauthorized, serverError, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'GET');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();
  try {
    return ok(await getUsage(session.id));
  } catch (e: any) {
    return serverError(e?.message || 'Failed to load usage');
  }
}
