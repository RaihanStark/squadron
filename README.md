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

You don't fire an agent blind, and nothing reaches GitHub without you. Clicking
**📋 Plan** starts a **read-only** planning session: the agent investigates the code and
proposes a concrete plan, and you refine it in a chat ("use Argon2id, not the keyring").
Nothing is written yet. When you're happy, hit **✅ Approve & Dispatch** — the approved
plan drives an autonomous execution run that edits the code and **commits it locally in an
isolated worktree, without pushing**.

![Squadron — an agent's proposed plan with the Approve & Dispatch gate](docs/agents.png)

The result lands in **Ready to Review** as local changes. You open it, read the full diff
of what the agent did, and then either **⬆ Push & Open PR**, **discard**, or **💬 request
more changes** — the agent re-runs in the same worktree, revises, and you re-review (it can
pause to ask you mid-revision). So the flow is **plan → approve → review → (iterate) →
push** — nothing leaves your machine until you say so.

Ready to Review is a **mini-IDE**: the diff is the editor, a resizable **Agent chat** on
the right drives revisions (always-on input, interrupt anytime), and a collapsible
**Preview & Logs** dock sits at the bottom.

![Squadron — the Ready-to-Review mini-IDE: diff, agent chat, preview dock](docs/ide.png)

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

- **Manage the backlog** — open issues across every repo, in one view; open any item to
  read its full detail
- **Draft backlog items** — create issues right in Squadron and either **save locally**
  (kept in Squadron, not on GitHub) or **create on GitHub**; promote a local draft later
- **Plan → approve → review → PR** — scope an issue interactively, approve, and an
  autonomous agent implements it locally in an isolated worktree; you review the diff in
  **Ready to Review** and push to open the PR when it's right
- **Live preview before push** — from a Ready-to-Review change, **▶ Start** runs that
  worktree's dev command (auto-detected: npm / go / cargo / make, or set your own) and
  streams logs; if it serves a web URL it's embedded in an iframe, otherwise the process
  just runs (a Go/Fyne-style desktop window opens on your machine)
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

## Install (desktop app)

Grab the latest **`.rpm`** from [Releases](https://github.com/RaihanStark/squadron/releases) and install it:

```bash
sudo dnf install ./Squadron-0.1.0.x86_64.rpm   # Fedora/RHEL
# or: sudo rpm -i ./Squadron-*.rpm
```

Then launch **Squadron** from your app menu. It still needs `gh` (authenticated) and a
Claude Code login on the machine. Releases are built from source by GitHub Actions.

## Run from source (dev)

```bash
npm run setup   # install root + web deps
npm run dev     # backend on :5174, cockpit on :5173
npm run electron  # or run it as the desktop app (after `npm run build:web`)
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
| 8 | Review-before-push — agent commits locally → review diff → push to PR | ✅ |
| 9 | Create backlog items (local draft or GitHub) + issue detail view | ✅ |
| 10 | Live preview — run a Ready-to-Review worktree (web iframe / desktop / logs) | ✅ |
| 11 | Parallel agents panel + run history | ⏳ |

## License

MIT
