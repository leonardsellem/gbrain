export const INGEST_JOB_NAME = 'gbrain-ingest';
export const INGEST_QUEUE_NAME = 'default';
export const INGEST_PAYLOAD_VERSION = 1;

export type IngestInputKind = 'text' | 'url' | 'file';
export type IngestMode = 'explicit' | 'signal';

export interface NormalizedIngestInput {
  version: typeof INGEST_PAYLOAD_VERSION;
  kind: IngestInputKind;
  mode: IngestMode;
  content_hash: string;
  submitted_at: string;
  text?: string;
  url?: string;
  file?: {
    path: string;
    name: string;
    size_bytes: number;
    mtime_ms: number;
  };
  title?: string;
  source_id?: string;
  metadata: Record<string, unknown>;
}

export interface NormalizeIngestInputOptions {
  text?: string;
  url?: string;
  file?: string;
  mode?: IngestMode;
  title?: string;
  sourceId?: string;
  cwd?: string;
  maxBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface EnqueueIngestResult {
  job_id: number;
  queued: boolean;
  idempotency_key: string;
  status_command: string;
  status_url: string;
  job_name: typeof INGEST_JOB_NAME;
  queue: string;
}
