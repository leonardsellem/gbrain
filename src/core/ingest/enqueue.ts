import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import type { NormalizedIngestInput, EnqueueIngestResult } from './types.ts';
import { INGEST_JOB_NAME, INGEST_QUEUE_NAME } from './types.ts';

export function ingestIdempotencyKey(input: NormalizedIngestInput): string {
  const scope = input.source_id ?? 'default';
  const locator = input.url ?? input.file?.path ?? input.kind;
  return `${INGEST_JOB_NAME}:${input.mode}:${scope}:${input.kind}:${input.content_hash}:${locator}`;
}

export async function enqueueIngestJob(
  engine: BrainEngine,
  input: NormalizedIngestInput,
  opts: { queue?: string; priority?: number; maxAttempts?: number } = {},
): Promise<EnqueueIngestResult> {
  const queueName = opts.queue ?? INGEST_QUEUE_NAME;
  const idempotencyKey = ingestIdempotencyKey(input);
  const queue = new MinionQueue(engine);
  await queue.ensureSchema();
  const existingRows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  const hadExisting = existingRows.length > 0;

  const job = await queue.add(INGEST_JOB_NAME, input as unknown as Record<string, unknown>, {
    queue: queueName,
    priority: opts.priority ?? 0,
    max_attempts: opts.maxAttempts ?? 3,
    max_stalled: 5,
    timeout_ms: 10 * 60 * 1000,
    idempotency_key: idempotencyKey,
  }, { allowProtectedSubmit: true });

  return {
    job_id: job.id,
    queued: !hadExisting,
    idempotency_key: idempotencyKey,
    status_command: `gbrain jobs get ${job.id}`,
    status_url: `gbrain://jobs/${job.id}`,
    job_name: INGEST_JOB_NAME,
    queue: job.queue,
  };
}
