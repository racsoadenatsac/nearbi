# ADR-001: One git repo per logical unit

- Date: 2026-11-02
- Status: Accepted (operator directive)

## Decision
Every logical unit of work lives in its own local git repo under `~/projects/research-shop/rs-*`. Felix works like a developer: feature branches (`feat/`, `fix/`, `docs/`, `chore/`), small conventional commits, `--no-ff` merges into `main`, and tags for milestones (`v0.1.0`, `demo-ready`, `submitted`).

## Why
It gives us a versioned record of everything we do, it makes each piece reviewable on its own, and it makes the history auditable after the hackathon.

## Rules
- Never commit secrets. Every repo has a `.gitignore` for `.env`, keys and credentials.
- New repos come from `rs-tooling/bin/new-repo.sh`. Fleet status comes from `rs-tooling/bin/status.sh`.
- Work is committed when each step finishes, never left uncommitted at the end of a session.
