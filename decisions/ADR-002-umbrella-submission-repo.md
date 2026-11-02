# ADR-002: Public umbrella repo with submodules for submission

- Date: 2026-11-02
- Status: Proposed

## Context
The submission form accepts one public repo link. ADR-001 gives us many repos.

## Decision
Create a public `research-shop` umbrella repo. It holds a top-level README (problem, demo, how NEAR fits), `make demo`, and git submodules pointing to the public mirrors of each `rs-*` repo. Each local repo gets a GitHub remote once `gh` is authenticated.

## Consequence
Judges get one link, and each unit keeps its own history.
