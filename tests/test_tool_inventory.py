from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_agent_keeps_only_core_tools_eager() -> None:
    source = (ROOT / "src/mastra/agents/course-agent.ts").read_text(encoding="utf-8")
    eager_block = source.split("return {", 1)[1].split("...namespaceTools", 1)[0]
    assert "getCurrentDateTool" in eager_block
    assert "readTaskResultTool" in eager_block
    assert "searchCapabilitiesTool" in eager_block
    assert "invokeCapabilityTool" in eager_block
    assert "authorizePortalTool" not in source
    assert "authorizeScheduleTool" not in source
    assert "requestBrowserTool" not in source
    assert "browserToolsLoaded" not in source


def test_course_tool_module_exports_only_public_high_level_tools() -> None:
    source = (ROOT / "src/mastra/tools/course-tools.ts").read_text(encoding="utf-8")
    exported = set(re.findall(r"^export const (\w+Tool) = createTool", source, re.MULTILINE))
    assert exported == {
        "getScheduleTool",
        "resolveCourseTool",
        "captureCourseMaterialsTool",
        "proposeLocalActionTool",
        "getCurrentDateTool",
        "auditTrainingPlanTool",
        "queryCampusNoticesTool",
        "readCampusNoticeTool",
    }


def test_each_static_namespace_has_fewer_than_ten_tools() -> None:
    source = (ROOT / "src/mastra/tools/tool-broker.ts").read_text(encoding="utf-8")
    namespaces = re.findall(r'namespace: "([^"]+)"', source.split("const staticCapabilities", 1)[1].split("];", 1)[0])
    assert namespaces
    assert max(namespaces.count(namespace) for namespace in set(namespaces)) < 10
