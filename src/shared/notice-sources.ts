import rawSources from "../seudaily/notice_categories.json" with { type: "json" };
import { z } from "zod";

const selectors = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)).min(1);
const sourceSchema = z.object({
  name: z.string().trim().min(1),
  attachmentLabel: z.string().trim().min(1).optional(),
  host: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.seu\.edu\.cn$/),
  adapter: z.literal("webplus").optional(),
  displayCategories: z.array(z.string()).min(1).optional(),
  idPrefix: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  searchType: z.enum(["", "1"]).optional(),
  selectors: z
    .object({
      title: selectors.optional(),
      date: selectors.optional(),
      content: selectors.optional(),
    })
    .strict()
    .optional(),
  categories: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]*$/),
      z.tuple([
        z.string().trim().min(1),
        z.string().regex(/^\/[A-Za-z0-9_]+\/list\.htm$/),
      ]),
    )
    .optional(),
});
export type NoticeSource = z.infer<typeof sourceSchema>;
export function loadNoticeSources(
  value: unknown,
): Record<string, NoticeSource> {
  const sources = z
    .record(z.string().regex(/^[a-z][a-z0-9_]*$/), sourceSchema)
    .parse(value);
  if (!Object.keys(sources).length) throw new Error("通知来源配置不能为空");
  const hosts = new Set<string>(),
    prefixes: string[] = [];
  for (const [id, source] of Object.entries(sources)) {
    if (hosts.has(source.host)) throw new Error("通知来源域名重复");
    hosts.add(source.host);
    if (!source.categories) {
      if (source.adapter) throw new Error("通知 adapter 必须配置栏目");
      continue;
    }
    if (
      source.displayCategories?.some(
        (category) => !source.categories![category],
      )
    )
      throw new Error("通知展示栏目无效");
    const entries = Object.values(source.categories);
    if (!entries.length) throw new Error("通知栏目配置不能为空");
    if (new Set(entries.map((entry) => entry[1])).size !== entries.length)
      throw new Error("通知栏目路径重复");
    source.adapter ??= "webplus";
    source.idPrefix ??= `seu-${id}`;
    if (
      prefixes.some(
        (prefix) =>
          prefix === source.idPrefix ||
          prefix.startsWith(source.idPrefix! + "-") ||
          source.idPrefix!.startsWith(prefix + "-"),
      )
    )
      throw new Error("通知 ID 前缀冲突");
    prefixes.push(source.idPrefix);
  }
  return sources;
}
export const noticeSources = loadNoticeSources(rawSources);
export const noticeSourceIds = Object.keys(noticeSources).filter(
  (id) => noticeSources[id].adapter,
);
if (!noticeSourceIds.length) throw new Error("没有可抓取的通知来源");
export const noticeSourceEnum = noticeSourceIds as [string, ...string[]];
export function requireNoticeSource(
  id: string,
  sources: Record<string, NoticeSource> = noticeSources,
): NoticeSource & {
  categories: Record<string, [string, string]>;
  idPrefix: string;
} {
  const source = sources[id];
  if (!source?.adapter || !source.categories || !source.idPrefix)
    throw new Error(`未知通知来源：${id}`);
  return source as NoticeSource & {
    categories: Record<string, [string, string]>;
    idPrefix: string;
  };
}
