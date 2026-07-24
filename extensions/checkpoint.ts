import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────

interface CheckpointData {
  /** Snapshot creation timestamp */
  timestamp: number;
  /** Git commit hash of the snapshot */
  commitHash: string;
  /** Absolute path to the worktree containing the snapshot */
  worktreePath: string;
  /** The user prompt that triggered this checkpoint (for display) */
  prompt?: string;
  /** Whether this is a redo-point (created during /undo) */
  isRedoPoint?: boolean;
}

interface CheckpointState {
  /** The latest pre-agent checkpoint (what /undo restores to) */
  preAgent: CheckpointData | null;
  /** The redo-point (what /redo restores to), created during /undo */
  redoPoint: CheckpointData | null;
}

// ── Git utilities ────────────────────────────────────────────────

async function findGitRoot(root: string, pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 5000 });
  if (result.code === 0) {
    const dir = result.stdout.trim();
    return dir.length > 0 ? dir : null;
  }
  return null;
}

/**
 * Create a snapshot of the current working tree state using a git worktree.
 *
 * 1. Creates a detached worktree at a temp directory
 * 2. Rsyncs the current working tree into it (excluding .git)
 * 3. Commits everything in the worktree
 * 4. Returns the snapshot metadata
 */
async function createSnapshot(
  gitRoot: string,
  pi: ExtensionAPI,
  prompt?: string,
): Promise<CheckpointData> {
  const id = randomUUID().slice(0, 8);
  const timestamp = Date.now();
  const worktreePath = join(tmpdir(), `pi-checkpoint-${id}-${timestamp}`);

  // Create detached worktree at current HEAD
  const addResult = await pi.exec("git", [
    "worktree", "add", "--detach", worktreePath, "HEAD",
  ], { cwd: gitRoot, timeout: 15000 });

  if (addResult.code !== 0) {
    throw new Error(`Failed to create worktree: ${addResult.stderr}`);
  }

  try {
    // Sync current working tree state into the worktree
    // Using rsync with --delete ensures the worktree exactly matches the source
    const rsyncResult = await pi.exec("rsync", [
      "-a", "--delete",
      "--exclude=.git",
      "--exclude=.pi/checkpoints",
      `${gitRoot}/`, `${worktreePath}/`,
    ], { cwd: gitRoot, timeout: 30000 });

    if (rsyncResult.code !== 0) {
      throw new Error(`Failed to sync files: ${rsyncResult.stderr}`);
    }

    // Stage everything in the worktree
    const addAllResult = await pi.exec("git", ["-C", worktreePath, "add", "-A"], { cwd: gitRoot, timeout: 10000 });
    if (addAllResult.code !== 0) {
      throw new Error(`Failed to stage: ${addAllResult.stderr}`);
    }

    // Commit the snapshot
    const msg = prompt
      ? `pi-ckpt: ${prompt.slice(0, 120)} [${timestamp}]`
      : `pi-ckpt: auto-snapshot [${timestamp}]`;

    const commitResult = await pi.exec("git", [
      "-C", worktreePath, "commit", "-m", msg, "--allow-empty",
    ], { cwd: gitRoot, timeout: 10000 });

    if (commitResult.code !== 0) {
      throw new Error(`Failed to commit: ${commitResult.stderr}`);
    }

    // Get the commit hash
    const hashResult = await pi.exec("git", ["-C", worktreePath, "rev-parse", "HEAD"], { cwd: gitRoot, timeout: 5000 });
    const commitHash = hashResult.stdout.trim();

    if (!commitHash) {
      throw new Error("Failed to get commit hash");
    }

    return { timestamp, commitHash, worktreePath, prompt };
  } catch (err) {
    // Clean up worktree on failure
    await pi.exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: gitRoot, timeout: 10000 }).catch(() => {});
    throw err;
  }
}

/**
 * Restore working tree to match a snapshot, then remove the worktree.
 *
 * Uses rsync to copy files back (same directories as used in createSnapshot,
 * so .git and .pi/checkpoints are preserved). Then removes the worktree.
 */
async function restoreSnapshot(
  gitRoot: string,
  data: CheckpointData,
  pi: ExtensionAPI,
): Promise<void> {
  if (!existsSync(data.worktreePath)) {
    throw new Error(`Snapshot worktree no longer exists: ${data.worktreePath}`);
  }

  // Restore files from snapshot back to the main working tree
  const rsyncResult = await pi.exec("rsync", [
    "-a", "--delete",
    "--exclude=.git",
    "--exclude=.pi/checkpoints",
    `${data.worktreePath}/`, `${gitRoot}/`,
  ], { cwd: gitRoot, timeout: 30000 });

  if (rsyncResult.code !== 0) {
    throw new Error(`Failed to restore files: ${rsyncResult.stderr}`);
  }

  // Remove the worktree
  const removeResult = await pi.exec("git", [
    "worktree", "remove", "--force", data.worktreePath,
  ], { cwd: gitRoot, timeout: 10000 });

  if (removeResult.code !== 0) {
    console.warn(`[pi-checkpoint] Failed to remove worktree: ${removeResult.stderr}`);
  }
}

