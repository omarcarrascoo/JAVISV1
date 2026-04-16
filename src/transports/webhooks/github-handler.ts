/**
 * GitHub Webhook Handler — triggers autonomous runs from GitHub events.
 *
 * Supported triggers:
 * - PR comment with `/unity run <prompt>` command
 * - Push to a configured trigger branch
 * - Issue comment with `/unity run <prompt>` command
 */

import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getProjectByName, getRuntimeConfig } from '../../config.js';
import { createAutonomousRunPlan, resumeAutonomousRun } from '../../application/run-autonomous-agent.js';
import { RuntimeState } from '../../runtime/state.js';
import { unityStore } from '../../runtime/services.js';
import { createEntityId } from '../../shared/ids.js';

const UNITY_COMMAND_PREFIX = '/unity run ';

interface WebhookConfig {
  secret: string | null;
  triggerBranches: string[];
  enablePrComments: boolean;
  enablePush: boolean;
}

function getWebhookConfig(): WebhookConfig {
  return {
    secret: process.env.UNITY_WEBHOOK_SECRET || null,
    triggerBranches: (process.env.UNITY_TRIGGER_BRANCHES || '').split(',').filter(Boolean),
    enablePrComments: process.env.UNITY_WEBHOOK_PR_COMMENTS !== 'false',
    enablePush: process.env.UNITY_WEBHOOK_PUSH === 'true',
  };
}

function verifySignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  return signature === expected;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractUnityCommand(body: string): string | null {
  const lower = body.toLowerCase();
  const idx = lower.indexOf(UNITY_COMMAND_PREFIX);
  if (idx === -1) return null;
  const prompt = body.slice(idx + UNITY_COMMAND_PREFIX.length).trim();
  return prompt || null;
}

interface WebhookResult {
  triggered: boolean;
  runId?: string;
  reason: string;
}

async function handlePrComment(
  payload: Record<string, unknown>,
  runtime: RuntimeState,
): Promise<WebhookResult> {
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (!comment) return { triggered: false, reason: 'No comment in payload.' };

  const body = String(comment.body || '');
  const prompt = extractUnityCommand(body);
  if (!prompt) return { triggered: false, reason: 'No /unity run command found.' };

  if (runtime.isProcessing()) {
    return { triggered: false, reason: 'Agent is busy processing another run.' };
  }

  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repoName = ((payload.repository as Record<string, unknown>)?.name as string) || getRuntimeConfig().githubRepo;

  let project;
  try {
    project = getProjectByName(repoName);
  } catch {
    return { triggered: false, reason: `Project "${repoName}" not found in config.` };
  }

  const enrichedPrompt = pr
    ? `[PR #${pr.number}] ${prompt}`
    : prompt;

  const abortController = runtime.startProcessing();
  try {
    const result = await createAutonomousRunPlan({
      project,
      prompt: enrichedPrompt,
      channelName: 'webhook',
      mode: 'auto',
      signal: abortController.signal,
      onProgress: async (message) => {
        console.log(`[webhook][${result.runId}] ${message}`);
      },
    });

    // Auto-approved runs resume immediately
    if (result.autoApproved) {
      void resumeAutonomousRun({
        runId: result.runId,
        signal: abortController.signal,
        onProgress: async (message) => {
          console.log(`[webhook][${result.runId}] ${message}`);
          unityStore.addEvent(createEntityId('event'), result.runId, null, 'info', 'run.progress', message);
        },
      })
        .catch((error: any) => {
          console.error(`[webhook] Run ${result.runId} failed:`, error);
          unityStore.updateRun(result.runId, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            summary: error?.message || String(error),
          });
        })
        .finally(() => {
          runtime.finishProcessing();
        });

      return { triggered: true, runId: result.runId, reason: 'Auto-approved run started.' };
    }

    runtime.finishProcessing();
    return { triggered: true, runId: result.runId, reason: 'Run created, awaiting approval.' };
  } catch (error: any) {
    runtime.finishProcessing();
    return { triggered: false, reason: `Error: ${error.message}` };
  }
}

async function handlePush(
  payload: Record<string, unknown>,
  runtime: RuntimeState,
  config: WebhookConfig,
): Promise<WebhookResult> {
  const ref = String(payload.ref || '');
  const branch = ref.replace('refs/heads/', '');

  if (!config.triggerBranches.includes(branch)) {
    return { triggered: false, reason: `Branch "${branch}" not in trigger list.` };
  }

  if (runtime.isProcessing()) {
    return { triggered: false, reason: 'Agent is busy processing another run.' };
  }

  const repoName = ((payload.repository as Record<string, unknown>)?.name as string) || getRuntimeConfig().githubRepo;
  const commits = (payload.commits as Array<Record<string, unknown>>) || [];
  const commitMessages = commits.map((c) => String(c.message || '')).join('; ');

  let project;
  try {
    project = getProjectByName(repoName);
  } catch {
    return { triggered: false, reason: `Project "${repoName}" not found in config.` };
  }

  const prompt = `Review and validate recent push to ${branch}: ${commitMessages.slice(0, 500)}`;
  const abortController = runtime.startProcessing();

  try {
    const result = await createAutonomousRunPlan({
      project,
      prompt,
      channelName: 'webhook-push',
      mode: 'auto',
      signal: abortController.signal,
      onProgress: async (message) => {
        console.log(`[webhook-push][${result.runId}] ${message}`);
      },
    });

    if (result.autoApproved) {
      void resumeAutonomousRun({
        runId: result.runId,
        signal: abortController.signal,
        onProgress: async (message) => {
          console.log(`[webhook-push][${result.runId}] ${message}`);
          unityStore.addEvent(createEntityId('event'), result.runId, null, 'info', 'run.progress', message);
        },
      })
        .catch((error: any) => {
          console.error(`[webhook-push] Run ${result.runId} failed:`, error);
          unityStore.updateRun(result.runId, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            summary: error?.message || String(error),
          });
        })
        .finally(() => {
          runtime.finishProcessing();
        });
    } else {
      runtime.finishProcessing();
    }

    return { triggered: true, runId: result.runId, reason: `Push trigger on ${branch}.` };
  } catch (error: any) {
    runtime.finishProcessing();
    return { triggered: false, reason: `Error: ${error.message}` };
  }
}

export async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: RuntimeState,
): Promise<void> {
  const config = getWebhookConfig();
  const eventType = req.headers['x-github-event'] as string | undefined;

  const rawBody = await readBody(req);

  // Verify signature if secret is configured
  if (config.secret) {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(rawBody, signature, config.secret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature.' }));
      return;
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON.' }));
    return;
  }

  let result: WebhookResult;

  if (
    (eventType === 'issue_comment' || eventType === 'pull_request_review_comment') &&
    config.enablePrComments
  ) {
    result = await handlePrComment(payload, runtime);
  } else if (eventType === 'push' && config.enablePush) {
    result = await handlePush(payload, runtime, config);
  } else {
    result = { triggered: false, reason: `Event "${eventType}" not handled.` };
  }

  console.log(`[webhook] ${eventType}: ${result.reason}${result.runId ? ` (run: ${result.runId})` : ''}`);

  res.writeHead(result.triggered ? 202 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}
