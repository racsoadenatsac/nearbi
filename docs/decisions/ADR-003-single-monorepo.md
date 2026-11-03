# ADR-003: Single monorepo for submission (subtree, history preserved)

- Date: 2026-11-03
- Status: Accepted
- Supersedes: [ADR-002](ADR-002-umbrella-submission-repo.md)

## Context
ADR-002 planned a public umbrella repo, `research-shop`, that pulled the other repos in as git
submodules. A submodule only resolves for a judge if the repo it points to is public, so every
sub-repo would have to be made public. Some content has to stay private: sales leads and outreach
(`rs-sales`), and the paid reports delivered to customers (`rs-reports`). The umbrella also only
covered `rs-docs`, `rs-repro` and `rs-reports`, so it went stale as the product moved to
`nearbi-app`, `nearbi-infra`, `rs-payments`, `rs-ledger`, `rs-agent` and `rs-thesis`.

## Decision
Submit one monorepo, `racsoadenatsac/nearbi`. Each included repo is imported into its own top-level
directory with `git subtree add` **without `--squash`**, so its original commits and their dates
remain in the history. That history shows the code was written during the hackathon.

| Directory | Source |
|---|---|
| `app/` | nearbi-app |
| `infra/` | nearbi-infra |
| `contracts/` | rs-payments |
| `agent/` | rs-agent |
| `ledger/` | rs-ledger |
| `repro/` | rs-repro |
| `thesis/` | rs-thesis |
| `docs/` | rs-docs |
| `reports/` | rs-reports, free material only |
| `tooling/` | rs-tooling |

These repos are excluded: `rs-sales` (leads and outreach), `rs-site` and `nearbi-site` (superseded by
`nearbi-app/public`), and the old `research-shop` umbrella.

Paid report packs never ship. `reports/` keeps only the free sample report, the report tools and an
exclusion note. Any paid pack that reaches the source repo is removed from the monorepo and purged
from its history with `git filter-repo`.

## Consequences
- Judges get one link with every component and its full commit history.
- The source repos remain the place where work happens: feature branches, tags, private content.
  `tooling/bin/sync-monorepo.sh` runs `git subtree pull` for each prefix before submission. It pulls
  `reports/` through the same deterministic filter-repo pass, so paid packs cannot come back.
- Tags in the source repos are not imported. Use the source repo for tag-pinned steps (e.g.
  `rs-thesis make image`), or override `IMAGE` and `TOOLS` in the monorepo.
- `git log -- <dir>` in the monorepo stops at the import merge, because the original commits use the
  source repo's paths. Read a unit's full history from the subtree merge's second parent.
- The monorepo stays private until the operator approves publishing it.
