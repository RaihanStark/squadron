# Changelog

All notable changes to Squadron are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-06-29

### Added

- **Agents as a squadron — reuse context to save tokens.** Agents are now
  persistent "persons": a stable agent that carries its Claude session forward
  across tasks under a Top Gun-style callsign (Maverick, Goose, Iceman, …). When
  you dispatch a new errand or plan, the **Marshal** auto-assigns the best
  agent — continuing one whose context already fits the repo, or starting a fresh
  one. Reusing an agent **resumes its prior Claude session**, so it keeps what it
  already learned about the codebase instead of cold-starting a full
  re-exploration — that skipped file-tree dump and re-reading is real token (and
  time) savings on every follow-up task.
  - **Agent picker** on dispatch/errand: `🎖 Marshal — auto-assign` (default),
    `🆕 New agent` (force a clean session), or pin a specific person; agents that
    already know the repo are surfaced first.
  - **Guardrails on reuse:** only recently-active (≤ 12h), healthy, repo-exploring
    sessions (`plan` / `errand`) are eligible — past that, replaying a stale,
    bloated transcript can cost more than the re-exploration it saves, so Squadron
    cold-starts instead. Each task still runs in a **fresh, isolated worktree**,
    and if a saved session was pruned from disk the run transparently falls back
    to a cold start.
- **Dismiss inactive agents.** Finished, cancelled, errored, or interrupted
  agents can be dismissed from the Agents panel — individually with the `×`
  control, or in bulk via **Clear N inactive** — reclaiming their worktrees and
  history. New `DELETE` and clear-inactive API routes back the UI controls.
