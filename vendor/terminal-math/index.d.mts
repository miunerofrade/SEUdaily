export interface MathNode { type: string; [key: string]: unknown }
export interface Box { width: number; height: number; baseline: number }
export function parseMath(input: string): MathNode;
export function renderNode(node: MathNode, options: {display?: boolean; unicode?: boolean; ansi?: boolean; compactScripts?: boolean}): Box;
export function boxToString(box: Box, options?: {ansi?: boolean; trim?: boolean}): string;
export function glyphFor(name: string): {unicode: string; ascii: string} | undefined;
