import type { BrainEngine } from '../core/engine.ts';
import { normalizeIngestInput } from '../core/ingest/input.ts';
import { enqueueIngestJob } from '../core/ingest/enqueue.ts';
import type { IngestMode } from '../core/ingest/types.ts';

type Writer = (text: string) => void;

export interface RunIngestIo {
  stdin?: string;
  stdout?: Writer;
  stderr?: Writer;
  cwd?: string;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printHelp(out: Writer): void {
  out(`gbrain ingest — enqueue async GBrain memory ingestion

USAGE
  gbrain ingest [--text TEXT | --url URL | --file PATH] [--mode explicit|signal] [--json]
  gbrain-ingest [--text TEXT | --url URL | --file PATH] [--mode explicit|signal] [--json]

The command validates input and queues a gbrain-ingest job immediately. Workers
perform enrichment, wiki writes, database import, and embeddings asynchronously.
`);
}

async function readStdin(io: RunIngestIo): Promise<string | undefined> {
  if (typeof io.stdin === 'string') return io.stdin;
  if (process.stdin.isTTY) return undefined;
  return Bun.file('/dev/stdin').text();
}

export async function runIngest(engine: BrainEngine, args: string[], io: RunIngestIo = {}): Promise<void> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp(stdout);
    return;
  }

  const json = hasFlag(args, '--json');
  const modeRaw = parseFlag(args, '--mode') ?? 'explicit';
  if (modeRaw !== 'explicit' && modeRaw !== 'signal') {
    throw new Error(`--mode must be explicit or signal, got ${modeRaw}`);
  }

  const stdin = parseFlag(args, '--text') === undefined
    && parseFlag(args, '--url') === undefined
    && parseFlag(args, '--file') === undefined
      ? await readStdin(io)
      : undefined;

  const input = await normalizeIngestInput({
    text: parseFlag(args, '--text') ?? stdin,
    url: parseFlag(args, '--url'),
    file: parseFlag(args, '--file'),
    mode: modeRaw as IngestMode,
    title: parseFlag(args, '--title'),
    sourceId: parseFlag(args, '--source') ?? parseFlag(args, '--source-id'),
    cwd: io.cwd,
    metadata: {
      submitted_by: 'gbrain-cli',
      foreground_policy: 'enqueue-only',
    },
  });

  const result = await enqueueIngestJob(engine, input, {
    queue: parseFlag(args, '--queue') ?? undefined,
  });

  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
    return;
  }

  const verb = result.queued ? 'Queued' : 'Found existing';
  stdout(`${verb} GBrain ingest job #${result.job_id}\n`);
  stdout(`Status: ${result.status_command}\n`);
  stdout(`Job URL: ${result.status_url}\n`);
  stderr('');
}
