import { isIP } from "node:net";

const sensitiveQueryKey = /token|key|auth|signature|cookie|credential|password|secret/i;

function isPrivateIpv4(hostname: string): boolean {
  const [first, second] = hostname.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || first >= 224;
}

function isPrivateIp(hostname: string): boolean {
  if (isIP(hostname) === 4) return isPrivateIpv4(hostname);
  if (isIP(hostname) !== 6) return false;
  if (hostname === "::" || hostname === "::1" || /^(fc|fd|fe[89ab]|fec|fed|fee|fef|ff)/i.test(hostname)) return true;
  // WHATWG URL normalizes IPv4-mapped addresses to hexadecimal IPv6.
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i.exec(hostname);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isPrivateIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  return false;
}

/** Validate URLs before sending them to a remote extraction provider. */
export function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  // Never include credentials or query strings in validation errors.
  const safeLabel = `${url.protocol}//${url.host}${url.pathname}`;
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`只允许 HTTP(S) URL：${safeLabel}`);
  if (url.username || url.password) throw new Error(`URL 不能包含登录凭据：${safeLabel}`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "seu.edu.cn" || hostname.endsWith(".seu.edu.cn")) {
    throw new Error(`校园域名不允许发送到远程网页提取：${safeLabel}`);
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isPrivateIp(hostname)) {
    throw new Error(`拒绝本地或私网 URL：${safeLabel}`);
  }
  if ([...url.searchParams.keys()].some((key) => sensitiveQueryKey.test(key))) {
    throw new Error(`URL 包含可能泄露凭据的查询参数：${safeLabel}`);
  }
  url.hash = "";
  return url.toString();
}
