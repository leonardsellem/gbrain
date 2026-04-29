import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { isProtectedJobName } from '../src/core/minions/protected-names.ts';
import { normalizeIngestInput } from '../src/core/ingest/input.ts';
import { enqueueIngestJob } from '../src/core/ingest/enqueue.ts';

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
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('normalizeIngestInput', () => {
  test('accepts explicit stdin text and derives a stable content hash', async () => {
    const input = await normalizeIngestInput({ text: 'Remember this: GBrain writes async.' });

    expect(input.kind).toBe('text');
    expect(input.mode).toBe('explicit');
    expect(input.content_hash).toHaveLength(64);
    expect(input.text).toBe('Remember this: GBrain writes async.');
  });

  test('accepts https URLs without fetching in the foreground', async () => {
    const input = await normalizeIngestInput({ url: 'https://example.com/a#frag' });

    expect(input.kind).toBe('url');
    expect(input.url).toBe('https://example.com/a');
    expect(input.text).toBeUndefined();
  });

  test('accepts a normal local markdown file and rejects a final-component symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-input-'));
    try {
      const note = join(dir, 'note.md');
      writeFileSync(note, '# Note\n\nPortable memory.');
      const input = await normalizeIngestInput({ file: note, cwd: dir });
      expect(input.kind).toBe('file');
      expect(input.file?.path).toBe(note);
      expect(input.text).toContain('Portable memory.');

      const target = join(dir, 'target.md');
      const link = join(dir, 'link.md');
      writeFileSync(target, 'secret');
      symlinkSync(target, link);
      await expect(normalizeIngestInput({ file: link, cwd: dir })).rejects.toThrow(/symlink/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects empty input and unsupported URL schemes before queue submission', async () => {
    await expect(normalizeIngestInput({ text: '   ' })).rejects.toThrow(/empty/i);
    await expect(normalizeIngestInput({ url: 'file:///etc/passwd' })).rejects.toThrow(/unsupported URL scheme/i);
  });
});

describe('enqueueIngestJob', () => {
  test('gbrain-ingest is a protected job name', async () => {
    expect(isProtectedJobName('gbrain-ingest')).toBe(true);
    const queue = new MinionQueue(engine);
    await expect(queue.add('gbrain-ingest', { text: 'x' })).rejects.toThrow(/protected job name/);
  });

  test('inserts a protected gbrain-ingest job with status metadata', async () => {
    const input = await normalizeIngestInput({ text: 'Remember this: hooks must stay async.' });
    const result = await enqueueIngestJob(engine, input);

    expect(result.queued).toBe(true);
    expect(result.job_id).toBeGreaterThan(0);
    expect(result.status_command).toBe(`gbrain jobs get ${result.job_id}`);
    expect(result.idempotency_key).toContain('gbrain-ingest:');

    const queue = new MinionQueue(engine);
    const job = await queue.getJob(result.job_id);
    expect(job?.name).toBe('gbrain-ingest');
    expect(job?.status).toBe('waiting');
    expect(job?.data.kind).toBe('text');
  });

  test('repeated identical input returns the existing queued job', async () => {
    const input = await normalizeIngestInput({ text: 'Same durable thing.' });
    const first = await enqueueIngestJob(engine, input);
    const second = await enqueueIngestJob(engine, input);

    expect(second.job_id).toBe(first.job_id);
    expect(second.queued).toBe(false);

    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'gbrain-ingest' });
    expect(jobs).toHaveLength(1);
  });
});
