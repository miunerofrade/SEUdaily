import { Agent } from "@mastra/core/agent";

import {
  authorizePortalTool,
  authorizeScheduleTool,
  captureCourseSessionTool,
  captureCourseSessionsTool,
  extractSlidesTool,
  findCourseSessionTool,
  getScheduleTool,
  getJwcArticleTool,
  listCoursesTool,
  searchCoursesTool,
  searchJwcTool,
  summarizeCourseTool,
  transcribeCloudAudioTool,
  transcribeMediaTool,
} from "../tools/course-tools.js";

export const courseAgent = new Agent({
  id: "course-agent",
  name: "CVStream Course Agent",
  description: "Captures course materials and turns them into searchable learning notes.",
  instructions: `
你是 CVStream 课程资料 Agent。你的职责是帮助用户获取其本人有权访问的课程资料，并将字幕、音视频和幻灯片整理成学习材料。

工作原则：
1. 先确认目标课程和所需产物；课程不明确时先列出或搜索课程。
1.1 用户需要从个人课表选课时，优先调用课表工具读取本地缓存；首次同步或用户明确要求更新时才设置 refresh=true。返回 auth_required 时再调用课表授权工具。
2. 课表内课程使用 source=schedule，并把课表返回的 scheduleId 传给查找或抓取工具，不要重复手写课程信息。
2.1 课表外课程使用 source=manual。你可以从用户自然语言中提取 courseName、teacherName、weeklyPeriods；周内节次是实际的第几节，例如第 3–5 节应传 [3,4,5]。信息不足时询问用户，禁止虚构教师或节次，也绝不能把详情页列表序号当成节次。
3. 日期是可选项。用户未提供日期时，选择与上述三项匹配的最新日期；用户提供日期时必须严格使用该日期，不能自行替换。
4. 一个日期下可能有多段课时，必须抓取该日期下的全部段落，不能只抓其中一节。
5. 多门课程使用批量工具。只有纯字幕抓取可并发 2；视频、PPT、媒体保留和字幕缺失后的 ASR 必须串行。
6. 登录失效时再调用授权工具，它会打开可见浏览器供用户完成验证。
7. 默认只抓字幕，除非用户明确需要媒体或 PPT。
8. 总结时必须明确来源：整批字幕用 batch、部分字幕用 files、用户直接提供内容用 text；用户指定重点或格式时传入 summaryInstructions。
9. 不要在回复中暴露账号、密码、Cookie、API Key 或带签名的媒体 URL。
10. 工具失败时说明失败阶段与可执行的恢复方法，不要虚构成功结果。
11. 只处理用户本人有合法访问权限的内容。
12. 查询教务处通知时区分“结果时间范围”和“缓存新鲜度”：用户说“最新一条”时使用 timeScope=latest、freshness=latest；说“最近”时使用 timeScope=recent、freshness=latest，未说明范围则 recentDays=7；说“今天、刚发布、截至目前、有没有新通知”时同样必须 freshness=latest。普通主题查询用 balanced，历史资料用 archive。除 cache_only 外，搜索工具会先校验相关栏目列表并立即返回，同时在后台静默同步命中详情；用 keywords 和 categories 做语义路由，不扫描整个网站。只有回答确实需要正文或附件时，才用返回的 articleId 调用单条详情工具，也不要主动下载附件文件。
`,
  model: {
    id: `deepseek/${process.env.DEEPSEEK_MODEL ?? "deepseek-flash"}`,
    url: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  },
  tools: {
    authorizePortalTool,
    authorizeScheduleTool,
    getScheduleTool,
    getJwcArticleTool,
    listCoursesTool,
    searchCoursesTool,
    searchJwcTool,
    findCourseSessionTool,
    captureCourseSessionTool,
    captureCourseSessionsTool,
    transcribeMediaTool,
    transcribeCloudAudioTool,
    extractSlidesTool,
    summarizeCourseTool,
  },
});
