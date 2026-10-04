import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { commands } from "./session.js";

export function commandSuggestions(input: string, skills: string[]): string[] {
  if (!input.startsWith("/")) return [];
  if (!input.includes(" "))
    return [
      ...Object.keys(commands),
      ...skills,
      "chat",
      "课表",
      "培养方案",
      "技能",
      "exit",
    ]
      .map((name) => "/" + name)
      .filter((name) => name.startsWith(input));
  const match = input.match(/^(\/\S+)\s+(.*)$/s);
  if (!match) return [];
  const command =
    (
      { 课表: "schedule", 培养方案: "programs", 技能: "skills" } as Record<
        string,
        string
      >
    )[match[1].slice(1)] ?? match[1].slice(1);
  const options: Record<string, string[]> = {
    skill: [...skills, "off"],
    "copy-on-select": ["on", "off"],
    mode: ["normal", "full", "extra"],
    login: ["schedule"],
    resume: ["latest"],
    schedule: [
      "--sync",
      "--semester",
      "--date",
      "--start-date",
      "--semesters",
      "--help",
    ],
    programs: ["--sync", "--plan", "--page", "--limit", "--filter", "--help"],
  };
  const prefix = input.slice(0, input.lastIndexOf(" ") + 1),
    word = input.slice(prefix.length);
  return (options[command] ?? [])
    .filter((option) => option.startsWith(word))
    .map((option) => prefix + option);
}

export async function attachmentSuggestions(
  input: string,
  root: string,
): Promise<string[]> {
  const match = input.match(/^\/attach\s+(.*)$/s);
  if (!match) return [];
  let partial = match[1],
    quote = "";
  if (partial[0] === '"' || partial[0] === "'") {
    quote = partial[0];
    partial = partial.slice(1);
  }
  if (quote && partial.endsWith(quote)) return [];
  const slash = Math.max(partial.lastIndexOf("/"), partial.lastIndexOf("\\"));
  const directory = partial.slice(0, slash + 1),
    prefix = partial.slice(slash + 1);
  const expanded = directory.startsWith("~/")
    ? resolve(homedir(), directory.slice(2))
    : resolve(root, directory || ".");
  try {
    return (await readdir(expanded, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.name.startsWith(prefix) &&
          (prefix.startsWith(".") || !entry.name.startsWith(".")),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20)
      .map((entry) => {
        const path = directory + entry.name + (entry.isDirectory() ? "/" : "");
        const delimiter = quote || (path.includes(" ") ? '"' : "");
        if (path.includes(delimiter) && delimiter) return "";
        return (
          "/attach " + delimiter + path + (entry.isDirectory() ? "" : delimiter)
        );
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
