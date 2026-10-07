import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { projectRoot } from "./runtime-paths.js";

export function parseEnv(content: string) {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function readEnvFile() {
  try {
    return await readFile(resolve(projectRoot, ".env"), "utf8");
  } catch {
    return "";
  }
}

function encodeEnvValue(value: string) {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}

let envWriteQueue: Promise<void> = Promise.resolve();

async function persistEnvFile(updates: Record<string, string>) {
  const target = resolve(projectRoot, ".env");
  let content = await readEnvFile();
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${encodeEnvValue(value)}`;
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, () => line) : `${content.trimEnd()}${content.trim() ? "\n" : ""}${line}\n`;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function updateEnvFile(updates: Record<string, string>) {
  const operation = envWriteQueue.then(() => persistEnvFile(updates));
  envWriteQueue = operation.catch(() => undefined);
  return operation;
}

