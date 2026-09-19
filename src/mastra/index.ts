import { Mastra } from "@mastra/core/mastra";

import { seuDailyAgent } from "./agents/course-agent.js";
import { appRoutes } from "./app-routes.js";
import { mastraAppStorage } from "./storage.js";

export const mastra = new Mastra({
  agents: { seuDailyAgent },
  storage: mastraAppStorage,
  server: { apiRoutes: appRoutes },
});
