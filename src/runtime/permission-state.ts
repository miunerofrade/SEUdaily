import { envValue } from "./runtime-paths.js";

function readBoolean(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

let fullAccessEnabled = readBoolean(envValue("SEUDAILY_FULL_ACCESS"));
let fullAccessExtraEnabled = readBoolean(envValue("SEUDAILY_FULL_ACCESS_EXTRA"));

type PermissionOptions = { requestContext?: { get(key: string): unknown } };
const isFocus = (options?: PermissionOptions) => options?.requestContext?.get("seudailyFocus") === true;

export function isFullAccessEnabled(options?: PermissionOptions) {
  return isFocus(options) || fullAccessEnabled;
}

export function setFullAccessEnabled(enabled: boolean) {
  fullAccessEnabled = enabled;
  process.env.SEUDAILY_FULL_ACCESS = enabled ? "true" : "false";
  delete process.env.CVSTREAM_FULL_ACCESS;
}

export function isFullAccessExtraEnabled(options?: PermissionOptions) { return !isFocus(options) && fullAccessExtraEnabled; }

export function setFullAccessExtraEnabled(enabled: boolean) {
  fullAccessExtraEnabled = enabled;
  process.env.SEUDAILY_FULL_ACCESS_EXTRA = enabled ? "true" : "false";
  delete process.env.CVSTREAM_FULL_ACCESS_EXTRA;
}

export function isUnapprovedAccessEnabled(options?: PermissionOptions) { return isFullAccessEnabled(options) || isFullAccessExtraEnabled(options); }

export type PermissionMode = "normal" | "full" | "extra";
export const permissionModes = ["normal", "full", "extra"] as const;
export const permissionHelp = `normal — 普通：需要审批的操作逐项确认
full — 完全访问：业务和浏览器操作免审批
extra — 完全访问，并启用工作区文件和终端能力`;
export function getPermissionMode(): PermissionMode {
  return isFullAccessExtraEnabled() ? "extra" : isFullAccessEnabled() ? "full" : "normal";
}
export async function setPermissionMode(mode: PermissionMode) {
  if (!permissionModes.includes(mode)) throw new Error("权限模式应为 normal、full 或 extra");
  const {updateEnvFile} = await import("./environment-settings.js");
  await updateEnvFile({SEUDAILY_FULL_ACCESS: String(mode !== "normal"), SEUDAILY_FULL_ACCESS_EXTRA: String(mode === "extra")});
  setFullAccessEnabled(mode !== "normal");
  setFullAccessExtraEnabled(mode === "extra");
}
