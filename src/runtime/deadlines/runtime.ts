import { resolve } from 'node:path';
import { runtimeRoot } from '../runtime-paths.js';
import { DeadlineStore } from './store.js';
import { sendFeishu } from './feishu.js';
export const deadlineStore = new DeadlineStore(resolve(runtimeRoot, 'deadlines.db'));
let timer: NodeJS.Timeout | undefined, active: Promise<void> | undefined, stopped = false;
export function startDeadlines() { stopped = false; const tick = () => { if (!stopped && !active)
    active = deadlineStore.tick(process.env.SEUDAILY_FEISHU_WEBHOOK ? sendFeishu : undefined).catch(() => { console.error('DDL 提醒检查失败，将在下一次检查重试'); }).finally(() => { active = undefined; }); }; tick(); timer = setInterval(tick, 15000); timer.unref(); }
export async function stopDeadlines() { stopped = true; clearInterval(timer); await active; await deadlineStore.close(); }
