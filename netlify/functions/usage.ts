import { getUsage } from './_lib/billing.js';
import { requireSession, isResponse, requireMethod, ok, serverError, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'GET');
  if (m) return m;
  const session = await requireSession(event);
  if (isResponse(session)) return session;
  try {
    return ok(await getUsage(session.id));
  } catch (e: any) {
    return serverError(e?.message || 'Failed to load usage');
  }
}
