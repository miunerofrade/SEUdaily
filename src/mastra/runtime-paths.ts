import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: resolve(process.env.CVSTREAM_PROJECT_ROOT?.trim() || process.cwd(), ".env"),
});

const markers = ["package.json", "pyproject.toml"];

function hasProjectMarkers(directory: string): boolean {
  return markers.every((marker) => existsSync(resolve(directory, marker)));
}

function discoverProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (hasProjectMarkers(current)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Unable to locate the SEUdaily project root from ${start}. Set CVSTREAM_PROJECT_ROOT.`,
      );
    }
    current = parent;
  }
}

const configuredRoot = process.env.CVSTREAM_PROJECT_ROOT?.trim();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const projectRoot = configuredRoot
  ? resolve(configuredRoot)
  : discoverProjectRoot(moduleDirectory);

if (!hasProjectMarkers(projectRoot)) {
  throw new Error(
    `CVSTREAM_PROJECT_ROOT does not point to a SEUdaily project: ${projectRoot}`,
  );
}

export const runtimeRoot = resolve(projectRoot, ".cvstream");
export const mastraRuntimeRoot = resolve(runtimeRoot, "mastra");
export const taskRuntimeRoot = resolve(runtimeRoot, "tasks");
export const sandboxWorkspaceRoot = resolve(runtimeRoot, "sandbox-workspace");

mkdirSync(mastraRuntimeRoot, { recursive: true });
mkdirSync(taskRuntimeRoot, { recursive: true });
mkdirSync(sandboxWorkspaceRoot, { recursive: true });

export function toLibSqlFileUrl(path: string): string {
  return `file:${resolve(path).replaceAll("\\", "/")}`;
}
