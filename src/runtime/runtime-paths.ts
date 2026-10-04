import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { config as loadDotenv } from "dotenv";

export function envValue(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value !== undefined) return value;
  const legacyName = name.startsWith("SEUDAILY_")
    ? `CVSTREAM_${name.slice("SEUDAILY_".length)}`
    : undefined;
  return (legacyName ? process.env[legacyName] : undefined) ?? fallback;
}

loadDotenv({ path: resolve(envValue("SEUDAILY_PROJECT_ROOT")?.trim() || process.cwd(), ".env") });

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
        `Unable to locate the SEUdaily project root from ${start}. Set SEUDAILY_PROJECT_ROOT.`,
      );
    }
    current = parent;
  }
}

const configuredRoot = envValue("SEUDAILY_PROJECT_ROOT")?.trim();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const projectRoot = configuredRoot
  ? resolve(configuredRoot)
  : discoverProjectRoot(moduleDirectory);

if (!envValue("SEUDAILY_INSTALL_ROOT") && !hasProjectMarkers(projectRoot)) {
  throw new Error(
    `SEUDAILY_PROJECT_ROOT does not point to a SEUdaily project: ${projectRoot}`,
  );
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function migrateLegacyRuntimeDirectory(): void {
  const legacyRoot = resolve(projectRoot, ".cvstream");
  const newRoot = resolve(projectRoot, ".seudaily");
  mkdirSync(newRoot, { recursive: true });
  if (!existsSync(legacyRoot)) return;
  const report: { moved: string[]; conflicts: Array<{ path: string; archive: string }>; errors: Array<{ path: string; error: string }>; skipped: string[] } = {
    moved: [], conflicts: [], errors: [], skipped: [],
  };
  if (lstatSync(legacyRoot).isSymbolicLink()) {
    report.skipped.push(".");
    writeFileSync(resolve(newRoot, ".migration-status.json"), JSON.stringify(report, null, 2), "utf8");
    throw new Error(`Legacy runtime path is a symlink; review it and retry startup: ${legacyRoot}`);
  }
  const visit = (directory: string, relative = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = resolve(directory, entry.name);
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      try {
        const stats = lstatSync(source);
        if (stats.isSymbolicLink()) { report.skipped.push(itemRelative); continue; }
        if (stats.isDirectory()) { visit(source, itemRelative); continue; }
        if (!stats.isFile()) { report.skipped.push(itemRelative); continue; }
        const destination = resolve(newRoot, itemRelative);
        mkdirSync(dirname(destination), { recursive: true });
        let committed = false;
        if (!existsSync(destination)) {
          try { linkSync(source, destination); unlinkSync(source); committed = true; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
              const temporary = `${destination}.migration-${process.pid}-${Date.now()}`;
              copyFileSync(source, temporary);
              try { linkSync(temporary, destination); unlinkSync(source); committed = true; }
              catch (retryError) { if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError; }
              finally { try { unlinkSync(temporary); } catch { /* removed or cleanup on retry */ } }
            }
          }
        }
        if (committed) {
          report.moved.push(itemRelative);
          continue;
        }
        const sourceHash = fileHash(source);
        if (existsSync(destination) && lstatSync(destination).isFile() && fileHash(destination) === sourceHash) {
          unlinkSync(source);
          report.moved.push(itemRelative);
          continue;
        }
        if (!existsSync(destination)) throw new Error("cannot atomically commit migrated file");
        const archiveDirectory = resolve(newRoot, ".migration-conflicts", "cvstream", dirname(itemRelative));
        mkdirSync(archiveDirectory, { recursive: true });
        let archive = resolve(archiveDirectory, entry.name);
        if (existsSync(archive) && (!lstatSync(archive).isFile() || fileHash(archive) !== sourceHash)) {
          archive = `${archive}.${sourceHash.slice(0, 12)}`;
          while (existsSync(archive) && (!lstatSync(archive).isFile() || fileHash(archive) !== sourceHash)) archive = `${archive}.1`;
        }
        if (!existsSync(archive)) {
          const temporary = `${archive}.migration-${process.pid}-${Date.now()}`;
          copyFileSync(source, temporary);
          try { linkSync(temporary, archive); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          finally { try { unlinkSync(temporary); } catch { /* cleanup on retry */ } }
        }
        unlinkSync(source);
        report.conflicts.push({ path: itemRelative, archive: archive.slice(newRoot.length + 1) });
      } catch (error) {
        report.errors.push({ path: itemRelative, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  visit(legacyRoot);
  const removeEmptyDirectories = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = resolve(directory, entry.name);
      removeEmptyDirectories(child);
      try { rmdirSync(child); } catch { /* retry on the next startup */ }
    }
  };
  removeEmptyDirectories(legacyRoot);
  try { rmdirSync(legacyRoot); } catch { /* remaining data is retried */ }
  const marker = resolve(newRoot, ".migration-cvstream-v1.json");
  if (!existsSync(legacyRoot) && report.errors.length === 0 && report.skipped.length === 0) {
    writeFileSync(marker, JSON.stringify(report, null, 2), "utf8");
    try { unlinkSync(resolve(newRoot, ".migration-status.json")); } catch { /* no previous incomplete run */ }
  } else {
    writeFileSync(resolve(newRoot, ".migration-status.json"), JSON.stringify(report, null, 2), "utf8");
    console.warn("SEUdaily legacy data migration incomplete; it will retry on next startup.", report);
    throw new Error(`Legacy runtime data migration incomplete; review ${resolve(newRoot, ".migration-status.json")} and retry startup.`);
  }
}

migrateLegacyRuntimeDirectory();

export const runtimeRoot = resolve(projectRoot, ".seudaily");
export const agentInstructionsPath = resolve(projectRoot, 'AGENT.md');
export const taskRuntimeRoot = resolve(runtimeRoot, "tasks");
export const sandboxWorkspaceRoot = resolve(runtimeRoot, "sandbox-workspace");

mkdirSync(taskRuntimeRoot, { recursive: true, mode: 0o700 });
mkdirSync(sandboxWorkspaceRoot, { recursive: true });
