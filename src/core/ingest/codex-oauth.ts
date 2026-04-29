import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const GBRAIN_INGEST_INFERENCE_MODEL = 'gpt-5.4-mini';

export type CodexOAuthInferenceErrorCode = 'configuration_error' | 'model_rejected' | 'runner_failed';

export class CodexOAuthInferenceError extends Error {
  constructor(message: string, public readonly code: CodexOAuthInferenceErrorCode) {
    super(message);
    this.name = 'CodexOAuthInferenceError';
  }
}

export interface CodexOAuthRunnerRequest {
  prompt: string;
  model: typeof GBRAIN_INGEST_INFERENCE_MODEL;
}

export interface CodexOAuthRunnerResult {
  text: string;
  route: 'codex-oauth';
  model?: string;
}

export type CodexOAuthRunner = (request: CodexOAuthRunnerRequest) => Promise<CodexOAuthRunnerResult>;

export interface CodexOAuthInferenceRequest {
  prompt: string;
  model: string;
  runner?: CodexOAuthRunner;
}

const INFERENCE_SECRET_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'GBRAIN_EMBEDDINGS_OPENAI_API_KEY',
  'GBRAIN_OPENAI_EMBEDDING_API_KEY',
]);

export function sanitizeInferenceEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (INFERENCE_SECRET_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

async function liveCodexOAuthRunner(request: CodexOAuthRunnerRequest): Promise<CodexOAuthRunnerResult> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-oauth-'));
  const outputPath = join(dir, 'last-message.txt');
  try {
    await execFileAsync('codex', [
      'exec',
      '--model', request.model,
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--output-last-message', outputPath,
      request.prompt,
    ], {
      env: sanitizeInferenceEnv(),
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const text = readFileSync(outputPath, 'utf8').trim();
    if (!text) {
      throw new CodexOAuthInferenceError('Codex OAuth runner returned an empty response', 'runner_failed');
    }
    return { text, route: 'codex-oauth', model: request.model };
  } catch (e) {
    if (e instanceof CodexOAuthInferenceError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    const code: CodexOAuthInferenceErrorCode = /ENOENT|not found|No such file/i.test(message)
      ? 'configuration_error'
      : 'runner_failed';
    throw new CodexOAuthInferenceError(`Codex OAuth inference failed: ${message}`, code);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCodexOAuthInference(request: CodexOAuthInferenceRequest): Promise<CodexOAuthRunnerResult> {
  if (request.model !== GBRAIN_INGEST_INFERENCE_MODEL) {
    throw new CodexOAuthInferenceError(
      `GBrain ingest inference requires model=${GBRAIN_INGEST_INFERENCE_MODEL}; got ${String(request.model || '(omitted)')}`,
      'model_rejected',
    );
  }
  if (!request.prompt.trim()) {
    throw new CodexOAuthInferenceError('GBrain ingest inference prompt is empty', 'runner_failed');
  }
  const runner = request.runner ?? liveCodexOAuthRunner;
  return runner({
    prompt: request.prompt,
    model: GBRAIN_INGEST_INFERENCE_MODEL,
  });
}
