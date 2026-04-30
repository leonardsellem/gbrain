import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import type { PageType } from './types.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';
import { writeBrainPage } from './brain-writer.ts';
import { isSyncable, slugifyPath } from './sync.ts';

export type MissingExportMode = 'conservative' | 'complete';
export type MissingExportStatus =
  | 'candidate'
  | 'present'
  | 'mismatch'
  | 'skipped'
  | 'exported'
  | 'error';

export interface MissingExportOptions {
  repoPath: string;
  sourceId?: string;
  write?: boolean;
  mode?: MissingExportMode;
  manifestPath?: string;
}

export interface MissingExportEntry {
  status: MissingExportStatus;
  source_id: string;
  slug: string;
  path: string;
  title?: string;
  type?: string;
  reason?: string;
  error?: string;
}

export interface MissingExportManifest {
  schema_version: 1;
  generated_at: string;
  repo_path: string;
  source_id: string;
  mode: MissingExportMode;
  dry_run: boolean;
  summary: {
    scanned: number;
    candidates: number;
    exported: number;
    skipped: number;
    present: number;
    mismatches: number;
    errors: number;
  };
  entries: MissingExportEntry[];
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

interface DbPageRow {
  id: number;
  source_id: string;
  slug: string;
  type: PageType;
  page_kind?: string | null;
  title: string;
  compiled_truth: string;
  timeline: string | null;
  frontmatter: Record<string, unknown> | string | null;
  updated_at?: Date | string | null;
  tags?: string[] | string | null;
}

const CONSERVATIVE_SKIP_PREFIXES = [
  'archive/',
  'attachments/',
  'daily/',
  'ops/',
  'test/',
  'wintermute/chat/',
];

const CONSERVATIVE_SKIP_TYPES = new Set(['email', 'slack', 'calendar-event', 'code']);

export async function classifyMissingExport(
  engine: BrainEngine,
  opts: Pick<MissingExportOptions, 'repoPath' | 'sourceId'>,
): Promise<MissingExportManifest> {
  const repoPath = resolve(opts.repoPath);
  const sourceId = opts.sourceId ?? 'default';
  const manifest = emptyManifest(repoPath, sourceId, 'conservative', true);

  if (!existsSync(repoPath) || !lstatSync(repoPath).isDirectory()) {
    manifest.summary.errors = 1;
    manifest.entries.push({
      status: 'error',
      source_id: sourceId,
      slug: '',
      path: repoPath,
      reason: 'repo_path_invalid',
      error: `Repo path does not exist or is not a directory: ${repoPath}`,
    });
    return manifest;
  }

  const source = await fetchSource(engine, sourceId);
  if (!source) {
    throw new Error(`Source "${sourceId}" not found. Run \`gbrain sources list\` to inspect registered sources.`);
  }

  const repoSlugs = scanRepoSlugs(repoPath);
  const rows = await listPagesForSource(engine, source.id);
  manifest.summary.scanned = rows.length;

  for (const row of rows) {
    const counterpartPath = repoSlugs.get(row.slug);
    const relPath = counterpartPath ?? `${row.slug}.md`;
    const absPath = join(repoPath, relPath);
    const base: Omit<MissingExportEntry, 'status'> = {
      source_id: row.source_id,
      slug: row.slug,
      path: relPath,
      title: row.title,
      type: row.type,
    };

    if (!counterpartPath) {
      if (!isUnderPath(absPath, repoPath)) {
        manifest.summary.errors++;
        manifest.entries.push({
          ...base,
          status: 'error',
          reason: 'path_outside_repo',
          error: `Target path would escape repo: ${relPath}`,
        });
        continue;
      }
      manifest.summary.candidates++;
      manifest.entries.push({ ...base, status: 'candidate' });
      continue;
    }

    const mismatch = detectMismatch(absPath, row);
    if (mismatch) {
      manifest.summary.mismatches++;
      manifest.entries.push({ ...base, status: 'mismatch', reason: mismatch });
    } else {
      manifest.summary.present++;
      manifest.entries.push({ ...base, status: 'present' });
    }
  }

  return manifest;
}

export async function runMissingExport(
  engine: BrainEngine,
  opts: MissingExportOptions,
): Promise<MissingExportManifest> {
  const mode = opts.mode ?? 'conservative';
  const write = opts.write === true;
  const classified = await classifyMissingExport(engine, opts);
  const manifest: MissingExportManifest = {
    ...classified,
    generated_at: new Date().toISOString(),
    mode,
    dry_run: !write,
    summary: {
      scanned: classified.summary.scanned,
      candidates: classified.summary.candidates,
      exported: 0,
      skipped: 0,
      present: classified.summary.present,
      mismatches: classified.summary.mismatches,
      errors: classified.summary.errors,
    },
    entries: [],
  };

  const rowsBySlug = new Map((await listPagesForSource(engine, classified.source_id)).map(r => [r.slug, r]));

  for (const entry of classified.entries) {
    if (entry.status !== 'candidate') {
      manifest.entries.push(entry);
      continue;
    }

    const row = rowsBySlug.get(entry.slug);
    if (!row) {
      manifest.summary.errors++;
      manifest.entries.push({
        ...entry,
        status: 'error',
        reason: 'candidate_missing_from_source',
        error: 'Candidate disappeared during reconciliation',
      });
      continue;
    }

    const skipReason = mode === 'conservative' ? conservativeSkipReason(row) : null;
    if (skipReason) {
      manifest.summary.skipped++;
      manifest.entries.push({ ...entry, status: 'skipped', reason: skipReason });
      continue;
    }

    if (!write) {
      manifest.entries.push(entry);
      continue;
    }

    const targetPath = join(resolve(opts.repoPath), `${row.slug}.md`);
    if (!isUnderPath(targetPath, opts.repoPath)) {
      manifest.summary.errors++;
      manifest.entries.push({
        ...entry,
        status: 'error',
        reason: 'path_outside_repo',
        error: `Target path would escape repo: ${entry.path}`,
      });
      continue;
    }

    if (existsSync(targetPath)) {
      manifest.summary.mismatches++;
      manifest.entries.push({
        ...entry,
        status: 'mismatch',
        reason: 'existing_file_at_write',
      });
      continue;
    }

    try {
      const markdown = renderPage(row);
      writeBrainPage(targetPath, markdown, { sourcePath: opts.repoPath });
      manifest.summary.exported++;
      manifest.entries.push({ ...entry, status: 'exported' });
    } catch (e) {
      manifest.summary.errors++;
      manifest.entries.push({
        ...entry,
        status: 'error',
        reason: 'write_failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (opts.manifestPath) {
    const manifestPath = resolve(opts.manifestPath);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  return manifest;
}

export function conservativeSkipReason(row: Pick<DbPageRow, 'slug' | 'type'>): string | null {
  if (CONSERVATIVE_SKIP_TYPES.has(row.type)) return `conservative_type:${row.type}`;
  const prefix = CONSERVATIVE_SKIP_PREFIXES.find(p => row.slug.startsWith(p));
  if (prefix) return `conservative_prefix:${prefix}`;
  return null;
}

function emptyManifest(
  repoPath: string,
  sourceId: string,
  mode: MissingExportMode,
  dryRun: boolean,
): MissingExportManifest {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repo_path: repoPath,
    source_id: sourceId,
    mode,
    dry_run: dryRun,
    summary: {
      scanned: 0,
      candidates: 0,
      exported: 0,
      skipped: 0,
      present: 0,
      mismatches: 0,
      errors: 0,
    },
    entries: [],
  };
}

async function fetchSource(engine: BrainEngine, sourceId: string): Promise<SourceRow | null> {
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0] ?? null;
}

async function listPagesForSource(engine: BrainEngine, sourceId: string): Promise<DbPageRow[]> {
  const rows = await engine.executeRaw<DbPageRow>(
    `SELECT
       p.id,
       p.source_id,
       p.slug,
       p.type,
       p.page_kind,
       p.title,
       p.compiled_truth,
       p.timeline,
       p.frontmatter,
       p.updated_at,
       COALESCE(json_agg(t.tag ORDER BY t.tag) FILTER (WHERE t.tag IS NOT NULL), '[]'::json) AS tags
     FROM pages p
     LEFT JOIN tags t ON t.page_id = p.id
     WHERE p.source_id = $1
       AND COALESCE(p.page_kind, 'markdown') = 'markdown'
     GROUP BY p.id, p.source_id, p.slug, p.type, p.page_kind, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.updated_at
     ORDER BY p.slug`,
    [sourceId],
  );
  return rows;
}

function isUnderPath(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + '/');
}

function scanRepoSlugs(repoPath: string): Map<string, string> {
  const root = resolve(repoPath);
  const slugs = new Map<string, string>();
  const stack = [root];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const real = resolve(abs);
        if (visited.has(real)) continue;
        visited.add(real);
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (!isSyncable(rel, { strategy: 'markdown' })) continue;
      slugs.set(slugifyPath(rel), rel);
    }
  }

  return slugs;
}

function detectMismatch(absPath: string, row: DbPageRow): string | null {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch (e) {
    return `read_failed:${e instanceof Error ? e.message : String(e)}`;
  }

  const parsed = parseMarkdown(content, absPath);
  const dbFrontmatter = normalizeFrontmatter(row.frontmatter);
  const dbTags = normalizeTags(row.tags);
  const same =
    parsed.type === row.type &&
    parsed.title === row.title &&
    parsed.compiled_truth.trim() === (row.compiled_truth ?? '').trim() &&
    parsed.timeline.trim() === (row.timeline ?? '').trim() &&
    stableJson(parsed.frontmatter) === stableJson(dbFrontmatter) &&
    stableJson([...parsed.tags].sort()) === stableJson([...dbTags].sort());
  return same ? null : 'content_differs';
}

function renderPage(row: DbPageRow): string {
  return serializeMarkdown(
    normalizeFrontmatter(row.frontmatter),
    row.compiled_truth ?? '',
    row.timeline ?? '',
    { type: row.type, title: row.title, tags: normalizeTags(row.tags) },
  );
}

function normalizeFrontmatter(value: DbPageRow['frontmatter']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value;
}

function normalizeTags(value: DbPageRow['tags']): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }
  return [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
