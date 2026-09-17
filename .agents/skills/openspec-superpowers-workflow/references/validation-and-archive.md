# Validation And Archive

## Workflow Validation

Run before implementation and before changing status to `implemented`:

```bash
python <skill-dir>/scripts/validate_openspec_workflow.py openspec/changes/<change-name>
openspec validate <change-name> --strict
```

Also run every project-specific command in `tasks.md` and any broader command required by repository instructions. Use `superpowers:verification-before-completion`: fresh output is required for every success claim.

If the OpenSpec CLI is unavailable, state the reason and manually compare proposal, design, tasks, code, and tests. Do not report that strict validation passed.

## Transition To Implemented

Before setting `status: implemented`, confirm:

- every task checkbox is complete;
- acceptance criteria are covered by test or inspection evidence;
- project tests, builds, linters, migrations, and contract checks required by scope pass;
- permissions, errors, compatibility, recovery, security, and operational risks were reviewed where relevant;
- remaining risks and unavailable checks are recorded.

Implementation completion does not imply merge, deployment, sync, or archive authority.

## Branch Completion

After fresh verification, use `superpowers:finishing-a-development-branch` to present the available merge, PR, keep, or discard outcomes. Do not commit, push, merge, deploy, or delete work unless the user request authorizes that action.

## Sync And Archive

Syncing change specs into canonical specifications and archiving a change are separate actions. Perform either only when the user explicitly requests it.

For archive:

1. Confirm status is `implemented` and validation is fresh.
2. Run the repository's OpenSpec sync/archive command.
3. Confirm the change no longer remains under active `openspec/changes`.
4. Re-run strict and workflow validation against the resulting structure.
5. Report synced specs, archive location, commands, and remaining risks.

Never set `status: archived` while leaving the change in the active directory.

## Validator Rules

| Rule | Meaning |
|---|---|
| `OSWF001` | Invalid change name |
| `OSWF002` | Missing required artifact |
| `OSWF003` | Missing, malformed, or invalid status |
| `OSWF004` | Approved-or-later artifact is incomplete |
| `OSWF005` | Implemented-or-archived change has unchecked tasks |
| `OSWF006` | Malformed, duplicate, or orphan task id |
| `OSWF007` | Unresolved placeholder outside code fences |
| `OSWF008` | Unpaired Markdown fence |
| `OSWF009` | Archived status remains in active changes |

