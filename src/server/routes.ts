import type { Context } from 'hono';
export function registerApiRoute(path: string, options: {
    method: string;
    requiresAuth?: boolean;
    handler: (context: Context) => Response | Promise<Response>;
}) {
    return { path, ...options };
}
