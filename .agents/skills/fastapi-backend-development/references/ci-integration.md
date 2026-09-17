# CI Integration

## Distribution Contract

This repository stores the source skill at `skills/fastapi-backend-development`. A target FastAPI repository must vendor a pinned release at:

```text
.agents/skills/fastapi-backend-development/
```

Vendoring keeps Codex discovery, the checker executed by CI, and the reviewed rule version aligned. Record the source tag or commit in the consuming project's dependency update process.

GitLab `include` merges CI YAML but does not copy files from the template repository into the target job workspace. Therefore the target repository must contain the vendored Skill, or the organization must separately distribute the checker as a versioned package. The provided template assumes vendoring.

## GitLab Setup

Include the centrally published template at an immutable tag:

```yaml
include:
  - project: "ops/team-skills"
    ref: "v1.0.0"
    file: "/ci/gitlab/fastapi-quality.yml"
```

The target may set `FASTAPI_PROJECT_ROOT` when application code is below the repository root. Do not override `FASTAPI_SKILL_DIR` to an unreviewed location.

For actual enforcement:

- require successful pipelines before merge;
- protect the default and release branches;
- prevent direct pushes that bypass merge requests;
- keep the architecture job blocking and never set `allow_failure: true`;
- restrict who may change CI configuration and temporary exceptions;
- pin the CI template and vendored Skill to the same reviewed release.

The Skill repository's own pipeline tests the checker, references, and CI template. It cannot enforce downstream repositories until they include the template and enable branch protections.

