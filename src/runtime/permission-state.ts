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
