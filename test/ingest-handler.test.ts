import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { normalizeIngestInput } from '../src/core/ingest/input.ts';
import { makeIngestHandler } from '../src/core/ingest/handler.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM ingest_log');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
});

function fakeJob(data: Record<string, unknown>, progress: unknown[] = []) {
  return {
    id: 123,
    name: 'gbrain-ingest',
    data,
    attempts_made: 0,
    signal: { aborted: false },
    shutdownSignal: { aborted: false },
    updateProgress: async (p: unknown) => { progress.push(p); },
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  } as any;
}

describe('gbrain-ingest worker handler', () => {
  test('registerBuiltinHandlers registers gbrain-ingest', async () => {
    const worker = new MinionWorker(engine, { queue: 'test' });
    await registerBuiltinHandlers(worker, engine);
    expect(worker.registeredNames).toContain('gbrain-ingest');
  });

  test('text input writes a source page, chunks it without embedding, and logs ingest', async () => {
    const input = await normalizeIngestInput({
      text: 'Remember this: GBrain ingest must write PostgreSQL state.',
      title: 'Async ingest contract',
    });
    const progress: unknown[] = [];

    const result = await makeIngestHandler({ engine })(fakeJob(input as unknown as Record<string, unknown>, progress));

    expect((result as any).status).toBe('succeeded');
    expect((result as any).updated_slugs).toHaveLength(1);
    const slug = (result as any).updated_slugs[0];

    const page = await engine.getPage(slug);
    expect(page?.type).toBe('source');
    expect(page?.title).toBe('Async ingest contract');
    expect(page?.frontmatter.content_hash).toBe(input.content_hash);

    const chunks = await engine.getChunks(slug);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(c => c.embedding === null)).toBe(true);

    const log = await engine.getIngestLog({ limit: 5 });
    expect(log[0]?.source_type).toBe('gbrain-ingest');
    expect(log[0]?.pages_updated).toEqual([slug]);

    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'resolve' }),
      expect.objectContaining({ phase: 'wiki_write' }),
      expect.objectContaining({ phase: 'db_import' }),
      expect.objectContaining({ phase: 'done' }),
    ]));
  });

  test('writes the same source markdown to the filesystem brain when local_path is configured', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-ingest-wiki-'));
    try {
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [repo],
      );
      const input = await normalizeIngestInput({
        text: 'Remember this: the wiki brain receives the raw source page too.',
        title: 'Wiki and Postgres ingest',
      });

      const result = await makeIngestHandler({ engine })(fakeJob(input as unknown as Record<string, unknown>));
      const slug = (result as any).updated_slugs[0];
      const expectedPath = join(repo, `${slug}.md`);

      expect((result as any).wiki_write).toEqual(expect.objectContaining({
        status: 'written',
        source_id: 'default',
        path: expectedPath,
      }));
      expect(existsSync(expectedPath)).toBe(true);
      expect(readFileSync(expectedPath, 'utf8')).toContain('the wiki brain receives the raw source page too');

      const page = await engine.getPage(slug);
      expect(page?.compiled_truth).toContain('the wiki brain receives the raw source page too');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('re-running identical content returns no-op without duplicate pages', async () => {
    const input = await normalizeIngestInput({ text: 'Duplicate durable content.' });
    const handler = makeIngestHandler({ engine });

    const first = await handler(fakeJob(input as unknown as Record<string, unknown>));
    const second = await handler(fakeJob(input as unknown as Record<string, unknown>));

    expect((first as any).status).toBe('succeeded');
    expect((second as any).status).toBe('no-op');
    const pages = await engine.listPages({ type: 'source' });
    expect(pages).toHaveLength(1);
  });

  test('URL input fetches through an SSRF-safe resolver before importing', async () => {
    const input = await normalizeIngestInput({ url: 'https://example.com/notes' });
    const handler = makeIngestHandler({
      engine,
      fetchText: async (url) => {
        expect(url).toBe('https://example.com/notes');
        return {
          finalUrl: url,
          contentType: 'text/html',
          text: '<html><title>Example</title><body>Public source content.</body></html>',
        };
      },
    });

    const result = await handler(fakeJob(input as unknown as Record<string, unknown>));
    expect((result as any).status).toBe('succeeded');
    const page = await engine.getPage((result as any).updated_slugs[0]);
    expect(page?.compiled_truth).toContain('Public source content.');
    expect(page?.frontmatter.url).toBe('https://example.com/notes');
  });
});
