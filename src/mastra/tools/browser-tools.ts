import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MCPClient } from "@mastra/mcp";

import { envValue, projectRoot } from "../runtime-paths.js";
import { isUnapprovedAccessEnabled } from "../permission-state.js";
import { playwrightBrowserConfig } from "./browser-config.js";

const outputDir = resolve(projectRoot, ".seudaily", "browser");
mkdirSync(outputDir, { recursive: true });
const allowedTools = new Set(["playwright_browser_find", "playwright_browser_press_key", "playwright_browser_type", "playwright_browser_navigate", "playwright_browser_snapshot", "playwright_browser_click", "playwright_browser_select_option", "playwright_browser_tabs"]);
const approvalRequiredTools = new Set(["playwright_browser_click", "playwright_browser_press_key", "playwright_browser_select_option", "playwright_browser_type"]);
let clientPromise: Promise<MCPClient> | undefined;
let toolsPromise: Promise<Record<string, any>> | undefined;

async function loadBrowserTools() {
  const configPath = resolve(outputDir, "playwright-config.json");
  if (!clientPromise) writeFileSync(configPath, JSON.stringify(playwrightBrowserConfig(process.platform, envValue("SEUDAILY_BROWSER"))), "utf8");
  if (!clientPromise) clientPromise = Promise.resolve(new MCPClient({
    id: "seudaily-playwright", timeout: 60_000,
    servers: { playwright: {
      command: process.execPath,
      args: [resolve(projectRoot, "node_modules", "@playwright", "mcp", "cli.js"), "--config", configPath, "--headless", "--isolated", "--block-service-workers", "--codegen", "none", "--image-responses", "omit", "--snapshot-mode", "full", "--idle-timeout", "900000", "--output-dir", outputDir],
      inheritDefaultEnv: true, forwardInstructions: false, timeout: 60_000,
      requireToolApproval: ({ toolName }) => !isUnapprovedAccessEnabled() && approvalRequiredTools.has(toolName),
    } },
  }));
  if (!toolsPromise) toolsPromise = clientPromise.then(async (client) => {
    const discovery = await client.listToolsWithErrors({ perServerTimeoutMs: 30_000 });
    if (Object.keys(discovery.errors).length) console.warn("Playwright MCP tools unavailable:", discovery.errors);
    return Object.fromEntries(Object.entries(discovery.tools).filter(([name]) => allowedTools.has(name)));
  });
  return toolsPromise;
}

export async function getPlaywrightBrowserTools() { return loadBrowserTools(); }
export function isBrowserApprovalRequired(name: string) { return approvalRequiredTools.has(name.replace(/^playwright_/, "")) || approvalRequiredTools.has(name); }
