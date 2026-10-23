import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';

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
export const tooMany = (msg: string, code?: string) => json(429, { error: msg, code });
export const unavailable = (msg: string, code?: string) => json(503, { error: msg, code });
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
  /** User.sessionVersion at issue time. Tokens without it are rejected. */
  sv: number;
}

export function signToken(session: Session): string {
  return jwt.sign({ id: session.id, email: session.email, sv: session.sv }, SECRET(), { expiresIn: '7d' });
}

/** Verify the bearer token. Does not check that the session is still current. */
export function readSession(event: FnEvent): Session | null {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(auth.slice(7), SECRET()) as jwt.JwtPayload;
    if (typeof payload.id !== 'string' || typeof payload.email !== 'string' || typeof payload.sv !== 'number') {
      return null;
    }
    return { id: payload.id, email: payload.email, sv: payload.sv };
  } catch {
    return null;
  }
}

/** Bearer token whose sessionVersion still matches the user row. */
export async function requireSession(event: FnEvent): Promise<Session | FnResult> {
  const session = readSession(event);
  if (!session) return unauthorized();
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { sessionVersion: true },
  });
  if (!user || user.sessionVersion !== session.sv) return unauthorized();
  return session;
}

export function isResponse(value: Session | FnResult): value is FnResult {
  return 'statusCode' in value;
}
