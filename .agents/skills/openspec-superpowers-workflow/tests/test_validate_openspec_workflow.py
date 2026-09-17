from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = SKILL_ROOT / "scripts" / "validate_openspec_workflow.py"

PROPOSAL = """
---
status: approved
---
# 变更提案：导出能力
## 背景
现有用户无法导出数据。
## 目标
支持经过授权的数据导出。
## 非目标
本次不实现定时导出。
## 影响范围
影响 API 和后台任务。
## 风险与兼容性
保持现有 API 兼容。
## 验收标准
授权用户可以下载导出文件。
"""

DESIGN = """
# 设计说明：导出能力
## 总体方案
通过异步任务生成导出文件。
## 组件与边界
API 只提交任务，worker 负责生成文件。
## 数据与接口契约
新增导出任务 API 和状态查询 API。
## 错误处理
失败任务记录稳定错误码。
## 兼容与恢复
新增接口，不修改现有响应。
## 测试计划
覆盖权限、成功、失败和重试。
"""

TASKS = """
# 实施任务：导出能力
## 任务
- [x] 1. 后端实现
  - [x] 1.1 编写失败测试
  - [x] 1.2 实现导出服务
- [ ] 2. 最终验证
  - [ ] 2.1 运行测试与构建
## 验证命令
`pytest -q`
"""


class WorkflowValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def create_change(
        self,
        name: str = "add-export",
        proposal: str = PROPOSAL,
        design: str = DESIGN,
        tasks: str = TASKS,
    ) -> Path:
        change = self.root / "openspec" / "changes" / name
        change.mkdir(parents=True)
        for filename, content in {
            "proposal.md": proposal,
            "design.md": design,
            "tasks.md": tasks,
        }.items():
            (change / filename).write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")
        return change

    def run_validator(self, path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), str(path)],
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_rule(self, rule: str, path: Path) -> str:
        result = self.run_validator(path)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(rule, result.stdout)
        return result.stdout

    def test_approved_change_passes(self) -> None:
        result = self.run_validator(self.create_change())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("passed", result.stdout.lower())

    def test_openspec_root_discovers_changes(self) -> None:
        self.create_change("add-export")
        self.create_change("add-import")
        result = self.run_validator(self.root / "openspec")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_oswf001_rejects_invalid_change_name(self) -> None:
        self.assert_rule("OSWF001", self.create_change("Add_Export"))

    def test_oswf002_requires_all_artifacts(self) -> None:
        change = self.create_change()
        (change / "design.md").unlink()
        self.assert_rule("OSWF002", change)

    def test_oswf003_rejects_missing_or_invalid_status(self) -> None:
        proposal = PROPOSAL.replace("status: approved", "status: ready")
        self.assert_rule("OSWF003", self.create_change(proposal=proposal))

    def test_oswf003_rejects_duplicate_status(self) -> None:
        proposal = PROPOSAL.replace("status: approved", "status: draft\nstatus: approved")
        self.assert_rule("OSWF003", self.create_change(proposal=proposal))

    def test_oswf004_requires_complete_approved_artifacts(self) -> None:
        design = DESIGN.replace("## 错误处理\n失败任务记录稳定错误码。\n", "")
        self.assert_rule("OSWF004", self.create_change(design=design))

    def test_draft_may_be_incomplete(self) -> None:
        proposal = "---\nstatus: draft\n---\n# 变更提案：草稿\n"
        result = self.run_validator(self.create_change(proposal=proposal, design="# 设计草稿\n", tasks="# 任务草稿\n"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_oswf005_implemented_requires_all_tasks_complete(self) -> None:
        proposal = PROPOSAL.replace("status: approved", "status: implemented")
        self.assert_rule("OSWF005", self.create_change(proposal=proposal))

    def test_oswf006_rejects_child_without_parent(self) -> None:
        tasks = "# 实施任务\n## 任务\n  - [ ] 1.1 孤立任务\n## 验证命令\n`pytest -q`\n"
        self.assert_rule("OSWF006", self.create_change(tasks=tasks))

    def test_oswf006_rejects_untraceable_checkbox(self) -> None:
        tasks = "# 实施任务\n## 任务\n- [ ] 实现功能\n## 验证命令\n`pytest -q`\n"
        self.assert_rule("OSWF006", self.create_change(tasks=tasks))

    def test_oswf006_rejects_completed_parent_with_open_child(self) -> None:
        tasks = "# 实施任务\n## 任务\n- [x] 1. 父任务\n  - [ ] 1.1 未完成子任务\n## 验证命令\n`pytest -q`\n"
        self.assert_rule("OSWF006", self.create_change(tasks=tasks))

    def test_oswf007_rejects_placeholder_outside_fence(self) -> None:
        design = DESIGN.replace("失败任务记录稳定错误码。", "TODO: 定义错误码。")
        self.assert_rule("OSWF007", self.create_change(design=design))

    def test_placeholder_inside_fence_is_ignored(self) -> None:
        design = DESIGN + "\n```text\nTODO is a literal example\n```\n"
        result = self.run_validator(self.create_change(design=design))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_oswf008_rejects_unpaired_fence(self) -> None:
        self.assert_rule("OSWF008", self.create_change(design=DESIGN + "\n```python\nvalue = 1\n"))

    def test_oswf009_archived_cannot_remain_active(self) -> None:
        proposal = PROPOSAL.replace("status: approved", "status: archived")
        self.assert_rule("OSWF009", self.create_change(proposal=proposal, tasks=TASKS.replace("[ ]", "[x]")))

    def test_invalid_path_returns_usage_error(self) -> None:
        result = self.run_validator(self.root / "missing")
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
