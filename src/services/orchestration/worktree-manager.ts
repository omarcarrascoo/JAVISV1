import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import type { PreparedWorkspace, WorkspaceProject } from '../../domain/runtime.js';
import { resolveWorkspace } from '../../git.js';

const execPromise = util.promisify(exec);

/**
 * Simple async mutex to prevent concurrent worktree operations
 * (create/remove/prune) from interfering with each other.
 */
class WorktreeMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const worktreeMutex = new WorktreeMutex();

export interface TaskWorktree {
  branchName: string;
  workspace: PreparedWorkspace;
  worktreePath: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function pathExistsNoFollow(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function removePathIfExists(targetPath: string): void {
  if (pathExistsNoFollow(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function resolveUsableDirectory(source: string): string | null {
  try {
    const stat = fs.lstatSync(source);

    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(source);
      const resolvedStat = fs.statSync(resolved);
      return resolvedStat.isDirectory() ? resolved : null;
    }

    return stat.isDirectory() ? source : null;
  } catch {
    return null;
  }
}

function isSelfReferentialLink(targetPath: string): boolean {
  try {
    if (!fs.lstatSync(targetPath).isSymbolicLink()) {
      return false;
    }

    const linkTarget = fs.readlinkSync(targetPath);
    const resolvedLinkTarget = path.resolve(path.dirname(targetPath), linkTarget);
    return resolvedLinkTarget === path.resolve(targetPath);
  } catch {
    return false;
  }
}

function createSymlinkIfMissing(source: string, target: string): void {
  const usableSource = resolveUsableDirectory(source);
  if (!usableSource) {
    return;
  }

  if (pathExistsNoFollow(target)) {
    if (isSelfReferentialLink(target)) {
      removePathIfExists(target);
    } else {
      return;
    }
  }

  const resolvedTarget = path.resolve(target);
  if (path.resolve(usableSource) === resolvedTarget) {
    return;
  }

  fs.symlinkSync(usableSource, target, 'dir');
}

function copyEnvFileIfPresent(sourceDir: string, targetDir: string): void {
  const sourceEnv = path.join(sourceDir, '.env');
  const targetEnv = path.join(targetDir, '.env');

  if (fs.existsSync(sourceEnv) && !pathExistsNoFollow(targetEnv)) {
    fs.copyFileSync(sourceEnv, targetEnv);
  }
}

/**
 * Check if a task's write scope includes dependency files (package.json, lock files).
 * If so, the task might modify dependencies and needs its own node_modules.
 */
function taskMayModifyDependencies(writeScope: string[]): boolean {
  if (!writeScope.length || writeScope.includes('.')) return false;

  const depPatterns = ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

  return writeScope.some((scope) =>
    depPatterns.some((pattern) => scope.includes(pattern) || scope === '.'),
  );
}

/**
 * Install dependencies in the worktree directory instead of symlinking.
 * Used when the task may modify package.json.
 */
async function installWorktreeDependencies(packageDir: string): Promise<void> {
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) return;

  console.log(`📦 Installing isolated dependencies in ${path.basename(packageDir)}...`);
  await execPromise('npm install --prefer-offline', { cwd: packageDir, timeout: 120000 }).catch((err) => {
    console.log(`⚠️ Dependency install failed in ${packageDir}: ${err.message}`);
  });
}

function syncLocalSupportFiles(
  baseWorkspace: PreparedWorkspace,
  taskWorkspace: PreparedWorkspace,
  isolateDependencies: boolean,
): void {
  copyEnvFileIfPresent(baseWorkspace.repoPath, taskWorkspace.repoPath);

  for (const basePackageDir of baseWorkspace.packageDirs) {
    const relativeDir = path.relative(baseWorkspace.repoPath, basePackageDir);
    const taskPackageDir = path.join(taskWorkspace.repoPath, relativeDir);

    ensureDir(taskPackageDir);
    copyEnvFileIfPresent(basePackageDir, taskPackageDir);

    if (!isolateDependencies) {
      createSymlinkIfMissing(path.join(basePackageDir, 'node_modules'), path.join(taskPackageDir, 'node_modules'));
    }
  }
}

export async function createTaskWorktree(
  baseWorkspace: PreparedWorkspace,
  runId: string,
  taskId: string,
  baseRef: string,
  writeScope: string[] = [],
): Promise<TaskWorktree> {
  await worktreeMutex.acquire();
  try {
    const worktreesRoot = path.join(baseWorkspace.workspaceDir, '.unity-worktrees', runId);
    const worktreePath = path.join(worktreesRoot, taskId);
    const branchName = `unity-task-${runId}-${taskId}`.slice(0, 120);

    ensureDir(worktreesRoot);
    await execPromise('git worktree prune', { cwd: baseWorkspace.repoPath }).catch(() => {});
    await execPromise(`git worktree remove --force "${worktreePath}"`, {
      cwd: baseWorkspace.repoPath,
    }).catch(() => {});
    removePathIfExists(worktreePath);

    await execPromise(`git worktree add -B ${branchName} "${worktreePath}" ${baseRef}`, {
      cwd: baseWorkspace.repoPath,
    });

    const taskProject: WorkspaceProject = {
      name: baseWorkspace.name,
      repoPath: worktreePath,
      workspaceDir: baseWorkspace.workspaceDir,
    };

    const taskWorkspace = await resolveWorkspace(taskProject);
    const isolateDeps = taskMayModifyDependencies(writeScope);
    syncLocalSupportFiles(baseWorkspace, taskWorkspace, isolateDeps);

    if (isolateDeps) {
      // Install dependencies in each package dir for full isolation
      for (const packageDir of taskWorkspace.packageDirs) {
        await installWorktreeDependencies(packageDir);
      }
      console.log(`📦 Task ${taskId} has isolated node_modules (write scope touches dependencies).`);
    }

    return {
      branchName,
      workspace: taskWorkspace,
      worktreePath,
    };
  } finally {
    worktreeMutex.release();
  }
}

export async function removeTaskWorktree(baseRepoPath: string, worktreePath: string): Promise<void> {
  await worktreeMutex.acquire();
  try {
    await execPromise(`git worktree remove --force "${worktreePath}"`, { cwd: baseRepoPath }).catch(() => {});
    removePathIfExists(worktreePath);
  } finally {
    worktreeMutex.release();
  }
}
