import { Agent } from "@mastra/core/agent";

import {
  authorizePortalTool,
  captureCourseLessonTool,
  extractSlidesTool,
  findCourseLessonTool,
  listCoursesTool,
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
1. 先确认目标课程和所需产物；课程不明确时先列出或搜索课程。
2. 当上游给出课程名、教师名和课时序号时，先精确定位课时；需要产物时调用精确课时抓取工具。
3. 登录失效时再调用授权工具，它会打开可见浏览器供用户完成验证。
4. 默认只抓字幕，除非用户明确需要媒体或 PPT。
5. 不要在回复中暴露账号、密码、Cookie、API Key 或带签名的媒体 URL。
6. 工具失败时说明失败阶段与可执行的恢复方法，不要虚构成功结果。
7. 只处理用户本人有合法访问权限的内容。
`,
  model: {
    id: `deepseek/${process.env.DEEPSEEK_MODEL ?? "deepseek-flash"}`,
    url: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  },
  tools: {
    authorizePortalTool,
    listCoursesTool,
    searchCoursesTool,
    findCourseLessonTool,
    captureCourseLessonTool,
    transcribeMediaTool,
    transcribeCloudAudioTool,
    extractSlidesTool,
    summarizeCourseTool,
  },
});
