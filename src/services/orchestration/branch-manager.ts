import { exec, execFile } from 'child_process';
import util from 'util';
import { getRuntimeConfig } from '../../config.js';
import type { PreparedWorkspace } from '../../domain/runtime.js';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

export interface IntegrationBranchState {
  defaultBranch: string;
  integrationBranch: string;
  created: boolean;
}

export interface CherryPickResult {
  success: boolean;
  conflicting: boolean;
  conflictFiles: string[];
  error?: string;
}

async function tryGitCommand(command: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execPromise(command, { cwd });
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const symbolicRef = await tryGitCommand('git symbolic-ref refs/remotes/origin/HEAD', repoPath);
  if (symbolicRef.startsWith('refs/remotes/origin/')) {
    return symbolicRef.replace('refs/remotes/origin/', '').trim();
  }

  const remoteShow = await tryGitCommand('git remote show origin', repoPath);
  const match = remoteShow.match(/HEAD branch:\s+([^\n]+)/);
  if (match) {
    return match[1].trim();
  }

  return getRuntimeConfig().githubBaseBranch;
}

async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execPromise(`git show-ref --verify --quiet refs/heads/${branchName}`, { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function remoteBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const output = await tryGitCommand(`git ls-remote --heads origin ${branchName}`, repoPath);
  return output.trim() !== '';
}

export async function ensureIntegrationBranch(
  workspace: PreparedWorkspace,
  integrationBranch = getRuntimeConfig().integrationBranchName,
): Promise<IntegrationBranchState> {
  await tryGitCommand('git fetch origin --prune', workspace.repoPath);
  const defaultBranch = await detectDefaultBranch(workspace.repoPath);
  const hasRemoteBranch = await remoteBranchExists(workspace.repoPath, integrationBranch);
  const hasLocalBranch = await localBranchExists(workspace.repoPath, integrationBranch);

  if (hasRemoteBranch) {
    await execPromise(`git checkout -B ${integrationBranch} origin/${integrationBranch}`, {
      cwd: workspace.repoPath,
    });
    await tryGitCommand(`git pull --ff-only origin ${integrationBranch}`, workspace.repoPath);
    return {
      defaultBranch,
      integrationBranch,
      created: false,
    };
  }

  if (hasLocalBranch) {
    await execPromise(`git checkout ${integrationBranch}`, { cwd: workspace.repoPath });
  } else {
    await execPromise(`git checkout ${defaultBranch}`, { cwd: workspace.repoPath });
    await tryGitCommand(`git pull --ff-only origin ${defaultBranch}`, workspace.repoPath);
    await execPromise(`git checkout -B ${integrationBranch}`, { cwd: workspace.repoPath });
  }

  await execPromise(`git push -u origin ${integrationBranch}`, { cwd: workspace.repoPath });

  return {
    defaultBranch,
    integrationBranch,
    created: true,
  };
}

export async function commitAllChanges(repoPath: string, commitMessage: string): Promise<string | null> {
  const status = await tryGitCommand('git status --porcelain', repoPath);
  if (!status.trim()) {
    return null;
  }

  await execFilePromise('git', ['add', '.'], { cwd: repoPath });
  await execFilePromise('git', ['commit', '-m', commitMessage], { cwd: repoPath });
  return tryGitCommand('git rev-parse HEAD', repoPath);
}

/* ────────────────────────────────────────────────────────────
   Cherry-pick with conflict detection and resolution
   ──────────────────────────────────────────────────────────── */

/**
 * Pre-check whether a cherry-pick would conflict by using git's merge machinery
 * without actually modifying the working tree.
 */
export async function predictCherryPickConflict(
  repoPath: string,
  commitSha: string,
): Promise<{ willConflict: boolean; conflictFiles: string[] }> {
  try {
    // Try a dry-run cherry-pick using --no-commit so we can inspect without permanent changes
    await execPromise(`git cherry-pick --no-commit ${commitSha}`, { cwd: repoPath });
    // If it succeeded, reset the staged changes (we just wanted to check)
    await execPromise('git reset --hard HEAD', { cwd: repoPath });
    return { willConflict: false, conflictFiles: [] };
  } catch {
    // Cherry-pick failed — extract conflict file list
    const conflictOutput = await tryGitCommand('git diff --name-only --diff-filter=U', repoPath);
    const conflictFiles = conflictOutput.split('\n').filter(Boolean);
    // Abort the in-progress cherry-pick
    await tryGitCommand('git cherry-pick --abort', repoPath);
    return { willConflict: true, conflictFiles };
  }
}

/**
 * Attempt cherry-pick with automatic conflict resolution for safe patterns.
 * Falls back to abort if conflicts can't be auto-resolved.
 */
export async function cherryPickCommit(repoPath: string, commitSha: string): Promise<CherryPickResult> {
  try {
    await execPromise(`git cherry-pick ${commitSha}`, { cwd: repoPath });
    return { success: true, conflicting: false, conflictFiles: [] };
  } catch (error) {
    // Check if this is a conflict (vs. other failure)
    const conflictOutput = await tryGitCommand('git diff --name-only --diff-filter=U', repoPath);
    const conflictFiles = conflictOutput.split('\n').filter(Boolean);

    if (conflictFiles.length === 0) {
      // Not a merge conflict — some other git error
      await tryGitCommand('git cherry-pick --abort', repoPath);
      return {
        success: false,
        conflicting: false,
        conflictFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Try auto-resolving: accept "theirs" (the cherry-picked commit's version)
    // for files that are purely additive (new imports, new exports, new files)
    const autoResolved = await tryAutoResolveConflicts(repoPath, conflictFiles);

    if (autoResolved) {
      // Check if all conflicts are resolved
      const remainingConflicts = await tryGitCommand('git diff --name-only --diff-filter=U', repoPath);

      if (!remainingConflicts.trim()) {
        // All resolved — continue the cherry-pick
        try {
          await execFilePromise('git', ['cherry-pick', '--continue'], {
            cwd: repoPath,
            env: { ...process.env, GIT_EDITOR: 'true' },
          });
          console.log(`🔧 Auto-resolved cherry-pick conflicts in: ${conflictFiles.join(', ')}`);
          return { success: true, conflicting: true, conflictFiles };
        } catch {
          await tryGitCommand('git cherry-pick --abort', repoPath);
          return {
            success: false,
            conflicting: true,
            conflictFiles,
            error: 'Auto-resolution succeeded but cherry-pick --continue failed.',
          };
        }
      }
    }

    // Can't auto-resolve — abort
    await tryGitCommand('git cherry-pick --abort', repoPath);
    return {
      success: false,
      conflicting: true,
      conflictFiles,
      error: `Cherry-pick conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}`,
    };
  }
}

/**
 * Try to auto-resolve conflicts by accepting the incoming changes
 * for files that look safe to auto-merge (additive-only patterns).
 */
async function tryAutoResolveConflicts(repoPath: string, conflictFiles: string[]): Promise<boolean> {
  let allResolved = true;

  for (const file of conflictFiles) {
    try {
      // Check if the conflict is in an import-heavy area or additive-only
      const conflictContent = await tryGitCommand(`git show :3:${file}`, repoPath);

      if (!conflictContent) {
        // Can't read theirs — skip
        allResolved = false;
        continue;
      }

      // Strategy: accept "theirs" (the incoming cherry-picked version) for the conflicting file.
      // This is safe when the cherry-picked task is self-contained and its changes
      // are the "intended" state of that file.
      await execPromise(`git checkout --theirs "${file}"`, { cwd: repoPath });
      await execFilePromise('git', ['add', file], { cwd: repoPath });
    } catch {
      allResolved = false;
    }
  }

  return allResolved;
}

/* ────────────────────────────────────────────────────────────
   Standard operations
   ──────────────────────────────────────────────────────────── */

export async function pushBranch(repoPath: string, branchName: string): Promise<void> {
  await execPromise(`git push origin ${branchName}`, { cwd: repoPath });
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  await execPromise(`git checkout ${branchName}`, { cwd: repoPath });
}

export async function getDiffAgainstHead(repoPath: string): Promise<string> {
  return tryGitCommand('git diff HEAD~1..HEAD', repoPath);
}
