import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { defineTool } from '../agent/tool.js';
import { projectRoot } from './runtime-paths.js';

export type SkillInfo = { name: string; description: string; namespaces: string[] };
const namePattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const namespaces = ['schedule', 'course-materials', 'notices', 'training-plan', 'web', 'browser', 'local-actions', 'workspace'];

export class SkillCatalog {
    constructor(private root = resolve(projectRoot, 'skills')) {}
    private async file(name: string, path = 'SKILL.md') {
        if (!namePattern.test(name)) throw new Error('无效 Skill 名称');
        if (path.split(/[\\/]/).includes('..')) throw new Error('Skill 路径不得包含上级目录');
        const root = await realpath(this.root);
        const directory = await realpath(resolve(root, name));
        const target = await realpath(resolve(directory, path));
        for (const [base, child] of [[root, directory], [directory, target]]) {
            const rel = relative(base, child);
            if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Skill 文件超出目录边界');
        }
        if (path !== 'SKILL.md' && (!path.startsWith('references/') || !path.endsWith('.md'))) throw new Error('只允许读取 Skill 的 Markdown 参考资料');
        const content = await readFile(target, 'utf8');
        if (content.length > 100000) throw new Error('Skill 文件过大');
        return content;
    }
    async list(): Promise<SkillInfo[]> {
        const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        const skills: SkillInfo[] = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory() || !namePattern.test(entry.name)) continue;
            const content = await this.file(entry.name);
            const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
            const document = parseDocument(header, { uniqueKeys: true });
            if (document.errors.length) throw new Error(`Skill 元数据格式错误：${entry.name}`);
            const metadata = z.object({
                name: z.string().regex(namePattern).optional(), description: z.string().trim().min(1).max(2000).default(entry.name),
                namespaces: z.array(z.string().refine(value => namespaces.includes(value))).max(8).default([]),
            }).parse(document.toJS({ maxAliasCount: 20 }) ?? {});
            if (metadata.name && metadata.name !== entry.name) throw new Error(`Skill 名称与目录不一致：${entry.name}`);
            skills.push({ name: entry.name, description: metadata.description, namespaces: metadata.namespaces });
        }
        return skills;
    }
    async read(name: string, path?: string) { return this.file(name, path); }
    async instructions(selected: string[], enabledNamespaces: string[]) {
        const catalog = await this.list();
        const names = new Set([...selected, ...catalog.filter(skill => skill.namespaces.some(value => enabledNamespaces.includes(value))).map(skill => skill.name)]);
        for (const name of names) if (!catalog.some(skill => skill.name === name)) throw new Error(`Skill 不存在：${name}`);
        return {
            catalog: catalog.map(skill => `${skill.name}：${skill.description}`).join('\n'),
            content: (await Promise.all([...names].map(async name => `【Skill：${name}】\n${await this.read(name)}`))).join('\n\n'),
        };
    }
}
export const skillCatalog = new SkillCatalog();
export const listSkillsTool = defineTool({
    id: 'list-skills', description: '列出项目内可用的 Skill 及适用场景。', inputSchema: z.object({}).strict(),
    execute: async () => ({ skills: await skillCatalog.list() }),
});
export const readSkillTool = defineTool({
    id: 'read-skill', description: '按名称加载 Skill 的完整规则到当前运行。需要详细背景时，可指定 references/ 下的 Markdown 相对路径。',
    inputSchema: z.object({ name: z.string().regex(namePattern), reference: z.string().max(200).optional() }).strict(),
    execute: async ({ name, reference }, options) => {
        const content = await skillCatalog.read(name, reference);
        const selected = options.requestContext?.get('seudailySkills');
        if (!Array.isArray(selected)) throw new Error('当前运行缺少 Skill 上下文');
        if (!selected.includes(name)) selected.push(name);
        return reference ? { name, reference, content } : { name, loaded: true, summary: '完整 Skill 已加载到本轮系统指令。' };
    },
});
