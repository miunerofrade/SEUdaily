import type { Context } from 'hono';

const port = Number(process.env.SEUDAILY_PORT ?? 4111);
export const localOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(!process.env.SEUDAILY_INSTALL_ROOT ? ['http://127.0.0.1:4173', 'http://localhost:4173'] : [])];
const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

export function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  return !!host && localHosts.has(host.toLowerCase()) && (origin === undefined || localOrigins.includes(origin));
}

export async function guardLocalRequests(context: Context, next: () => Promise<void>) {
  if (!isLocalRequest(context.req.header('host'), context.req.header('origin'))) {
    return context.json({ error: 'Only local SEUdaily requests are allowed.' }, 403);
  }
  await next();
}
