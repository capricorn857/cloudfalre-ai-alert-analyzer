# Change Routing

## Read Context First

Read repository instructions, architecture documentation, relevant code and tests, active OpenSpec changes, and project validation commands before classifying work. Existing project rules remain binding.

## Direct Change

A direct change is small, isolated, and does not alter behavior or a contract. Examples include copy, comments, formatting, and an isolated test addition for existing behavior.

Direct changes may proceed without an OpenSpec change after identifying scope and validation. If investigation reveals behavior, contract, schema, security, permission, or cross-module impact, reclassify before editing.

## Bug Fix

For a localized defect with an established intended behavior:

1. Use `superpowers:systematic-debugging` to reproduce and find the root cause.
2. Use `superpowers:test-driven-development` to write the regression test before the fix.
3. Use `superpowers:verification-before-completion` before claiming the fix.

Create a formal OpenSpec change when the fix changes intended behavior, architecture, API or data contracts, schema, security, permissions, multiple modules, or production operations.

## Formal Change

Features and behavior changes always start with `superpowers:brainstorming`. A formal change is mandatory for medium or large work, including:

- new APIs, workflows, pages, or major interactions;
- cross-module or cross-service flows;
- database structure or migration behavior;
- authentication, authorization, security, audit, or approval rules;
- queues, workers, publishing, external integrations, or production operations;
- breaking contracts, module splits, major refactors, or migrations.

Use an English kebab-case action/domain name such as `add-ldap-login` or `refactor-publish-service`.

## Existing Change

When a change directory is named, read `proposal.md`, `design.md`, and `tasks.md` in that order, then related code and tests. Do not create another change for the same goal.

For a generic “continue the plan” request, proceed only when one approved active change is unambiguous. If multiple changes could match, ask the user to select one.

