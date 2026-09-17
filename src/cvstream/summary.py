from pathlib import Path
from openai import OpenAI

class AISummarizer:
    def __init__(self, config):
        
        self.api_key = config.get("api_key", "").strip()
        self.engine_name = config.get("llm_engine", "")
        
        
        base_endpoints = {
            "DeepSeek (api.deepseek.com)": "https://api.deepseek.com/v1",
            "豆包 (ark.cn-beijing.volces.com)": "https://ark.cn-beijing.volces.com/api/v3",
            "智谱清言 (open.bigmodel.cn)": "https://open.bigmodel.cn/api/paas/v4",
            "Kimi (api.moonshot.cn)": "https://api.moonshot.cn/v1",
            "MiniMax (api.minimax.chat)": "https://api.minimax.chat/v1",
        }
        custom_endpoints = config.get("custom_llm_endpoints", {})
        all_endpoints = {**base_endpoints, **custom_endpoints}
        
        self.base_url = all_endpoints.get(self.engine_name, "https://api.deepseek.com/v1").strip()
        self.model_name = self._infer_model_name(self.base_url)

    def _infer_model_name(self, url):
        url_lower = url.lower()
        
        if "aliyuncs" in url_lower: return "qwen-plus" 
        
        if "deepseek" in url_lower: return "deepseek-flash"
        
        if "moonshot" in url_lower: return "kimi-k2.5" 
        
        if "bigmodel" in url_lower: return "glm-4.7" 
        
        if "minimax" in url_lower: return "abab6.5s-chat"
        
        if "volces" in url_lower: return "ep-这里填入你的接入点ID" 
        return "gpt-4o-mini" 
    def generate_daily_summary(self, export_base_dir, course_name, date_teacher):
        if not self.api_key:
            raise ValueError("未配置大模型 API 密钥 (Key)，请在控制面板填写。")

        base_path = Path(export_base_dir)
        sub_dir = base_path / "subtitle" / course_name / date_teacher
        knowledge_dir = base_path / "knowledge" / course_name
        
        
        if not sub_dir.exists():
            raise ValueError("未找到该课程批次的字幕目录，请确认是否已完成抓取。")
            
        txt_files = sorted(list(sub_dir.glob("*_transcript.txt")))
        if not txt_files:
            raise ValueError("字幕目录中没有有效的转写文本文件。")

        
        full_text = ""
        for f in txt_files:
            
            period = f.name.split('_')[0]
            full_text += f"\n\n### 课时片段：{period}\n\n"
            try:
                with open(f, "r", encoding="utf-8") as file:
                    full_text += file.read().strip()
            except Exception as e:
                full_text += f"[该片段读取失败: {e}]"

        
        if len(full_text.strip()) < 100:
            raise ValueError("抓取到的转写文本长度过短，已自动跳过 AI 总结以节省额度。")

        # 3. 构建 Prompt 体系
        client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        
        system_prompt = """
            1. 角色定位
            您是一名具备丰富教学经验、逻辑思维缜密的高校教授兼金牌讲师，核心工作是对 Whisper 转写的课程录音稿进行深度加工，将碎片化的原始文本转化为符合学术标准、结构清晰的高质量学习笔记。
            2. 核心任务
            2.1 文本净化
            自动修正转写过程中出现的同音字、识别错误；剔除 “嗯、啊、那个” 等口语化助词，以及重复、冗余的无效内容。
            2.2 知识建模
            将长篇且无条理的原始稿件，提炼为层次分明、逻辑闭环的系统化知识体系。
            2.3 深度解析
            还原授课的核心逻辑，精准识别课程核心考点，并对老师强调的重点内容进行拆解分析。
            3. 处理流程（严格遵循以下步骤执行）
            步骤一：课程核心综述
            用一句话高度概括本节课的核心教学主题，要求精准、无冗余。
            步骤二：核心概念梳理
            提取文本中的专业术语，为每个术语撰写严谨、简洁的学术定义，形成标准化概念表。
            步骤三：结构化讲义生成
            采用 Markdown 分级标题（## 一级章节、### 二级小节）搭建讲义框架，保证章节逻辑连贯；
            精准讲解：针对抽象、复杂的知识点，进行分层拆解，确保讲解详尽且易懂；
            案例还原：完整保留授课过程中提及的经典案例，不得删减核心信息；
            启发式扩充：对可拓展的知识点，补充简单、典型的辅助实例，并单独设置「启发式扩充」板块，对实例进行详细解读；
            视觉内容还原：若文本中出现 “这张图”“看这里” 等指向 PPT / 可视化内容的表述，结合上下文合理推测内容，并以文字形式完整还原。
            步骤四：重点内容摘录
            识别老师反复强调、语气加重的内容，整理为核心复习要点，便于学习者聚焦关键。
            步骤五：课后练习设计
            设计 3-5 道具有思考深度的课后练习题，覆盖课程核心知识点，用于检验学习效果，形成知识闭环。
            4. 执行约束
            4.1 真实性约束
            严格基于原始转写文本处理，严禁虚构、编造内容；若因音频噪音等原因导致内容无法辨识，必须标注「此处内容不详」。
            4.2 文体风格约束
            整体保持专业、客观的学术语调，排版符合正式教学大纲的格式规范，易读性强。
            4.3 格式规范约束
            所有数学、物理公式及符号需使用 LaTeX 正确渲染，支持行内公式（如 
            $E=mc^2$
            
            ）和块级公式（如 
            $$ E=mc^2 $$
            
            ）两种形式。
            4.4 详细度约束
            回复内容不设篇幅限制，遵循「宁多勿少」原则，确保所有知识点均被讲解透彻，无关键信息遗漏。
            """

        
        response = client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"以下是今日课程的原始转录文本集成：\n{full_text}"}
            ],
            stream=True,          
            temperature=0.2, 
            timeout=120      
        )
        
        
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content is not None:
                yield chunk.choices[0].delta.content

    def generate_and_save(self, export_base_dir, course_name, date_teacher):
        """Generate one Markdown note and persist it in the knowledge directory."""
        content = "".join(
            self.generate_daily_summary(export_base_dir, course_name, date_teacher)
        )
        output_dir = Path(export_base_dir) / "knowledge" / course_name
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{date_teacher}.md"
        output_path.write_text(content, encoding="utf-8")
        return output_path

