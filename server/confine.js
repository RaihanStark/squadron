// A PreToolUse hook that confines an agent to its worktree. Fires even under
// bypassPermissions, so it's the real guardrail (not just prompt guidance)
// against an agent cd-ing into the user's real repos or reading the filesystem.
import path from 'node:path'

// Absolute paths an agent may legitimately touch outside the worktree.
const SAFE_ABS = [/^\/tmp\//, /^\/dev\/null$/, /^\/dev\/std(out|err)$/, /^\/var\/folders\//, /^\/private\/(tmp|var)\//]

export function makeConfineHook(worktree) {
  const ROOT = path.resolve(worktree)
  const inside = (p) => {
    const abs = path.resolve(ROOT, p) // relative paths resolve against ROOT; absolute paths win
    return abs === ROOT || abs.startsWith(ROOT + path.sep)
  }
  const deny = (reason) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })

  const hook = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const ti = input.tool_input || {}

    // Path-bearing tools: deny if the target escapes the worktree.
    const p = ti.file_path || ti.notebook_path || ti.path
    if (typeof p === 'string' && p && !inside(p)) {
      return deny(`"${p}" is outside your working directory. Stay within the checked-out repo and use relative paths.`)
    }

    // Bash: inspect the command for escapes.
    if (input.tool_name === 'Bash') {
      const cmd = String(ti.command || '')
      if (/\bfind\s+\/(?:\s|$)/.test(cmd)) {
        return deny('Do not search the whole filesystem. Everything you need is in the current directory.')
      }
      const cd = cmd.match(/\bcd\s+(\/[^\s"';|&]+)/)
      if (cd && !inside(cd[1])) {
        return deny(`Do not cd outside your working directory (tried ${cd[1]}). Everything is in the current directory.`)
      }
      // Any other absolute path that isn't a known-safe location.
      for (const m of cmd.matchAll(/(?:^|[\s"'=(])(\/[^\s"';|&)]+)/g)) {
        const ap = m[1]
        if (SAFE_ABS.some((re) => re.test(ap))) continue
        if (!inside(ap)) {
          return deny(`Command references "${ap}", outside your working directory. Work only within the repo using relative paths; do not access other locations.`)
        }
      }
    }
    return {}
  }

  return { PreToolUse: [{ hooks: [hook] }] }
}
