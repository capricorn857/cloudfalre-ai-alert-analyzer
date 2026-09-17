---
name: gitnexus-impact-analysis
description: Use when a repository using GitNexus has a change that crosses modules or layers, modifies shared symbols or public contracts, includes a refactor or rename, implements a medium or large OpenSpec change, or requires dependency, call-chain, blast-radius, or pre-completion impact analysis.
---

# GitNexus Impact Analysis

## Core Contract

OpenSpec defines intent, approved scope, design, and acceptance criteria. Superpowers governs reasoning, planning, TDD, debugging, execution, review, and verification. GitNexus supplies repository indexing, code relationships, symbol impact, execution-flow analysis, and change detection.

GitNexus informs scope and risk; it does not replace source reading, tests, OpenSpec artifacts, or Superpowers workflows.

## Required Gates

Read [workflow.md](references/workflow.md) before planning or changing shared symbols and again before reporting completion.

1. Establish repository and index state.
2. Analyze affected symbols and flows before implementation.
3. Stop when risk is HIGH or CRITICAL, or impact exceeds the approved scope; report the evidence and return to OpenSpec scope confirmation.
4. Run change detection after implementation and compare the observed surface with the approved scope.
5. Report changed symbols, affected flows, risk, scope alignment, verification, and change-detection results.

For a small local edit with no shared-symbol or cross-module effect, skip the gate unless the user requests impact analysis.

## Unavailable Tool

If GitNexus is unavailable, say so. Use source reading, `rg`, tests, and manual call-chain tracing only as a temporary assessment. That fallback must not be labeled GitNexus impact analysis. Treat the missing gate as a material limitation for high-risk refactors, renames, migrations, or cross-module changes.
