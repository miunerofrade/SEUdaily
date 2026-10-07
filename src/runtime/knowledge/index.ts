import { join } from 'node:path';
import {fileURLToPath} from 'node:url';
import { runtimeRoot, envValue } from '../runtime-paths.js';
import { agentStore } from '../storage.js';
import { runPythonTool } from '../tools/python-bridge.js';
import { KnowledgeService } from './service.js';
import {registerBundledKnowledge} from './builtin.js';
export const knowledge = new KnowledgeService(agentStore.client,join(runtimeRoot,'knowledge'),runPythonTool,()=>({
  key:envValue('DASHSCOPE_API_KEY')?.trim() || '',
  model:envValue('SEUDAILY_EMBEDDING_MODEL')?.trim() || 'qwen3.7-text-embedding',
  baseUrl:envValue('SEUDAILY_EMBEDDING_BASE_URL')?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
}));

export function loadBuiltinKnowledge() {
  const installRoot=envValue('SEUDAILY_INSTALL_ROOT');
  return registerBundledKnowledge(knowledge,installRoot ? join(installRoot,'docs','references') : fileURLToPath(new URL('../../../docs/references/',import.meta.url)));
}
