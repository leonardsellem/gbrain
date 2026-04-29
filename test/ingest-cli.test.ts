import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runIngest } from '../src/commands/ingest.ts';

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

describe('runIngest', () => {
  test('--json prints stable job id and status fields', async () => {
    const out: string[] = [];
    await runIngest(engine, ['--json'], {
      stdin: 'Remember this: Codex writes use OAuth only.',
      stdout: (line) => out.push(line),
    });

    const payload = JSON.parse(out.join(''));
    expect(payload.job_id).toBeGreaterThan(0);
    expect(payload.status_command).toBe(`gbrain jobs get ${payload.job_id}`);
    expect(payload.queued).toBe(true);
    expect(payload.idempotency_key).toContain('gbrain-ingest:');
  });

  test('human output returns immediately with job id and status command', async () => {
    const out: string[] = [];
    await runIngest(engine, ['--text', 'A durable note for the async queue.'], {
      stdout: (line) => out.push(line),
    });

    const text = out.join('');
    expect(text).toMatch(/Queued GBrain ingest job #\d+/);
    expect(text).toMatch(/gbrain jobs get \d+/);

    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'gbrain-ingest' });
    expect(jobs).toHaveLength(1);
  });

  test('does not run worker enrichment in the foreground', async () => {
    const out: string[] = [];
    await runIngest(engine, ['--text', 'Fast foreground only.'], {
      stdout: (line) => out.push(line),
    });

    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'gbrain-ingest' });
    expect(jobs[0]?.status).toBe('waiting');
    expect(jobs[0]?.progress).toBeNull();
    expect(jobs[0]?.result).toBeNull();
  });
});
