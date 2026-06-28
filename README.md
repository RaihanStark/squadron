# 🛩 Squadron

**A local cockpit for commanding Claude agents across your fleet of GitHub repos.**

Stop the context-switch grind — opening a project, opening Claude, re-explaining what
to do, babysitting the change, pushing the PR. Squadron puts every repo on one screen:
browse the backlog, dispatch an autonomous agent at an issue, watch it work live, and
get a pull request back. One operator, many projects.

> ⚠️ Demo data below. The screenshots use a fictional `acme/*` fleet via demo mode
> (`?demo`) — your real repos never leave your machine.

## The cockpit

All your repos in one place, each with its open issues and PRs. Hit **⚡ Dispatch** on
any issue to send an agent at it.

![Squadron cockpit — repos, backlog, and dispatch](docs/cockpit.png)

## Plan first, then execute

You don't fire an agent blind. Clicking **📋 Plan** starts a **read-only** planning
session: the agent investigates the code and proposes a concrete plan, and you refine it
in a chat ("use Argon2id, not the keyring"). Nothing is written yet. When you're happy,
hit **✅ Approve & Dispatch** — the approved plan becomes the spec for an autonomous
execution run that edits the code, then opens a pull request. The plan rides along in the
PR description, so reviewers see the intended approach too.

![Squadron — an agent's proposed plan with the Approve & Dispatch gate](docs/agents.png)

This front-loads the one part where you add the most value — direction and scope — and
keeps execution (where agents are reliable) autonomous. During execution, an agent can
still **pause and ask you** via `ask_user` when a wrong assumption would be expensive,
resuming where it left off once you answer.

## Review PRs inline

Click any PR to see its diff in-app. **🤖 AI Review** runs a read-only agent over the
diff (PR checked out for context) and renders its findings as **inline comment cards
anchored to the exact lines** — severity-coded (bug / security / quality) — then post the
whole review to GitHub with one click.

![Squadron — in-app PR diff with inline AI review findings](docs/pr-review.png)

## What it does

- **Manage the backlog** — open issues across every repo, in one view
- **Plan → approve → PR** — scope an issue interactively, approve, and an autonomous
  agent implements it in an isolated git worktree and opens a pull request
- **Review PRs inline** — click a PR to see the diff in-app; **🤖 AI Review** renders the
  agent's findings as inline comment cards anchored to the exact lines, then post to GitHub
- **Watch agents live** — streamed reads / edits / commands, per agent, in parallel,
  with a live "working…" indicator so a quiet think never looks like a hang
- **Stay in the loop** — refine the plan in chat; agents call `ask_user` mid-execution
  when they need a decision
- **Pick the firepower** — Opus / Sonnet / Haiku per task
- **Cancel** any run mid-flight

## How it works

```
┌─────────────────────────────────────────────┐
│  web/  — Vite + React cockpit (the UI)       │
└───────────────┬─────────────────────────────┘
                │  HTTP + SSE (live stream)
┌───────────────▼─────────────────────────────┐
│  server/ — Node + Express                    │
│   • Claude Agent SDK (headless agents)       │
│   • git worktree per task (safe parallelism) │
│   • GitHub via the `gh` CLI                  │
└──────────────────────────────────────────────┘
```

- **Isolation:** every task runs on its own branch in its own git worktree (under
  `~/.squadron`, outside your projects), so multiple agents never collide — even on the
  same repo. A `PreToolUse` guard **confines each agent to its worktree**: any attempt to
  read, write, or `cd` outside it is blocked, even during autonomous execution.
- **Auth:** agents use your existing Claude Code login; GitHub flows through `gh`. No
  tokens to manage.
- **Desktop-ready:** the backend is structured to drop into an Electron main process
  later; today it runs as a local web app.

## Requirements

- Node 18+ (developed on 24)
- [`gh`](https://cli.github.com/) — authenticated (`gh auth status`)
- A working Claude Code login on the machine

## Run

```bash
npm run setup   # install root + web deps
npm run dev     # backend on :5174, cockpit on :5173
```

Open **http://localhost:5173**. To preview with demo data (no real repos touched):
**http://localhost:5173/?demo**

## Status

| Slice | Feature | State |
|------:|---------|:-----:|
| 1 | Cockpit — repos, backlog, PRs | ✅ |
| 2 | Execute — issue → worktree → live stream → PR | ✅ |
| 3 | Interactive `ask_user` — pause for clarification, resume on answer | ✅ |
| 4 | Per-task model picker (Opus / Sonnet / Haiku) | ✅ |
| 5 | Plan first — interactive read-only plan → Approve & Dispatch → execute | ✅ |
| 6 | PR review — read-only AI review of a diff → approve → post comment | ✅ |
| 7 | In-app diff viewer + inline AI review findings | ✅ |
| 8 | Parallel agents panel + run history | ⏳ |

## License

MIT
