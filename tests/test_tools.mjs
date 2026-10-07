import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function compileSource(relativePath, directory) {
  const source = await readFile(join(root, relativePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const target = join(directory, relativePath.replace(/\.ts$/, ".js"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, outputText);
  return target;
}

test("remote extraction blocks private IPv6 and campus aliases without rejecting ordinary domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seudaily-url-test-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const target = await compileSource("src/runtime/tools/public-url.ts", directory);
    const { normalizePublicUrl } = await import(pathToFileURL(target));
    for (const url of [
      "http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12::1]/",
      "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:192.168.1.1]/",
      "http://127.1/", "http://100.64.0.1/", "http://localhost./", "https://jwc.seu.edu.cn./notice",
    ]) assert.throws(() => normalizePublicUrl(url), undefined, url);
    assert.equal(normalizePublicUrl("https://fca.example/article#part"), "https://fca.example/article");
    assert.equal(normalizePublicUrl("https://fd.example/article"), "https://fd.example/article");
    assert.equal(normalizePublicUrl("https://[2606:4700:4700::1111]/"), "https://[2606:4700:4700::1111]/");
    for (const url of ["https://alice:secret@example.com/", "https://example.com/?api_key=secret"]) {
      assert.throws(() => normalizePublicUrl(url), (error) => !error.message.includes("secret"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an already cancelled Python tool does not start or cancel the shared worker", { skip: process.platform === 'win32' ? 'POSIX executable shim; Windows uses the real worker installation smoke test' : false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "seudaily-worker-test-"));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const target = await compileSource("src/runtime/tools/python-bridge.ts", directory);
    await compileSource("src/runtime/process-tree.ts", directory);
    await writeFile(join(directory, "src/runtime/runtime-paths.js"), `export const projectRoot = ${JSON.stringify(directory)}; export const envValue = (name, fallback) => process.env[name] ?? fallback;`);
    const workerScript = join(directory, "uv");
    const marker = join(directory, "started");
    await writeFile(workerScript, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(marker)}, "started");
const safety = setTimeout(() => process.exit(0), 1000);
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.action) {
    process.stdout.write(JSON.stringify({ requestId: message.requestId, type: "result", result: { status: "completed" } }) + "\\n");
    clearTimeout(safety);
    process.exit(0);
  }
});

`);
    await chmod(workerScript, 0o755);
    process.env.PATH = directory;
    const { runPythonTool } = await import(pathToFileURL(target));
    await assert.rejects(runPythonTool("health", {}, AbortSignal.abort()), { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal((await runPythonTool("health", {})).status, "completed");
    assert.equal(await readFile(marker, "utf8"), "started");
    // Allow the worker's close event to clear its process handles before cleanup.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("capability discovery exposes transformed input schemas and rejects incomplete capture targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seudaily-broker-test-"));
  const previousRoot = process.env.SEUDAILY_PROJECT_ROOT;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(join(directory, "pyproject.toml"), "[project]\nname = 'test'\n");
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    process.env.SEUDAILY_PROJECT_ROOT = directory;
    await compileSource("src/agent/tool.ts", directory);
    for (const module of [
      "runtime-paths", "images", "process-tree", "action-request-store", "auth-resume-store", "local-action-schema", "permission-state", "vpn-state",
      "tools/course-tools", "tools/python-bridge", "tools/tool-result", "tools/tool-broker",
      "tools/browser-tools", "tools/browser-config", "tools/web-reader", "tools/web-fetch", "tools/web-search", "tools/public-url",
    ]) await compileSource(`src/runtime/${module}.ts`, directory);
    await writeFile(join(directory, 'src/runtime/tools/browser-catalog.json'), await readFile(join(root, 'src/runtime/tools/browser-catalog.json')));
    await writeFile(join(directory, "src/runtime/tools/python-bridge.js"), `
export let pageResult;
export function setPageResult(result) {pageResult = result;}
export async function runPythonTool(action, payload) {
  if (action === "read-web-page" && pageResult) return pageResult;
  if (action === "apply-agent-schedule-change") return {status:"completed",summary:"本地设置已更新",data:{change:payload},artifacts:[],citations:[],warnings:[],metrics:{}};
  return { status: "auth_required", taskId: "task-test", summary: "Login required", data: {}, artifacts: [], citations: [], warnings: [], metrics: {} };
}
`);
    const {setPageResult} = await import(pathToFileURL(join(directory,"src/runtime/tools/python-bridge.js")));
    const {runtimeRoot} = await import(pathToFileURL(join(directory,"src/runtime/runtime-paths.js")));
    const {hydrateImages} = await import(pathToFileURL(join(directory,"src/runtime/images.js")));
    const {readWebPageTool} = await import(pathToFileURL(join(directory,"src/runtime/tools/web-reader.js")));
    const {createHash} = await import("node:crypto");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfLkAAAAASUVORK5CYII=", "base64");
    const calendarDir = join(runtimeRoot,"calendar");
    await mkdir(calendarDir,{recursive:true}); await writeFile(join(calendarDir,"calendar.png"),png);
    const calendarData = {sourceUrl:"https://jwc.seu.edu.cn/xl/list.htm",content:"通知正文",attachments:[{file:"calendar.png",text:"通知正文",sha256:createHash("sha256").update(png).digest("hex")}]};
    setPageResult({status:"completed",summary:"校历",taskId:"page",data:calendarData,artifacts:[],citations:[],warnings:[],metrics:{}});
    const visual = await readWebPageTool.execute(readWebPageTool.inputSchema.parse({url:calendarData.sourceUrl}),{});
    const visualView = await readWebPageTool.toModelOutput(visual);
    assert.equal(visualView.type,"content");
    assert.equal(visualView.value[0].text.split("通知正文").length - 1,1);
    const hydrated = await hydrateImages([{role:"user",content:visualView.value}]);
    assert.equal(hydrated[0].content.at(-1).image_url.url,`data:image/png;base64,${png.toString("base64")}`);
    assert.equal(JSON.stringify(visual).includes(png.toString("base64")),false);
    await writeFile(join(calendarDir,"calendar.png"),Buffer.from("corrupted"));
    const invalid = await readWebPageTool.execute(readWebPageTool.inputSchema.parse({url:calendarData.sourceUrl}),{});
    assert.equal(invalid.data.modelImages.length,0);
    assert.match(invalid.warnings.join(" "),/校验失败/);
    assert.equal(readWebPageTool.toModelOutput(invalid).type,"text");
    setPageResult(undefined);
    const { captureCourseMaterialsTool, auditTrainingPlanTool, getScheduleTool, getCurrentDateTool, proposeLocalActionTool } = await import(pathToFileURL(join(directory, "src/runtime/tools/course-tools.js")));
    assert.equal(getScheduleTool.inputSchema.parse({}).prefetchAvailableSemesters, true);
    assert.equal(getScheduleTool.inputSchema.parse({}).localOnly, false);
    assert.equal(getScheduleTool.inputSchema.parse({}).refresh, false);
    const current = getCurrentDateTool.outputSchema.parse(await getCurrentDateTool.execute({}, {}));
    assert.equal(current.status, 'completed');
    const shanghai = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(current.data.timestamp));
    assert.equal(current.data.date, shanghai);
    assert.equal(current.data.weekday, new Date(`${shanghai}T12:00:00+08:00`).getUTCDay() || 7);
    assert.equal(getScheduleTool.inputSchema.parse({ prefetchAvailableSemesters: false }).prefetchAvailableSemesters, false);
    const schema = captureCourseMaterialsTool.inputSchema;
    for (const target of [
      { source: "schedule" },
      { source: "manual", courseName: "test" },
      { source: "manual", courseName: "test", teacherName: "teacher", weeklyPeriods: [] },
      { source: "manual", courseName: "test", teacherName: "teacher", weeklyPeriods: [1], courseDate: "2026-02-30" },
    ]) assert.equal(schema.safeParse({ targets: [target] }).success, false, JSON.stringify(target));
    assert.equal(schema.safeParse({ targets: [{ source: "schedule", scheduleId: "seu-test" }] }).success, true);
    assert.equal(schema.safeParse({ targets: [{ source: "manual", courseName: "test", teacherName: "teacher", weeklyPeriods: [1, 2] }] }).success, true);
    const { searchCapabilitiesTool, invokeCapabilityTool } = await import(pathToFileURL(join(directory, "src/runtime/tools/tool-broker.js")));
    const options = { requestContext: { get: (key) => key === "seudailyRunToken" ? "run-test" : undefined } };
    const audit = await auditTrainingPlanTool.execute(auditTrainingPlanTool.inputSchema.parse({}), options);
    assert.equal(audit.data.authRequest.target, "schedule");
    assert.match(audit.data.authRequest.id, /^auth-/);
    const result = await searchCapabilitiesTool.execute({ query: "修改课表", namespace: "local-actions" }, options);
    assert.equal(result.count, 1);
    const capability = result.results[0];
    const {setFullAccessEnabled, setFullAccessExtraEnabled} = await import(pathToFileURL(join(directory, "src/runtime/permission-state.js")));
    setFullAccessEnabled(false); setFullAccessExtraEnabled(false);
    const apply = proposeLocalActionTool.inputSchema.parse({kind:"set_semester",mode:"apply",schedule:{semester:{startDate:"2026-09-21"}}});
    assert.equal(proposeLocalActionTool.requireApproval(apply, options), true);
    assert.equal(await invokeCapabilityTool.requireApproval({ticket:capability.ticket,arguments:apply}, options), true);
    const applied = await invokeCapabilityTool.execute({ticket:capability.ticket,arguments:apply},options);
    assert.deepEqual(applied.data.change, {operation:"semester",semester:{startDate:"2026-09-21"}});
    assert.match((await invokeCapabilityTool.toModelOutput(applied)).value, /本地设置已更新/);
    const preview = {...apply, mode:"preview"};
    assert.equal(await invokeCapabilityTool.requireApproval({ticket:capability.ticket,arguments:preview}, options), false);
    setFullAccessEnabled(true);
    assert.equal(await invokeCapabilityTool.requireApproval({ticket:capability.ticket,arguments:apply}, options), false);
    setFullAccessEnabled(false);
    assert.equal(proposeLocalActionTool.inputSchema.safeParse({kind:"add_schedule",schedule:{course:{courseName:"周期课",startPeriod:1,endPeriod:2}}}).success, false);
    assert.equal(proposeLocalActionTool.inputSchema.safeParse({kind:"add_schedule_once",schedule:{date:"2026-10-07",course:{courseName:"单次课",startPeriod:1,endPeriod:2}}}).success, true);
    await assert.rejects(proposeLocalActionTool.execute(apply, {requestContext:{get:key=>key === "seudailyFocus"}}), /Focus/);
    const modelView = JSON.parse(getScheduleTool.toModelOutput({status:"completed",summary:"课表",data:{calendar:{attachments:[{text:"long calendar"}]},courses:[]},warnings:[]}).value);
    assert.equal(modelView.calendar, undefined);
    assert.match(proposeLocalActionTool.toModelOutput({status:"failed",summary:"写入失败",data:{},warnings:[]}).value, /写入失败/);
    assert.equal((await searchCapabilitiesTool.execute({query:"get-academic-calendar",namespace:"schedule"},options)).results.some(item=>item.name === "get-academic-calendar"), false);
    assert.ok(capability.inputSchema.properties.kind);
    assert.ok(capability.inputSchema.properties.schedule.properties.course.properties.weeks);
    await assert.rejects(invokeCapabilityTool.execute({ ticket: capability.ticket, arguments: { kind: "create_focus" } }, options), /focus/);
    await assert.rejects(invokeCapabilityTool.execute({ ticket: capability.ticket, arguments: {} }, {
      requestContext: { get: () => "another-run" },
    }), /票据/);
  } finally {
    if (previousRoot === undefined) delete process.env.SEUDAILY_PROJECT_ROOT;
    else process.env.SEUDAILY_PROJECT_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
