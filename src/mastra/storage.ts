import { resolve } from "node:path";

import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";

import { mastraRuntimeRoot, toLibSqlFileUrl } from "./runtime-paths.js";

export const mastraStorage = new LibSQLStore({
  id: "cvstream-local-storage",
  url: toLibSqlFileUrl(resolve(mastraRuntimeRoot, "mastra.db")),
  connectionTimeoutMs: 10_000,
});

// LibSQL persists application and memory domains. Its current observability
// domain does not implement Studio's feedback listing endpoint, so keep that
// UI-only domain in memory while all durable domains continue to use LibSQL.
const studioTransientStorage = new InMemoryStore({ id: "cvstream-studio-transient" });
export const mastraAppStorage = new MastraCompositeStore({
  id: "cvstream-app-storage",
  default: mastraStorage,
  domains: { observability: studioTransientStorage.stores.observability },
});

const deepSeekModel = {
  id: `deepseek/${process.env.DEEPSEEK_MODEL ?? "deepseek-flash"}` as `${string}/${string}`,
  url: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
};

const observationalMemoryEnabled =
  process.env.CVSTREAM_OBSERVATIONAL_MEMORY !== "false";

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ratioFromEnv(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

const contextWindowTokens = positiveIntegerFromEnv(
  "CVSTREAM_CONTEXT_WINDOW_TOKENS",
  512_000,
);
const compressionStartRatio = ratioFromEnv(
  "CVSTREAM_OBSERVATION_COMPRESSION_RATIO",
  0.8,
);
const lastMessages = positiveIntegerFromEnv("CVSTREAM_MEMORY_LAST_MESSAGES", 200);
const observationMessageTokens = positiveIntegerFromEnv(
  "CVSTREAM_OBSERVATION_MESSAGE_TOKENS",
  Math.floor(contextWindowTokens * compressionStartRatio),
);
const previousObserverTokens = positiveIntegerFromEnv(
  "CVSTREAM_PREVIOUS_OBSERVER_TOKENS",
  1_500,
);

export const courseAgentMemory = new Memory({
  storage: mastraStorage,
  options: {
    lastMessages,
    semanticRecall: false,
    generateTitle: false,
    observationalMemory: observationalMemoryEnabled
      ? {
          model: deepSeekModel,
          scope: "thread",
          observation: {
            messageTokens: observationMessageTokens,
            bufferTokens: false,
            previousObserverTokens,
          },
        }
      : false,
  },
});
