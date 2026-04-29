import fs from 'fs';
import path from 'path';
import { ChildProcess, exec, spawn } from 'child_process';
import util from 'util';
import type { PreparedWorkspace } from '../../domain/runtime.js';
import {
  resolveRuntimeManifest,
  getLocalIpAddress,
  type RuntimeServiceConfig,
} from './runtime-gate-config.js';

const execPromise = util.promisify(exec);

const activeProcesses: ChildProcess[] = [];

export interface RuntimeGateResult {
  localUrl: string | null;
  publicUrl: string | null;
  details: string;
  status: 'passed' | 'failed';
}

type RuntimeLogFn = (message: string) => Promise<void> | void;

async function emitRuntimeLog(onLog: RuntimeLogFn | undefined, message: string): Promise<void> {
  if (onLog) await onLog(message);
}

function killTrackedProcess(proc: ChildProcess | null): void {
  if (!proc?.pid) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    // Ignore cleanup errors.
  }
}

async function killPort(port: number): Promise<void> {
  await execPromise(`fuser -k ${port}/tcp || true`).catch(() => {});
}

function cleanupActiveProcesses(): void {
  for (const proc of activeProcesses) {
    killTrackedProcess(proc);
  }
  activeProcesses.length = 0;
}

function hasNodeModules(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

function getPackageManagerHint(dir: string): string {
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

function injectEnvVar(dir: string, key: string, value: string): void {
  const envPath = path.join(dir, '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  const pattern = new RegExp(`^${key}=.*$`, 'gm');
  content = content.replace(pattern, '').trim();
  content += `\n${key}=${value}\n`;
  fs.writeFileSync(envPath, content.trim() + '\n');
}

/**
 * Start a single service and wait for its readySignal.
 * Returns the spawned process or null on failure.
 */
async function startService(
  service: RuntimeServiceConfig,
  onLog?: RuntimeLogFn,
): Promise<{ proc: ChildProcess; log: string } | { error: string }> {
  // Pre-flight: check node_modules
  if (service.requiresNodeModules && !hasNodeModules(service.cwd)) {
    const details = `${service.name} prerequisites missing: node_modules not found in ${service.cwd}. Expected: ${getPackageManagerHint(service.cwd)}.`;
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${details}`);
    return { error: details };
  }

  // Kill existing port occupants
  await killPort(service.port);

  const [cmd, ...args] = service.startCommand.split(' ');
  await emitRuntimeLog(onLog, `🌐 [runtime:${service.name}] Starting \`${service.startCommand}\` in ${service.cwd}`);

  const env = { ...process.env, ...service.env };
  const proc = spawn(cmd, args, { cwd: service.cwd, stdio: 'pipe', env });
  activeProcesses.push(proc);

  let serviceLog = '';
  const onOutput = (data: Buffer | string) => {
    serviceLog += data.toString();
  };
  proc.stdout?.on('data', onOutput);
  proc.stderr?.on('data', onOutput);

  // Wait for ready signal or timeout
  const ready = await new Promise<boolean>((resolve) => {
    let resolved = false;

    const checkReady = () => {
      if (resolved) return;
      if (serviceLog.includes(service.readySignal)) {
        resolved = true;
        resolve(true);
      }
    };

    proc.stdout?.on('data', checkReady);
    proc.stderr?.on('data', checkReady);

    proc.on('exit', () => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, service.timeoutMs);

    // Also check what we've already accumulated
    checkReady();
  });

  if (!ready) {
    const exitCode = proc.exitCode;
    const trimmedLog = serviceLog.trim().slice(0, 1000);

    if (exitCode !== null) {
      const details = `${service.name} exited before ready. Exit code: ${exitCode}. Logs: ${trimmedLog}`;
      await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${details}`);
      return { error: details };
    }

    const details = `${service.name} failed to emit ready signal within ${service.timeoutMs}ms.${trimmedLog ? ` Logs: ${trimmedLog}` : ''}`;
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${details}`);
    return { error: details };
  }

  await emitRuntimeLog(onLog, `✅ [runtime:${service.name}] Ready on port ${service.port}.`);
  return { proc, log: serviceLog };
}

/**
 * Run the config-driven runtime gate.
 *
 * Starts all services defined in the manifest (backends first, frontends second),
 * links backend URL to frontend if configured, and reports overall health.
 */
export async function runProjectRuntimeGate(
  workspace: PreparedWorkspace,
  targetRoute = '/',
  onLog?: RuntimeLogFn,
): Promise<RuntimeGateResult> {
  // Cleanup any previous runtime processes
  cleanupActiveProcesses();

  const manifest = resolveRuntimeManifest(workspace.repoPath, workspace.expoPath, workspace.apiPath);

  if (manifest.services.length === 0) {
    await emitRuntimeLog(onLog, `🌐 [runtime] No runtime services detected. Skipping.`);
    return {
      localUrl: null,
      publicUrl: null,
      details: 'No runtime-capable app detected. Skipping runtime gate.',
      status: 'passed',
    };
  }

  const ip = getLocalIpAddress();

  // Sort: backends first, then frontends, then generic
  const sorted = [...manifest.services].sort((a, b) => {
    const order = { backend: 0, generic: 1, frontend: 2 };
    return (order[a.type] ?? 1) - (order[b.type] ?? 1);
  });

  await emitRuntimeLog(
    onLog,
    `🌐 [runtime] Preflight: ${sorted.length} service(s) to start: ${sorted.map((s) => `${s.name}(${s.type}:${s.port})`).join(', ')}`,
  );

  // Clear all ports
  for (const service of sorted) {
    await killPort(service.port);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  let backendUrl: string | null = null;

  for (const service of sorted) {
    // If linking is enabled and this is a frontend, inject backend URL
    if (
      manifest.linkBackendToFrontend &&
      service.type === 'frontend' &&
      backendUrl
    ) {
      injectEnvVar(service.cwd, manifest.backendUrlEnvVar, backendUrl);
      await emitRuntimeLog(onLog, `🌐 [runtime] Injected ${manifest.backendUrlEnvVar}=${backendUrl} into ${service.cwd}/.env`);
    }

    const result = await startService(service, onLog);

    if ('error' in result) {
      return {
        localUrl: null,
        publicUrl: null,
        details: result.error,
        status: 'failed',
      };
    }

    // Track backend URL for frontend injection
    if (service.type === 'backend') {
      backendUrl = ip ? `http://${ip}:${service.port}` : `http://localhost:${service.port}`;
    }
  }

  // Find the "primary" service for URL reporting (prefer frontend, fallback to first)
  const primary =
    sorted.find((s) => s.type === 'frontend') ||
    sorted[0];

  const route = targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`;
  const localUrl = `http://localhost:${primary.port}${route}`;
  const publicUrl = ip ? `http://${ip}:${primary.port}${route}` : null;

  await emitRuntimeLog(onLog, `✅ [runtime] All ${sorted.length} service(s) healthy. Primary: ${localUrl}`);

  return {
    localUrl,
    publicUrl,
    details: `Runtime available at ${localUrl}. Services: ${sorted.map((s) => s.name).join(', ')}.`,
    status: 'passed',
  };
}
