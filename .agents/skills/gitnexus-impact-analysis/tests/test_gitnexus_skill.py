from __future__ import annotations

import unittest
from pathlib import Path

import yaml


SKILL_ROOT = Path(__file__).resolve().parents[1]
SKILL_FILE = SKILL_ROOT / "SKILL.md"
WORKFLOW_FILE = SKILL_ROOT / "references" / "workflow.md"
OPENAI_FILE = SKILL_ROOT / "agents" / "openai.yaml"


class GitNexusSkillContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = SKILL_FILE.read_text(encoding="utf-8")
        cls.workflow = WORKFLOW_FILE.read_text(encoding="utf-8")
        cls.combined = cls.skill + "\n" + cls.workflow
        cls.metadata = yaml.safe_load(OPENAI_FILE.read_text(encoding="utf-8"))

    def test_frontmatter_and_ui_metadata_are_discoverable(self) -> None:
        self.assertIn("name: gitnexus-impact-analysis", self.skill)
        self.assertIn("description: Use when", self.skill)
        self.assertNotIn("GitNexus-indexed repository", self.skill)
        self.assertTrue(self.metadata["policy"]["allow_implicit_invocation"])
        self.assertIn("$gitnexus-impact-analysis", self.metadata["interface"]["default_prompt"])

    def test_skill_is_repository_independent(self) -> None:
        forbidden = ("ncgp", "nginx-cofing-platform", "--base-ref main")
        lowered = self.combined.lower()
        for value in forbidden:
            with self.subTest(value=value):
                self.assertNotIn(value, lowered)

    def test_three_tool_responsibilities_are_explicit(self) -> None:
        for value in ("OpenSpec", "Superpowers", "GitNexus"):
            with self.subTest(value):
                self.assertIn(value, self.skill)

    def test_pre_and_post_change_gates_are_required(self) -> None:
        for value in ("gitnexus impact", "gitnexus detect-changes"):
            with self.subTest(value):
                self.assertIn(value, self.workflow)
        self.assertIn("HIGH", self.combined)
        self.assertIn("CRITICAL", self.combined)
        self.assertIn("approved scope", self.combined)

    def test_indexing_protects_team_instructions(self) -> None:
        self.assertIn("--skip-agents-md", self.workflow)
        self.assertIn("--skip-skills", self.workflow)
        self.assertIn("AGENTS.md", self.workflow)
        self.assertIn("CLAUDE.md", self.workflow)

    def test_fallback_is_not_misreported_as_gitnexus_analysis(self) -> None:
        self.assertIn("GitNexus is unavailable", self.combined)
        self.assertIn("must not be labeled GitNexus impact analysis", self.combined)


if __name__ == "__main__":
    unittest.main()
