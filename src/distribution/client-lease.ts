type Request = (path: string, method?: string, body?: unknown) => Promise<any>;
/** A server restart or an expired lease invalidates the old client ID. */
export async function clientLease(request: Request, verify: (identity: any) => void, kind: 'cli' | 'web') {
  let id = String((await request('/app/runtime/clients','POST',{interface:kind})).id);
  let closed = false, renewing: Promise<void> | undefined;
  let needsWeb = false;
  return {
    renew() {
      if (closed) return Promise.resolve();
      if (renewing) return renewing;
      const operation = (async () => {
        try { await request(`/app/runtime/clients/${id}`,'POST'); }
        catch (error) {
          if (closed) return;
          if ((error as {status?:number}).status !== 404) throw error;
          // Never register this interface with a replacement from another version/data directory.
          verify(await request('/api'));
          if (closed) return;
          const replacement = String((await request('/app/runtime/clients','POST',{interface:kind})).id);
          id = replacement;
          needsWeb = kind === 'web';
        }
        // Retry asset preparation if it failed after the lease itself was restored.
        if (needsWeb && !closed) {await request('/app/runtime/web','POST'); needsWeb = false;}
      })();
      renewing = operation.finally(() => {renewing = undefined;});
      return renewing;
    },
    async close() {
      closed = true;
      await renewing?.catch(() => {});
      await request(`/app/runtime/clients/${id}`,'DELETE').catch(() => {});
    },
  };
}
