import jwt from 'jsonwebtoken';

/**
 * Minimal HTTP helpers shared by all functions. Netlify passes a lambda-style
 * `event` and expects `{ statusCode, headers, body }` back.
 */
export interface FnEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}
export interface FnResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function json(statusCode: number, data: unknown): FnResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(data) };
}
export const ok = (data: unknown) => json(200, data);
export const bad = (msg: string, code?: string) => json(400, { error: msg, code });
export const unauthorized = (msg = 'Unauthorized') => json(401, { error: msg });
export const forbidden = (msg = 'Forbidden') => json(403, { error: msg });
export const notFound = (msg = 'Not found') => json(404, { error: msg });
export const conflict = (msg: string, code?: string) => json(409, { error: msg, code });
export const paymentRequired = (data: object) => json(402, data);
export const serverError = (msg = 'Server error') => json(500, { error: msg });

export function parseBody<T = any>(event: FnEvent): T {
  if (!event.body) return {} as T;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return {} as T;
  }
}

export function requireMethod(event: FnEvent, ...methods: string[]): FnResult | null {
  if (!methods.includes(event.httpMethod)) {
    return json(405, { error: `Method ${event.httpMethod} not allowed` });
  }
  return null;
}

const SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me';

export interface Session {
  id: string;
  email: string;
}

export function signToken(session: Session): string {
  return jwt.sign(session, SECRET(), { expiresIn: '7d' });
}

/** Extract and verify the bearer token. Returns the session or null. */
export function getSession(event: FnEvent): Session | null {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(auth.slice(7), SECRET()) as Session;
  } catch {
    return null;
  }
}
