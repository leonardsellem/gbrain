import { afterEach, describe, expect, test } from 'bun:test';
import {
  EMBEDDING_BATCH_SIZE,
  hasEmbeddingApiKey,
  resolveEmbeddingApiKey,
} from '../src/core/embedding.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDINGS_OPENAI_API_KEY',
  'GBRAIN_OPENAI_EMBEDDING_API_KEY',
  'OPENAI_API_KEY',
  'GBRAIN_ALLOW_LEGACY_OPENAI_API_KEY_FOR_EMBEDDINGS',
];

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearEmbeddingEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe('embedding API key resolution', () => {
  test('uses the gbrain-scoped embedding key instead of global OPENAI_API_KEY', () => {
    clearEmbeddingEnv();
    process.env.OPENAI_API_KEY = 'global-inference-key';
    process.env.GBRAIN_EMBEDDINGS_OPENAI_API_KEY = 'embedding-only-key';

    expect(resolveEmbeddingApiKey({ includeKeychain: false })).toBe('embedding-only-key');
    expect(hasEmbeddingApiKey({ includeKeychain: false })).toBe(true);
  });

  test('does not treat global OPENAI_API_KEY as an embedding key by default', () => {
    clearEmbeddingEnv();
    process.env.OPENAI_API_KEY = 'global-inference-key';

    expect(resolveEmbeddingApiKey({ includeKeychain: false })).toBeUndefined();
    expect(hasEmbeddingApiKey({ includeKeychain: false })).toBe(false);
  });

  test('requires an explicit compatibility flag before using OPENAI_API_KEY for embeddings', () => {
    clearEmbeddingEnv();
    process.env.OPENAI_API_KEY = 'legacy-key';
    process.env.GBRAIN_ALLOW_LEGACY_OPENAI_API_KEY_FOR_EMBEDDINGS = '1';

    expect(resolveEmbeddingApiKey({ includeKeychain: false })).toBe('legacy-key');
  });

  test('keeps embedding requests batched', () => {
    expect(EMBEDDING_BATCH_SIZE).toBe(100);
  });
});
