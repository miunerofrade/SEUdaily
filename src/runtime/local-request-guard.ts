import type { Context } from 'hono';

export const localOrigins = ['http://127.0.0.1:4173', 'http://localhost:4173', 'http://127.0.0.1:4111', 'http://localhost:4111'];
const localHosts = new Set(['127.0.0.1:4111', 'localhost:4111']);

export function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  return !!host && localHosts.has(host.toLowerCase()) && (origin === undefined || localOrigins.includes(origin));
}

export async function guardLocalRequests(context: Context, next: () => Promise<void>) {
  if (!isLocalRequest(context.req.header('host'), context.req.header('origin'))) {
    return context.json({ error: 'Only local SEUdaily requests are allowed.' }, 403);
  }
  await next();
}
