import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  classifyMissingExport,
  runMissingExport,
} from '../src/core/export-reconciliation.ts';

let engine: PGLiteEngine;
let repoPath: string;

async function seedPage(
  sourceId: string,
  slug: string,
  attrs: Partial<{
    type: string;
    title: string;
    compiled_truth: string;
    timeline: string;
    frontmatter: Record<string, unknown>;
    page_kind: string;
  }> = {},
) {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (source_id, slug) DO UPDATE SET
       type = EXCLUDED.type,
       page_kind = EXCLUDED.page_kind,
       title = EXCLUDED.title,
       compiled_truth = EXCLUDED.compiled_truth,
       timeline = EXCLUDED.timeline,
       frontmatter = EXCLUDED.frontmatter,
       content_hash = EXCLUDED.content_hash`,
    [
      sourceId,
      slug,
      attrs.type ?? 'concept',
      attrs.page_kind ?? 'markdown',
      attrs.title ?? slug,
      attrs.compiled_truth ?? `${slug} body`,
      attrs.timeline ?? '',
      JSON.stringify(attrs.frontmatter ?? {}),
      `hash-${sourceId}-${slug}`,
    ],
  );
}

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-export-reconcile-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repoPath]);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('other', 'Other', $1, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [mkdtempSync(join(tmpdir(), 'gbrain-export-other-'))],
  );
});

afterEach(async () => {
  await engine.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
});

describe('missing export reconciliation classification', () => {
  test('classifies default-source DB-only pages and excludes other sources by default', async () => {
    await seedPage('default', 'concepts/db-only', { title: 'DB Only' });
    await seedPage('other', 'concepts/db-only-other', { title: 'Other Source' });

    const manifest = await classifyMissingExport(engine, { repoPath });

    expect(manifest.summary.candidates).toBe(1);
    expect(manifest.entries.map(e => e.slug)).toContain('concepts/db-only');
    expect(manifest.entries.map(e => e.slug)).not.toContain('concepts/db-only-other');
  });

  test('syncable markdown counterpart prevents export while ignored files do not', async () => {
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts/present.md'), [
      '---',
      'type: concept',
      'title: Present',
      '---',
      '',
      'same body',
      '',
    ].join('\n'));
    mkdirSync(join(repoPath, '.raw'), { recursive: true });
    writeFileSync(join(repoPath, '.raw/ignored.md'), 'ignored');
    await seedPage('default', 'concepts/present', { title: 'Present', compiled_truth: 'same body' });
    await seedPage('default', 'raw/ignored', { title: 'Ignored' });

    const manifest = await classifyMissingExport(engine, { repoPath });

    expect(manifest.summary.present).toBe(1);
    expect(manifest.summary.candidates).toBe(1);
    expect(manifest.entries.find(e => e.slug === 'raw/ignored')?.status).toBe('candidate');
  });

  test('present-on-both content differences are reported as mismatches', async () => {
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts/mismatch.md'), [
      '---',
      'type: concept',
      'title: Mismatch',
      '---',
      '',
      'repo body',
      '',
    ].join('\n'));
    await seedPage('default', 'concepts/mismatch', { title: 'Mismatch', compiled_truth: 'db body' });

    const manifest = await classifyMissingExport(engine, { repoPath });

    expect(manifest.summary.mismatches).toBe(1);
    expect(manifest.entries.find(e => e.slug === 'concepts/mismatch')?.status).toBe('mismatch');
  });

  test('slugified markdown counterpart paths are used for mismatch detection', async () => {
    mkdirSync(join(repoPath, 'Concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'Concepts/My Page.md'), [
      '---',
      'type: concept',
      'title: My Page',
      '---',
      '',
      'same body',
      '',
    ].join('\n'));
    await seedPage('default', 'concepts/my-page', { title: 'My Page', compiled_truth: 'same body' });

    const manifest = await classifyMissingExport(engine, { repoPath });

    expect(manifest.summary.present).toBe(1);
    expect(manifest.summary.mismatches).toBe(0);
    expect(manifest.entries.find(e => e.slug === 'concepts/my-page')?.path).toBe('Concepts/My Page.md');
  });

  test('duplicate slugs across sources stay source-scoped', async () => {
    await seedPage('default', 'concepts/same', { title: 'Default Same' });
    await seedPage('other', 'concepts/same', { title: 'Other Same' });

    const defaultManifest = await classifyMissingExport(engine, { repoPath });
    const otherManifest = await classifyMissingExport(engine, { repoPath, sourceId: 'other' });

    expect(defaultManifest.entries.filter(e => e.slug === 'concepts/same')).toHaveLength(1);
    expect(defaultManifest.entries.find(e => e.slug === 'concepts/same')?.source_id).toBe('default');
    expect(otherManifest.entries.find(e => e.slug === 'concepts/same')?.source_id).toBe('other');
  });
});

describe('missing export reconciliation materialization', () => {
  test('dry-run records candidates but does not write files', async () => {
    await seedPage('default', 'concepts/dry-run', { title: 'Dry Run' });

    const manifest = await runMissingExport(engine, { repoPath, write: false });

    expect(manifest.summary.candidates).toBe(1);
    expect(manifest.summary.exported).toBe(0);
    expect(existsSync(join(repoPath, 'concepts/dry-run.md'))).toBe(false);
  });

  test('conservative write exports safe pages and skips operational noise', async () => {
    await seedPage('default', 'concepts/safe', { title: 'Safe' });
    await seedPage('default', 'archive/noise', { title: 'Noise' });

    const manifest = await runMissingExport(engine, { repoPath, write: true, mode: 'conservative' });

    expect(existsSync(join(repoPath, 'concepts/safe.md'))).toBe(true);
    expect(existsSync(join(repoPath, 'archive/noise.md'))).toBe(false);
    expect(manifest.summary.exported).toBe(1);
    expect(manifest.summary.skipped).toBe(1);
    expect(manifest.entries.find(e => e.slug === 'archive/noise')?.status).toBe('skipped');
  });

  test('complete write exports conservative skip candidates', async () => {
    await seedPage('default', 'archive/noise', { title: 'Noise' });

    const manifest = await runMissingExport(engine, { repoPath, write: true, mode: 'complete' });

    expect(existsSync(join(repoPath, 'archive/noise.md'))).toBe(true);
    expect(manifest.summary.exported).toBe(1);
    expect(manifest.summary.skipped).toBe(0);
  });

  test('rerun after export reports page as present and does not duplicate', async () => {
    await seedPage('default', 'concepts/repeatable', { title: 'Repeatable' });

    await runMissingExport(engine, { repoPath, write: true });
    const rerun = await runMissingExport(engine, { repoPath, write: true });

    expect(rerun.summary.candidates).toBe(0);
    expect(rerun.summary.present).toBe(1);
    expect(readFileSync(join(repoPath, 'concepts/repeatable.md'), 'utf8')).toContain('Repeatable');
  });

  test('manifest file is written when requested', async () => {
    await seedPage('default', 'concepts/manifest', { title: 'Manifest' });
    const manifestPath = join(repoPath, 'manifest.json');

    const manifest = await runMissingExport(engine, { repoPath, write: true, manifestPath });

    expect(manifest.summary.exported).toBe(1);
    const saved = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(saved.summary.exported).toBe(1);
    expect(saved.entries).toHaveLength(manifest.entries.length);
  });

  test('candidate paths that escape the repo are recorded as errors', async () => {
    await seedPage('default', '../escape', { title: 'Escape' });

    const manifest = await runMissingExport(engine, { repoPath, write: true });

    expect(existsSync(join(repoPath, '../escape.md'))).toBe(false);
    expect(manifest.summary.errors).toBe(1);
    expect(manifest.entries.find(e => e.slug === '../escape')?.status).toBe('error');
  });

  test('dry-run records path escapes as errors before write mode', async () => {
    await seedPage('default', '../escape-dry-run', { title: 'Escape Dry Run' });

    const manifest = await runMissingExport(engine, { repoPath, write: false });

    expect(manifest.summary.candidates).toBe(0);
    expect(manifest.summary.errors).toBe(1);
    expect(manifest.entries.find(e => e.slug === '../escape-dry-run')?.status).toBe('error');
    expect(existsSync(join(repoPath, '../escape-dry-run.md'))).toBe(false);
  });
});
