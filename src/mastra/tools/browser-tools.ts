import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { MCPClient } from "@mastra/mcp";

import { projectRoot } from "../runtime-paths.js";

const outputDir = resolve(projectRoot, ".cvstream", "browser");
mkdirSync(outputDir, { recursive: true });

const allowedTools = new Set([
  "playwright_browser_find",
  "playwright_browser_press_key",
  "playwright_browser_type",
  "playwright_browser_navigate",
  "playwright_browser_snapshot",
  "playwright_browser_click",
  "playwright_browser_select_option",
  "playwright_browser_tabs",
]);

const approvalRequiredTools = new Set([
  "browser_click",
  "browser_press_key",
  "browser_select_option",
  "browser_type",
]);

export const playwrightMcpClient = new MCPClient({
  id: "cvstream-playwright",
  timeout: 60_000,
  servers: {
    playwright: {
      command: process.execPath,
      args: [
        resolve(projectRoot, "node_modules", "@playwright", "mcp", "cli.js"),
        "--headless",
        "--isolated",
        "--browser",
        "chrome",
        "--block-service-workers",
        "--codegen",
        "none",
        "--image-responses",
        "omit",
        "--snapshot-mode",
        "none",
        "--idle-timeout",
        "900000",
        "--output-dir",
        outputDir,
      ],
      inheritDefaultEnv: true,
      forwardInstructions: false,
      timeout: 60_000,
      requireToolApproval: ({ toolName }) => approvalRequiredTools.has(toolName),
    },
  },
});

const discovery = await playwrightMcpClient.listToolsWithErrors({ perServerTimeoutMs: 30_000 });

if (Object.keys(discovery.errors).length) {
  console.warn("Playwright MCP tools unavailable:", discovery.errors);
}

export const playwrightBrowserTools = Object.fromEntries(
  Object.entries(discovery.tools).filter(([name]) => allowedTools.has(name)),
);
