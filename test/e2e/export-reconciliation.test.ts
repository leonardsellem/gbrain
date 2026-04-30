import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExport } from '../../src/commands/export.ts';

let engine: PGLiteEngine;
let repoPath: string;

async function seedPage(sourceId: string, slug: string, title: string, body = `${title} body`) {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
     VALUES ($1, $2, 'concept', $3, $4, '', '{}'::jsonb, $5)`,
    [sourceId, slug, title, body, `hash-${sourceId}-${slug}`],
  );
}

async function withConsoleCapture(fn: () => Promise<void>) {
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines.join('\n');
}

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-export-reconcile-e2e-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repoPath]);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('other', 'Other', $1, '{}'::jsonb)`,
    [mkdtempSync(join(tmpdir(), 'gbrain-export-reconcile-e2e-other-'))],
  );
});

afterEach(async () => {
  await engine.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
});

describe('export missing end-to-end', () => {
  test('dry-run, conservative write, complete write, rerun, and source isolation', async () => {
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
    await seedPage('default', 'concepts/safe', 'Safe');
    await seedPage('default', 'archive/noise', 'Noise');
    await seedPage('default', 'concepts/mismatch', 'Mismatch', 'db body');
    await seedPage('other', 'concepts/other-source', 'Other Source');

    const dryManifestPath = join(repoPath, 'dry-manifest.json');
    const dryOutput = await withConsoleCapture(() =>
      runExport(engine, ['missing', '--repo', repoPath, '--manifest', dryManifestPath]),
    );
    expect(dryOutput).toContain('DB-only candidates: 2');
    expect(existsSync(join(repoPath, 'concepts/safe.md'))).toBe(false);
    expect(JSON.parse(readFileSync(dryManifestPath, 'utf8')).summary.mismatches).toBe(1);

    await runExport(engine, ['missing', '--repo', repoPath, '--write']);
    expect(existsSync(join(repoPath, 'concepts/safe.md'))).toBe(true);
    expect(existsSync(join(repoPath, 'archive/noise.md'))).toBe(false);
    expect(readFileSync(join(repoPath, 'concepts/mismatch.md'), 'utf8')).toContain('repo body');

    await runExport(engine, ['missing', '--repo', repoPath, '--write', '--complete']);
    expect(existsSync(join(repoPath, 'archive/noise.md'))).toBe(true);

    const rerun = await withConsoleCapture(() => runExport(engine, ['missing', '--repo', repoPath]));
    expect(rerun).toContain('DB-only candidates: 0');
    expect(existsSync(join(repoPath, 'concepts/other-source.md'))).toBe(false);
  });
});
