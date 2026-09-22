function readBoolean(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

let fullAccessEnabled = readBoolean(process.env.CVSTREAM_FULL_ACCESS);

export function isFullAccessEnabled() {
  return fullAccessEnabled;
}

export function setFullAccessEnabled(enabled: boolean) {
  fullAccessEnabled = enabled;
  process.env.CVSTREAM_FULL_ACCESS = enabled ? "true" : "false";
}
