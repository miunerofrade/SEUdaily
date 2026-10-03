import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeRoot } from './runtime-paths.js';
import type { TurnContext } from '../agent/types.js';

/** The saved Focus owns this grant; request-supplied resource/flags alone never do. */
export async function resolveFocusPermission(context: Pick<TurnContext, 'threadId' | 'resourceId'>, stateFile = join(runtimeRoot, 'focus.json')): Promise<boolean> {
    if (context.resourceId !== 'seudaily-focus-local') return false;
    try {
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        return Array.isArray(state.items) && state.items.some((item: any) =>
            (item.threadId || item.id) === context.threadId && (item.resourceId || 'seudaily-focus-local') === context.resourceId);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}
