/**
 * Runtime Gate Configuration — replaces hardcoded Expo/NestJS detection
 * with a config-driven approach.
 *
 * Config can be:
 * 1. Auto-detected from package.json dependencies (backward-compatible)
 * 2. Manually specified in `.unity/gates.json`
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface RuntimeServiceConfig {
  /** Display name for logs */
  name: string;
  /** Working directory relative to repo root (e.g. "apps/mobile", "apps/api") */
  cwd: string;
  /** Command to start the service */
  startCommand: string;
  /** String or regex pattern in stdout/stderr that signals readiness */
  readySignal: string;
  /** Port the service listens on */
  port: number;
  /** Optional health check URL to verify after readySignal */
  healthCheck?: string;
  /** Max time to wait for readySignal (ms) */
  timeoutMs: number;
  /** Whether this service requires node_modules to be present */
  requiresNodeModules: boolean;
  /** Service type hint for special handling */
  type: 'frontend' | 'backend' | 'generic';
  /** Environment variables to inject before starting */
  env?: Record<string, string>;
}

export interface RuntimeGateManifest {
  /** Services to start, in order (backends first, frontends second) */
  services: RuntimeServiceConfig[];
  /** If true, inject backend URL into frontend .env */
  linkBackendToFrontend: boolean;
  /** Environment variable name for injecting backend URL into frontend */
  backendUrlEnvVar: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function getLocalIpAddress(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

/**
 * Try to load a manual config from `.unity/gates.json`.
 */
function loadManualConfig(repoPath: string): RuntimeGateManifest | null {
  const configPath = path.join(repoPath, '.unity', 'gates.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw.services || !Array.isArray(raw.services)) return null;

    return {
      services: raw.services.map((s: any) => ({
        name: s.name || 'service',
        cwd: s.cwd || '.',
        startCommand: s.startCommand || s.start_command || 'npm start',
        readySignal: s.readySignal || s.ready_signal || 'listening',
        port: Number(s.port) || 3000,
        healthCheck: s.healthCheck || s.health_check,
        timeoutMs: Number(s.timeoutMs || s.timeout_ms) || DEFAULT_TIMEOUT_MS,
        requiresNodeModules: s.requiresNodeModules !== false,
        type: s.type || 'generic',
        env: s.env,
      })),
      linkBackendToFrontend: raw.linkBackendToFrontend ?? raw.link_backend_to_frontend ?? false,
      backendUrlEnvVar: raw.backendUrlEnvVar || raw.backend_url_env_var || 'EXPO_PUBLIC_API_URL',
    };
  } catch {
    return null;
  }
}

/**
 * Read package.json from a directory and return parsed content.
 */
function readPackageJson(dir: string): Record<string, any> | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasExpoApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.dependencies?.expo || pkg?.devDependencies?.expo);
}

function hasNestApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(
    pkg?.dependencies?.['@nestjs/core'] || pkg?.devDependencies?.['@nestjs/core'],
  );
}

function hasNextApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);
}

function hasViteApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.dependencies?.vite || pkg?.devDependencies?.vite);
}

/**
 * Auto-detect runtime services from the workspace structure.
 * Backward-compatible with the existing Expo/NestJS detection.
 */
function autoDetectServices(
  repoPath: string,
  expoPath: string,
  apiPath: string | null,
): RuntimeServiceConfig[] {
  const services: RuntimeServiceConfig[] = [];
  const ip = getLocalIpAddress();

  // Backend detection
  if (apiPath) {
    if (hasNestApp(apiPath)) {
      services.push({
        name: 'nestjs-api',
        cwd: apiPath,
        startCommand: 'npm run start',
        readySignal: 'Nest application successfully started',
        port: 3000,
        healthCheck: ip ? `http://${ip}:3000` : 'http://localhost:3000',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        requiresNodeModules: true,
        type: 'backend',
      });
    } else {
      // Generic Node.js backend
      const pkg = readPackageJson(apiPath);
      if (pkg?.scripts?.start || pkg?.scripts?.['start:dev']) {
        const startScript = pkg.scripts['start:dev'] ? 'npm run start:dev' : 'npm run start';
        services.push({
          name: 'api',
          cwd: apiPath,
          startCommand: startScript,
          readySignal: 'listening',
          port: 3000,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          requiresNodeModules: true,
          type: 'backend',
        });
      }
    }
  }

  // Frontend detection
  if (hasExpoApp(expoPath)) {
    services.push({
      name: 'expo-web',
      cwd: expoPath,
      startCommand: 'npx expo start --web --port 8081',
      readySignal: 'ready in',
      port: 8081,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      requiresNodeModules: true,
      type: 'frontend',
    });
  } else if (hasNextApp(expoPath)) {
    services.push({
      name: 'nextjs',
      cwd: expoPath,
      startCommand: 'npm run dev',
      readySignal: 'Ready in',
      port: 3000,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      requiresNodeModules: true,
      type: 'frontend',
    });
  } else if (hasViteApp(expoPath)) {
    services.push({
      name: 'vite',
      cwd: expoPath,
      startCommand: 'npm run dev',
      readySignal: 'ready in',
      port: 5173,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      requiresNodeModules: true,
      type: 'frontend',
    });
  }

  return services;
}

/**
 * Resolve the runtime gate manifest for a workspace.
 * Tries manual config first, falls back to auto-detection.
 */
export function resolveRuntimeManifest(
  repoPath: string,
  expoPath: string,
  apiPath: string | null,
): RuntimeGateManifest {
  // Try manual config first
  const manual = loadManualConfig(repoPath);
  if (manual && manual.services.length > 0) {
    // Resolve relative cwd paths to absolute
    manual.services = manual.services.map((s) => ({
      ...s,
      cwd: path.isAbsolute(s.cwd) ? s.cwd : path.join(repoPath, s.cwd),
    }));
    return manual;
  }

  // Auto-detect
  const services = autoDetectServices(repoPath, expoPath, apiPath);
  const hasBackend = services.some((s) => s.type === 'backend');
  const hasFrontend = services.some((s) => s.type === 'frontend');

  return {
    services,
    linkBackendToFrontend: hasBackend && hasFrontend,
    backendUrlEnvVar: 'EXPO_PUBLIC_API_URL',
  };
}

export { getLocalIpAddress };
