export const reasoningEfforts = ['none','low','high','max'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export const effortLabels: Record<ReasoningEffort,string> = {none:'关闭',low:'低',high:'高',max:'最高'};
