import { Mastra } from "@mastra/core/mastra";

import { courseAgent } from "./agents/course-agent.js";

export const mastra = new Mastra({
  agents: { courseAgent },
});
