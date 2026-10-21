export type RunTiming = { startedAt?: number; elapsedMs: number; finishedAt?: number };
export function elapsedTime(timing: RunTiming, now = Date.now()) {
  return Math.max(0, timing.elapsedMs + (timing.startedAt === undefined ? 0 : now - timing.startedAt));
}
export function startTiming(timing?: RunTiming, now = Date.now()): RunTiming {
  return timing?.startedAt !== undefined ? timing : {elapsedMs:timing?.elapsedMs ?? 0,startedAt:now};
}
export function stopTiming(timing?: RunTiming, now = Date.now()): RunTiming | undefined {
  return timing?.startedAt !== undefined ? {elapsedMs:elapsedTime(timing,now),finishedAt:now} : timing;
}
export function durationLabel(ms: number) {
  const seconds = Math.floor(Math.max(0,ms) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
}
