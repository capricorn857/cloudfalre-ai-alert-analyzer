# Artifact Contracts

## Directory And Language

```text
openspec/changes/<english-kebab-case-name>/
├── proposal.md
├── design.md
└── tasks.md
```

Body text defaults to Chinese for team review. File names, status values, code identifiers, API paths, schema names, commands, error codes, and branch names remain English.

## Proposal

`proposal.md` begins with:

```yaml
---
status: draft
---
```

Required sections before approval:

```markdown
# 变更提案：标题
## 背景
## 目标
## 非目标
## 影响范围
## 风险与兼容性
## 验收标准
```

Acceptance criteria must be observable. Impact covers affected modules, APIs, data, permissions, security, operations, and consumers where relevant.

## Design

Use `superpowers:brainstorming`, but write the approved design to `design.md` rather than a parallel Superpowers path. Required sections:

```markdown
# 设计说明：标题
## 总体方案
## 组件与边界
## 数据与接口契约
## 错误处理
## 兼容与恢复
## 测试计划
```

State alternatives and the chosen tradeoff where the choice is non-obvious. Define ownership, dependencies, data flow, failure behavior, compatibility, migration, and recovery proportional to risk.

## Tasks

Use `superpowers:writing-plans`, with `tasks.md` as the user-selected plan location. Include goal, architecture, technology, global constraints, exact files, interfaces, TDD steps, verification commands, and explicit checkpoints needed by the change.

Required shape:

```markdown
# 实施任务：标题
## 任务
- [ ] 1. 可验证的父任务
  - [ ] 1.1 独立子任务
## 验证命令
`project-specific-command`
```

Each child task has one observable completion condition. A parent completes only after all children and its verification pass. Do not place unresolved placeholders in approved artifacts.

## Status Ownership

- Agent may create and refine `draft` artifacts.
- Move to `reviewing` when the user requests review or the team process explicitly starts it.
- Move to `approved` only after explicit user or authorized reviewer approval.
- Move to `implemented` only after all tasks and required validation pass.
- Move to `archived` only through an explicitly requested archive action.

