export function inferToolNamespaces(text: string): string[] {
    const selected = new Set<string>();
    if (/课表|上课|今天.*课|明天.*课|timetable|schedule/i.test(text)) selected.add('schedule');
    if (/修改课表|调课|移动.*课|新增.*课|创建.*关注|新建.*关注|focus/i.test(text)) selected.add('local-actions');
    if (/课程回放|课次|字幕|课件|幻灯片|\bppt\b|录播|转写|subtitle|course material/i.test(text)) selected.add('course-materials');
    if (/教务处|计软智|计算机学院|学院通知|校园通知|最新通知|\bjwc\b|\bcse\b/i.test(text)) selected.add('notices');
    if (/培养方案|毕业要求|学分|通选|限选|任选|跨学科|training[- ]plan/i.test(text)) selected.add('training-plan');
    if (/https?:\/\/|上网查|网页|互联网|新闻|最新信息|web search|search online/i.test(text)) selected.add('web');
    if (/打开.*网页|浏览器|点击|输入|填写|下拉|页面交互|playwright|browser/i.test(text)) selected.add('browser');
    if (/修改.*文件|编辑.*代码|运行.*命令|终端|项目目录|workspace|terminal/i.test(text)) selected.add('workspace');
    return [...selected];
}
