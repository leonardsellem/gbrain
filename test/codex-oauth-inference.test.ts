import { describe, test, expect } from 'bun:test';
import {
  CodexOAuthInferenceError,
  runCodexOAuthInference,
  sanitizeInferenceEnv,
} from '../src/core/ingest/codex-oauth.ts';

describe('Codex OAuth inference adapter', () => {
  test('calls the injected runner with explicit gpt-5.4-mini', async () => {
    const calls: unknown[] = [];
    const result = await runCodexOAuthInference({
      prompt: 'Extract cited entities.',
      model: 'gpt-5.4-mini',
      runner: async (req) => {
        calls.push(req);
        return { text: '{"entities":[]}', route: 'codex-oauth' };
      },
    });

    expect(result.text).toBe('{"entities":[]}');
    expect(calls).toEqual([
      expect.objectContaining({ prompt: 'Extract cited entities.', model: 'gpt-5.4-mini' }),
    ]);
  });

  test('rejects omitted or non-mini models before invoking a runner', async () => {
    let invoked = false;
    const runner = async () => {
      invoked = true;
      return { text: 'nope', route: 'codex-oauth' as const };
    };

    await expect(runCodexOAuthInference({ prompt: 'x', model: undefined as any, runner }))
      .rejects.toThrow(/requires model=gpt-5.4-mini/);
    await expect(runCodexOAuthInference({ prompt: 'x', model: 'gpt-5.4', runner }))
      .rejects.toThrow(/requires model=gpt-5.4-mini/);
    await expect(runCodexOAuthInference({ prompt: 'x', model: 'gpt-5.5', runner }))
      .rejects.toThrow(/requires model=gpt-5.4-mini/);
    expect(invoked).toBe(false);
  });

  test('strips OpenAI API keys from the live runner environment', () => {
    const env = sanitizeInferenceEnv({
      OPENAI_API_KEY: 'sk-secret',
      GBRAIN_EMBEDDINGS_OPENAI_API_KEY: 'sk-embed',
      GBRAIN_OPENAI_EMBEDDING_API_KEY: 'sk-embed2',
      CODEX_HOME: '/tmp/codex',
      PATH: '/bin',
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GBRAIN_EMBEDDINGS_OPENAI_API_KEY).toBeUndefined();
    expect(env.GBRAIN_OPENAI_EMBEDDING_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe('/tmp/codex');
    expect(env.PATH).toBe('/bin');
  });

  test('missing Codex OAuth route fails closed as a configuration error', async () => {
    await expect(runCodexOAuthInference({
      prompt: 'x',
      model: 'gpt-5.4-mini',
      runner: async () => {
        throw new CodexOAuthInferenceError('codex CLI not found', 'configuration_error');
      },
    })).rejects.toMatchObject({
      code: 'configuration_error',
    });
  });
});
