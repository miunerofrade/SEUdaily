import { prepareTerminalInput, terminalKeyboard } from "./keyboard.js";
import { resolve } from "node:path";
import { Session, type Options } from "./session.js";
import { clean } from "./client.js";
function parse(): Options {
  if (!process.env.SEUDAILY_CLI_OPTIONS) throw new Error('请使用 seudaily 启动入口');
  return JSON.parse(process.env.SEUDAILY_CLI_OPTIONS);
}
let options: Options;
try {
  options = parse();
} catch (error) {
  console.error(clean(error instanceof Error ? error.message : error));
  process.exit(2);
}
const root = resolve(
  process.env.SEUDAILY_PROJECT_ROOT ?? options.cwd ?? process.cwd(),
);
if (options.no_color || process.env.NO_COLOR) process.env.FORCE_COLOR = "0";
const session = new Session(options, root);
async function main() {
  await session.initialize();
  if (options.command === "chat" || options.command === "settings") {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("交互界面需要终端");
    if (options.command === "settings") await session.command("/settings");
    const [{ render }, { App }, { default: React }] = await Promise.all([
      import("ink"),
      import("./app.js"),
      import("react"),
    ]);
    const restoreInput = prepareTerminalInput(process.stdin);
    const updateCheck = new AbortController();
    try {
      const instance = render(React.createElement(App, { session }), {
        alternateScreen: true,
        exitOnCtrlC: false,
        maxFps: 60,
        kittyKeyboard: terminalKeyboard(),
      });
      if (process.env.SEUDAILY_INSTALL_ROOT && !options.quiet) {
        void import('../distribution/update.js').then(({updateNotice})=>updateNotice(process.env.SEUDAILY_INSTALL_ROOT!,root,updateCheck.signal))
          .then(notice=>{if(notice && !updateCheck.signal.aborted)session.show(notice);}).catch(()=>{});
      }
      await instance.waitUntilExit();
      await session.cancel();
    } finally {
      updateCheck.abort();
      restoreInput();
    }
    return 0;
  }
  if (options.command === "sessions" || options.command === "skills") {
    session.messages = [];
    await session.command("/" + options.command);
    for (const message of session.messages) console.log(message.text);
    return 0;
  }
  let text = options.message ?? "";
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
