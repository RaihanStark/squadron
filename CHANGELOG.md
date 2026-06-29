# Changelog

All notable changes to Squadron are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-06-29

### Added

- **Verifier subagent.** A Bash-capable verifier specialist now runs the
  project's tests, build, and lint and returns a concise PASS/FAIL verdict, so
  the lead agent gets an independent check on its own work instead of trusting
  its summary. Verifier delegation is wired into the runner prompts.
- **Scout subagent on a cheaper model.** A read-only `scout` subagent (Haiku)
  handles delegated codebase exploration, letting the lead agent fan out
  searches to a cheaper, faster model and save tokens on every run. Subagent
  activity renders as indented junior-rank lines without clobbering the lead
  agent's stream.
- **System status bar.** A new bottom-right pill polls `/api/status` every
  minute and reports `gh` auth status and Claude Code subscription (Max/Pro)
  health, revealing per-check details on hover or click.

### Changed

- **Subagents gated by permission mode.** Planning sessions are restricted to
  the read-only scout via `subagentsFor()`, while write-capable runs get the
  full subagent set including the verifier.
- **Forced submit tool calls replace regex JSON scraping.** The Marshal
  (`submit_choice`), change namer (`submit_change_name`), and PR reviewer
  (`submit_review`) now return validated arguments through typed submit tools
  instead of fenced-JSON regex parsing — more reliable structured output and
  fewer tokens. Drops `parseChoice`, `parseChangeName`, and `parseReview`.

### Fixed

- Show **Create PR** and the other "your move" actions (not just Cancel) when an
  agent reaches that state after a successful run (#46).

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
