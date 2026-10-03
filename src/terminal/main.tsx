import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Session, type Options } from "./session.js";
import { clean } from "./client.js";
function parse(): Options {
  if (process.env.SEUDAILY_CLI_OPTIONS)
    return JSON.parse(process.env.SEUDAILY_CLI_OPTIONS);
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      chat: { type: "boolean", short: "c" },
      prompt: { type: "string", short: "p" },
      resume: { type: "string", short: "r" },
      skill: { type: "string", multiple: true },
      cwd: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      verbose: { type: "boolean", short: "v" },
      "no-color": { type: "boolean" },
      "no-start": { type: "boolean" },
      vi: { type: "boolean" },
    },
  });
  if (v.help) {
    console.log(
      "SEUdaily Ink CLI\nchat | exec [问题] | sessions | skills\n-c, --chat  -p, --prompt 问题  -r, --resume ID\n--skill NAME  --timeout SECONDS  --cwd PATH\n--json  -q, --quiet  -v, --verbose  --no-color  --vi\n-h, --help  -V, --version\n通过 uv run seudaily 自动管理后端；npm run cli 连接已有后端。",
    );
    process.exit(0);
  }
  if (v.version) {
    console.log(
      "seudaily " +
        JSON.parse(
          readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ).version,
    );
    process.exit(0);
  }
  const command = p.shift() ?? (v.prompt ? "exec" : "chat");
  if (!["chat", "exec", "sessions", "skills"].includes(command))
    throw new Error("未知子命令：" + command);
  if (p.length > 1 || (p.length && command !== "exec"))
    throw new Error("额外的位置参数");
  if (v.quiet && v.verbose)
    throw new Error("--quiet 与 --verbose 不能同时使用");
  if (v.json && command !== "exec") throw new Error("--json 仅用于 exec");
  const timeout = Number(v.timeout ?? 300);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("--timeout 必须是有限正数");
  return {
    ...v,
    command,
    message: p[0],
    timeout,
    no_color: v["no-color"],
  } as Options;
}
let options: Options;
try {
  options = parse();
} catch (error) {
  console.error(clean(error instanceof Error ? error.message : error));
  process.exit(2);
}
const root = resolve(
  options.cwd ?? process.env.SEUDAILY_PROJECT_ROOT ?? process.cwd(),
);
if (options.no_color || process.env.NO_COLOR) process.env.FORCE_COLOR = "0";
const session = new Session(options, root);
async function main() {
  await session.initialize();
  if (options.command === "chat") {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("交互聊天需要终端");
    const [{ render }, { App }, { default: React }] = await Promise.all([
      import("ink"),
      import("./app.js"),
      import("react"),
    ]);
    const instance = render(React.createElement(App, { session }), {
      alternateScreen: true,
      exitOnCtrlC: false,
      maxFps: 60,
      kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes", "reportAllKeysAsEscapeCodes"] },
    });
    if (options.prompt)
      void session
        .submit(options.prompt)
        .catch((e) => session.show(e.message, "错误"));
    await instance.waitUntilExit();
    await session.cancel();
    return 0;
  }
  if (options.command === "sessions" || options.command === "skills") {
    session.messages = [];
    await session.command("/" + options.command);
    for (const message of session.messages) console.log(message.text);
    return 0;
  }
  if (options.prompt && options.message)
    throw new Error("问题只能通过 --prompt 或位置参数指定一次");
  let text = options.prompt ?? options.message ?? "";
  if (!process.stdin.isTTY) {
    let piped = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) piped += chunk;
    text = text && piped ? text + "\n\n" + piped : text || piped;
  }
  if (!text.trim()) throw new Error("请提供问题，或通过标准输入传入文本");
  session.on("event", (event) => {
    if (options.json) console.log(JSON.stringify(event));
    else if (event.type === "text-delta")
      process.stdout.write(clean(event.payload.text));
    else if (event.type === "error")
      console.error(clean(event.payload.error?.message));
    else if (options.verbose && event.type === "tool-call")
      console.error(event.payload.toolName);
  });
  session.on("diagnostic", (text) => {
    if (!options.json) process.stderr.write(clean(text));
  });
  const stop = () => void session.cancel();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const code = await session.submit(text);
    if (!options.json) console.log();
    if (code === 3)
      console.error(
        `等待审批。seudaily chat --resume ${session.threadId} 后 /approve 或 /reject。`,
      );
    return code;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
try {
  process.exitCode = await main();
} catch (error) {
  console.error(clean(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
