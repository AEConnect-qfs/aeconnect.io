/** Public origin for links we email or hand to Stripe. SITE_URL wins when set. */
export function siteUrl(event: { headers: Record<string, string | undefined> }): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = event.headers['host'] || event.headers['Host'] || 'localhost:8787';
  const forwarded = event.headers['x-forwarded-proto'];
  const local = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  const proto = forwarded || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}
