import { join } from 'node:path';
import { runtimeRoot, envValue } from '../runtime-paths.js';
import { agentStore } from '../storage.js';
import { runPythonTool } from '../tools/python-bridge.js';
import { KnowledgeService } from './service.js';
export const knowledge = new KnowledgeService(agentStore.client,join(runtimeRoot,'knowledge'),runPythonTool,()=>({
  key:envValue('DASHSCOPE_API_KEY')?.trim() || '',
  model:envValue('SEUDAILY_EMBEDDING_MODEL')?.trim() || 'qwen3.7-text-embedding',
  baseUrl:envValue('SEUDAILY_EMBEDDING_BASE_URL')?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
}));
