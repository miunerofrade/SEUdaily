import { resolve } from 'node:path';
import { AgentStore } from '../agent/storage.js';
import { runtimeRoot } from './runtime-paths.js';
export const agentStore = new AgentStore(resolve(runtimeRoot, 'agent.db'), resolve(runtimeRoot, 'mastra', 'mastra.db'));
