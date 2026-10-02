import { Mastra } from "@mastra/core/mastra";

import { seuDailyAgent } from "./agents/course-agent.js";
import { appRoutes } from "./app-routes.js";
import { mastraAppStorage } from "./storage.js";
import { startFocusRuntime } from "./focus-runtime.js";
import { guardLocalRequests, localOrigins } from "./local-request-guard.js";

startFocusRuntime();

export const mastra = new Mastra({
  agents: { seuDailyAgent },
  storage: mastraAppStorage,
  server: {
    host: "127.0.0.1",
    // Interactive campus authorization can wait up to five minutes.
    timeout: 360_000,
    cors: { origin: localOrigins },
    middleware: guardLocalRequests,
    // Public custom routes skip Mastra global middleware, so guard them directly too.
    apiRoutes: appRoutes.map((route) => ({ ...route, middleware: guardLocalRequests })),
  },
});
