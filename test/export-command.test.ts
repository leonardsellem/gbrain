import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runExport } from '../src/commands/export.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeEngine(rowsByPattern: Record<string, unknown[]> = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const engine = {
    kind: 'pglite' as const,
    listPages: async () => [{
      slug: 'concepts/existing-export',
      type: 'concept',
      title: 'Existing Export',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
      created_at: new Date(),
      updated_at: new Date(),
    }],
    getTags: async () => [],
    getRawData: async () => [],
    getConfig: async () => null,
    executeRaw: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      for (const [pattern, rows] of Object.entries(rowsByPattern)) {
        if (sql.includes(pattern)) return rows as never;
      }
      return [] as never;
    },
  } as unknown as BrainEngine;
  return { engine, calls };
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

describe('export command', () => {
  test('preserves all-pages export when missing mode is not selected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-export-command-'));
    const { engine } = makeEngine();
    try {
      await runExport(engine, ['--dir', dir]);
      expect(existsSync(join(dir, 'concepts/existing-export.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export missing dry-run prints reconciliation counts', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-export-command-repo-'));
    const { engine } = makeEngine({
      'SELECT id, local_path FROM sources WHERE id = $1': [{ id: 'default', local_path: repo }],
      'FROM pages p': [{
        id: 1,
        source_id: 'default',
        slug: 'concepts/db-only',
        type: 'concept',
        page_kind: 'markdown',
        title: 'DB Only',
        compiled_truth: 'body',
        timeline: '',
        frontmatter: {},
        updated_at: new Date(),
        tags: [],
      }],
    });
    try {
      const output = await withConsoleCapture(() => runExport(engine, ['missing', '--repo', repo]));
      expect(output).toContain('DB-only candidates: 1');
      expect(output).toContain('Exported: 0');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('export missing write requires a repo target', async () => {
    const { engine } = makeEngine();
    await expect(runExport(engine, ['missing', '--write'])).rejects.toThrow(/--repo/);
  });

  test('export missing rejects conflicting action and mode flags', async () => {
    const { engine } = makeEngine();

    await expect(runExport(engine, ['missing', '--write', '--dry-run', '--repo', '/tmp'])).rejects.toThrow(/cannot combine --write and --dry-run/);
    await expect(runExport(engine, ['missing', '--complete', '--conservative'])).rejects.toThrow(/cannot combine --complete and --conservative/);
    await expect(runExport(engine, ['missing', '--mode', 'complete', '--conservative'])).rejects.toThrow(/cannot combine --mode with --complete or --conservative/);
  });

  test('export missing honors explicit source selection', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-export-command-source-repo-'));
    const { engine } = makeEngine({
      'SELECT id, local_path FROM sources WHERE id = $1': [{ id: 'other', local_path: repo }],
      'FROM pages p': [{
        id: 1,
        source_id: 'other',
        slug: 'concepts/other-db-only',
        type: 'concept',
        page_kind: 'markdown',
        title: 'Other DB Only',
        compiled_truth: 'body',
        timeline: '',
        frontmatter: {},
        updated_at: new Date(),
        tags: [],
      }],
    });
    try {
      const output = await withConsoleCapture(() => runExport(engine, ['missing', '--repo', repo, '--source', 'other']));
      expect(output).toContain('Source: other');
      expect(output).toContain('DB-only candidates: 1');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('export missing rejects unexpected positional arguments', async () => {
    const { engine } = makeEngine();

    await expect(runExport(engine, ['missing', 'unexpected'])).rejects.toThrow(/Unexpected export missing argument: unexpected/);
  });
});
