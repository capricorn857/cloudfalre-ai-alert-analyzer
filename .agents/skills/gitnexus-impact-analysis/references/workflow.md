# GitNexus Workflow

## Discover Repository State

Run from the repository root:

```bash
command -v gitnexus
gitnexus status
gitnexus list
git branch --show-current
basename "$(git rev-parse --show-toplevel)"
```

Resolve the default branch without assuming its name:

```bash
git symbolic-ref --short refs/remotes/origin/HEAD
```

If no remote default is configured, inspect local branches and repository instructions before choosing a comparison base.

## Build Or Refresh The Index

Derive the current branch and repository name from Git, then index without rewriting team instructions:

```bash
gitnexus analyze \
  --branch "$(git branch --show-current)" \
  --name "$(basename "$(git rev-parse --show-toplevel)")" \
  --skip-agents-md \
  --skip-skills
```

Keep `--skip-agents-md` by default to protect maintained `AGENTS.md` and `CLAUDE.md` files. Omit it only when the user explicitly requests regeneration of GitNexus marker sections. Keep `--skip-skills` by default to protect team-maintained skill files; omit it only when the user explicitly requests GitNexus standard skill installation.

Refresh the index when it is absent, stale for the active branch, or missing symbols needed for the analysis.

## Analyze Before Change

Use GitNexus `query` or `context` to understand unfamiliar execution paths. For every shared or public function, method, class, model, schema, service, repository, authorization rule, audit flow, event, or publishing path being changed, run:

```bash
gitnexus impact <symbol-name>
```

Record direct and indirect dependents, affected execution or business flows, risk level, and whether impact stays within the approved scope.

HIGH or CRITICAL risk, or any impact outside the approved scope, stops implementation. Report the evidence and return to OpenSpec design or scope confirmation.

For renames, use graph-aware GitNexus rename support when available. Otherwise establish the call and dependency graph first, apply a controlled rename, and verify every reference. Do not use an unreviewed global search-and-replace.

## Detect Changes Before Completion

After implementation and project verification, run:

```bash
gitnexus detect-changes
```

When comparison with the default branch is useful, resolve it first and pass the resolved ref:

```bash
gitnexus detect-changes --scope compare --base-ref <resolved-default-branch>
```

Compare affected symbols and flows with the OpenSpec artifacts and implementation plan. Unexpected impact blocks completion until corrected, explained, or approved through an updated scope decision.

## Report

Report:

- Main symbols and flows changed.
- Direct and indirect impact.
- GitNexus risk level.
- Whether impact stayed within the approved scope.
- Tests, builds, and other verification run.
- `detect-changes` result, or why it was unavailable.

## Fallback

If the executable, index, or required query is unavailable, state: "GitNexus is unavailable for this analysis." Source reading, `rg`, tests, and manual call-chain tracing may provide a temporary local assessment, but it must not be labeled GitNexus impact analysis.

For high-risk refactors, renames, migrations, or cross-module changes, report the unavailable gate as a material limitation and do not claim comprehensive impact verification from text search alone.
