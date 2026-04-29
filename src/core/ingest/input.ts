import { createHash } from 'crypto';
import { basename, resolve } from 'path';
import { lstatSync, readFileSync, statSync } from 'fs';
import type { NormalizeIngestInputOptions, NormalizedIngestInput } from './types.ts';
import { INGEST_PAYLOAD_VERSION } from './types.ts';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text', '.json', '.jsonl', '.yaml', '.yml',
  '.csv', '.tsv', '.log',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileExtension(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function countProvided(opts: NormalizeIngestInputOptions): number {
  return [opts.text, opts.url, opts.file].filter(v => typeof v === 'string' && v.length > 0).length;
}

export async function normalizeIngestInput(opts: NormalizeIngestInputOptions): Promise<NormalizedIngestInput> {
  const mode = opts.mode ?? 'explicit';
  if (mode !== 'explicit' && mode !== 'signal') {
    throw new Error(`invalid ingest mode: ${mode}`);
  }

  const provided = countProvided(opts);
  if (provided !== 1) {
    throw new Error(provided === 0
      ? 'ingest input is empty; pass text, --url, --file, or stdin'
      : 'provide exactly one ingest input source');
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const submittedAt = new Date().toISOString();
  const base = {
    version: INGEST_PAYLOAD_VERSION as typeof INGEST_PAYLOAD_VERSION,
    mode,
    submitted_at: submittedAt,
    title: opts.title,
    source_id: opts.sourceId,
    metadata: opts.metadata ?? {},
  };

  if (typeof opts.text === 'string' && opts.text.length > 0) {
    const text = opts.text.trim();
    if (text.length === 0) throw new Error('ingest text is empty');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`ingest text exceeds ${maxBytes} bytes`);
    }
    return {
      ...base,
      kind: 'text',
      text,
      content_hash: sha256(`text:${mode}:${text}`),
    };
  }

  if (typeof opts.url === 'string' && opts.url.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new Error(`invalid URL: ${opts.url}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
    }
    parsed.hash = '';
    const canonicalUrl = parsed.toString();
    return {
      ...base,
      kind: 'url',
      url: canonicalUrl,
      content_hash: sha256(`url:${mode}:${canonicalUrl}`),
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const filePath = resolve(cwd, opts.file!);
  const lst = lstatSync(filePath);
  if (lst.isSymbolicLink()) {
    throw new Error(`ingest file must not be a symlink: ${filePath}`);
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`ingest file must be a regular file: ${filePath}`);
  }
  if (st.size <= 0) {
    throw new Error(`ingest file is empty: ${filePath}`);
  }
  if (st.size > maxBytes) {
    throw new Error(`ingest file exceeds ${maxBytes} bytes: ${filePath}`);
  }
  const ext = fileExtension(filePath);
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported ingest file type: ${ext || '(none)'}`);
  }
  const text = readFileSync(filePath, 'utf8').trim();
  if (text.length === 0) {
    throw new Error(`ingest file is empty after trimming: ${filePath}`);
  }

  return {
    ...base,
    kind: 'file',
    text,
    file: {
      path: filePath,
      name: basename(filePath),
      size_bytes: st.size,
      mtime_ms: st.mtimeMs,
    },
    content_hash: sha256(`file:${mode}:${filePath}:${st.size}:${st.mtimeMs}:${text}`),
  };
}

export const __testing = { sha256 };