/**
 * Rebuild checkpoint state by scanning session custom entries.
 */
function rebuildState(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): CheckpointState {
  const state: CheckpointState = { preAgent: null, redoPoint: null };

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-checkpoint") continue;
    const data = entry.data as CheckpointData | undefined;
    if (!data || !data.commitHash || !data.worktreePath) continue;

    if (data.isRedoPoint) {
      state.redoPoint = data;
    } else {
      state.preAgent = data;
    }
  }

  // Verify worktree dirs still exist
  if (state.preAgent && !existsSync(state.preAgent.worktreePath)) {
    state.preAgent = null;
  }
  if (state.redoPoint && !existsSync(state.redoPoint.worktreePath)) {
    state.redoPoint = null;
  }

  return state;
}

// ── Extension Factory ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let gitRoot: string | null = null;
  let state: CheckpointState = { preAgent: null, redoPoint: null };

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    // Find git root
    gitRoot = await findGitRoot(ctx.cwd, pi);

    if (!gitRoot) {
      ctx.ui.notify("pi-ckpt: not a git repo — /undo and /redo unavailable", "warning");
      return;
    }

    // Rebuild state from session custom entries
    state = rebuildState(ctx.sessionManager.getEntries());

    // Notify about available actions
    const parts: string[] = [];
    if (state.preAgent) parts.push("undo ready");
    if (state.redoPoint) parts.push("redo ready");
    const status = parts.length > 0 ? parts.join(", ") : "ready";
    ctx.ui.notify(`pi-ckpt: ${status}`, "info");
  });

  // ── Auto-checkpoint before each agent turn ──

  pi.on("before_agent_start", async (event, ctx) => {
    if (!gitRoot) return;

    // Skip if there's an active undo/redo workflow that hasn't been resolved
    if (state.redoPoint && !state.preAgent) {
      // We've undone and haven't checkpointed again yet. Create a fresh checkpoint
      // so the new turn can be undone independently.
    }

    try {
      const snapshot = await createSnapshot(gitRoot, pi, event.prompt);

      // Store in session
      pi.appendEntry("pi-checkpoint", snapshot);

      // Update in-memory state
      state.preAgent = snapshot;
      // Clear redo when a new turn starts (redo only works for the immediate undo)
      state.redoPoint = null;

      ctx.ui.setStatus("pi-ckpt", "checkpointed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pi-checkpoint] Auto-checkpoint failed: ${msg}`);
    }
  });

  // Clear status when agent is done
  pi.on("agent_settled", async (_event, _ctx) => {
    // Status is kept so the user knows they can undo
  });

  // ── /undo command ──

  pi.registerCommand("undo", {
    description: "Undo file changes made by the last agent turn",
    handler: async (_args, ctx) => {
      if (!gitRoot) {
        ctx.ui.notify("pi-ckpt: not a git repo — can't undo", "error");
        return;
      }

      if (!state.preAgent) {
        ctx.ui.notify("pi-ckpt: nothing to undo (no checkpoint found)", "warning");
        return;
      }

      try {
        // Step 1: Snapshot the current (agent-modified) state for redo
        ctx.ui.notify("pi-ckpt: creating redo-point...", "info");
        const redoSnapshot = await createSnapshot(gitRoot, pi);
        const redoData: CheckpointData = { ...redoSnapshot, isRedoPoint: true };

        // Step 2: Restore the pre-agent snapshot
        ctx.ui.notify("pi-ckpt: restoring pre-agent state...", "info");
        await restoreSnapshot(gitRoot, state.preAgent, pi);

        // Step 3: Update state
        state.redoPoint = redoData;
        state.preAgent = null; // Can't undo again since we consumed it

        // Step 4: Persist redo-point in session
        pi.appendEntry("pi-checkpoint", redoData);

        // Step 5: Clear status
        ctx.ui.setStatus("pi-ckpt", undefined);

        ctx.ui.notify("pi-ckpt: undone — files restored to pre-agent state", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-ckpt: undo failed — ${msg}`, "error");
      }
    },
  });

  // ── /redo command ──

  pi.registerCommand("redo", {
    description: "Redo the last undone agent turn's file changes",
    handler: async (_args, ctx) => {
      if (!gitRoot) {
        ctx.ui.notify("pi-ckpt: not a git repo — can't redo", "error");
        return;
      }

      if (!state.redoPoint) {
        ctx.ui.notify("pi-ckpt: nothing to redo (no undone checkpoint)", "warning");
        return;
      }

      try {
        // Restore the redo-point snapshot
        ctx.ui.notify("pi-ckpt: restoring agent changes...", "info");
        await restoreSnapshot(gitRoot, state.redoPoint, pi);

        // Clear redo state (single-level)
        state.redoPoint = null;

        ctx.ui.notify("pi-ckpt: redone — agent changes restored", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-ckpt: redo failed — ${msg}`, "error");
      }
    },
  });

  // ── Cleanup on shutdown ──

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Prune stale worktrees (ones we left behind)
    if (gitRoot) {
      await pi.exec("git", ["worktree", "prune"], { cwd: gitRoot, timeout: 5000 }).catch(() => {});
    }
  });
}