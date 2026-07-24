# pi-checkpoint

**Undo/redo for [pi](https://pi.dev) agent turns.** Automatically snapshots your working tree before each LLM turn using `git worktree`, so you can revert file changes made by the agent with `/undo` and restore them with `/redo`.

## How it works

Before each LLM turn, pi-checkpoint creates a detached git worktree at a temp directory, syncs the current working tree state into it via `rsync`, and commits the snapshot. The main repository's index and stash are never touched — only your working files are copied.

| Command | What it does |
|---------|-------------|
| `/undo`  | Snapshots the current (agent-modified) state for redo, then restores pre-agent files. New files created by the agent are removed. |
| `/redo`  | Restores the undo-point snapshot, reapplying the agent's changes. Single-level: only the most recent undo can be redone. |

### Benefits over `git stash` / `git add -A`

- **Does not touch git index or stash** — your staged and unstaged changes survive intact
- **Captures untracked files** — `rsync -a --delete` ensures the snapshot is a perfect mirror
- **No commit pollution** — snapshots live in isolated worktrees, not on your active branch
- **Survives crashes** — abandoned worktrees are pruned on session shutdown

## Requirements

- **git** ≥ 2.5 (for `git worktree`)
- **rsync** (for file-level snapshots)
- A git repository (the extension warns if you're not in one)

## Install

### Via pi (recommended)

```bash
pi install https://github.com/karlrobeck/pi-checkpoint@v0.1.0
```

### Via local path (for development)

```bash
git clone https://github.com/karlrobeck/pi-checkpoint.git
pi install ./pi-checkpoint
```

### Via --extension (one-shot)

```bash
pi -e ./path/to/extensions/checkpoint.ts
```

## Usage

Start pi in a git repository. The extension auto-loads and creates a checkpoint before every turn.

```
pi
╭─────────────────────────────────────╮
│ pi-ckpt: ready                      │
│                                     │
│ $ Tell the agent to modify files... │
╰─────────────────────────────────────╯
```

After the agent finishes making changes:

```
/undo    → Restores files to pre-agent state
/redo    → Restores the agent's changes (if you just undid)
```

## Behavior details

- **Auto-checkpointing**: A snapshot is created on `before_agent_start`, before each LLM turn begins.
- **Single-level redo**: After a new turn starts (even a user message), the redo-point is cleared. You can only redo the immediate `/undo`.
- **Session persistence**: Checkpoint metadata is stored in the session file as `custom` entries. On restart, the extension rebuilds its state from these entries.
- **Cleanup**: Stale worktrees are pruned on `session_shutdown`.

## License

MIT © 2026 Karl Robeck Alferez