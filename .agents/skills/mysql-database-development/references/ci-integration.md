# CI Integration

The team repository stores this Skill at `skills/mysql-database-development`. A consuming repository vendors the same release at:

```text
.agents/skills/mysql-database-development/
```

Include the central GitLab template at an immutable tag:

```yaml
include:
  - project: "ops/team-skills"
    ref: "v1.0.0"
    file: "/ci/gitlab/mysql-quality.yml"
```

GitLab include merges YAML but does not copy the Skill or checker into the target workspace. Vendor the matching release or distribute the checker through an approved pinned package.

The template uses changed-file mode for merge requests so legacy SQL does not block initial adoption. Set `MYSQL_GUARD_FULL_SCAN` to `true` for new repositories or scheduled compliance scans. Set `MYSQL_SQL_PATH` when migrations do not live under `migrations/sql`.

Actual enforcement requires:

- required successful pipelines before merge;
- protected default and release branches;
- no direct pushes that bypass review;
- `allow_failure: false` for the MySQL gate;
- restricted changes to CI and `.mysql-guard.toml`;
- the CI template ref and vendored Skill pinned to the same reviewed release.

Exceptions cannot suppress `MYSQL007`, `MYSQL010`, `MYSQL015`, parse failures, or exception-governance failures.

SQLGlot installation must use the approved internal package index when public package access is unavailable.
