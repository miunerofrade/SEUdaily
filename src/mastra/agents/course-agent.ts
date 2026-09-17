import { Agent } from "@mastra/core/agent";

import {
  authorizePortalTool,
  captureCourseTool,
  extractSlidesTool,
  listCoursesTool,
  listCourseDatesTool,
  searchCoursesTool,
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
1. 先确认目标课程和所需产物；课程不明确时先列出或搜索课程，日期不明确时再查询日期。
2. 登录失效时再调用授权工具，它会打开可见浏览器供用户完成验证。
3. 默认只抓字幕，除非用户明确需要媒体或 PPT。
4. 不要在回复中暴露账号、密码、Cookie、API Key 或带签名的媒体 URL。
5. 工具失败时说明失败阶段与可执行的恢复方法，不要虚构成功结果。
6. 只处理用户本人有合法访问权限的内容。
`,
  model: {
    id: `deepseek/${process.env.DEEPSEEK_MODEL ?? "deepseek-flash"}`,
    url: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  },
  tools: {
    authorizePortalTool,
    listCourseDatesTool,
    listCoursesTool,
    searchCoursesTool,
    captureCourseTool,
    transcribeMediaTool,
    transcribeCloudAudioTool,
    extractSlidesTool,
    summarizeCourseTool,
  },
});
