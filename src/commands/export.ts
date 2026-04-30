import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  runMissingExport,
  type MissingExportMode,
  type MissingExportManifest,
} from '../core/export-reconciliation.ts';

export async function runExport(engine: BrainEngine, args: string[]) {
  if (args[0] === 'missing') {
    await runExportMissing(engine, args.slice(1));
    return;
  }

  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';

  const pages = await engine.listPages({ limit: 100000 });
  console.log(`Exporting ${pages.length} pages to ${outDir}/`);

  // Progress on stderr so stdout stays clean for scripts parsing counts.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('export.pages', pages.length);

  let exported = 0;

  for (const page of pages) {
    const tags = await engine.getTags(page.slug);
    const md = serializeMarkdown(
      page.frontmatter,
      page.compiled_truth,
      page.timeline,
      { type: page.type, title: page.title, tags },
    );

    const filePath = join(outDir, page.slug + '.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, md);

    // Export raw data as sidecar JSON
    const rawData = await engine.getRawData(page.slug);
    if (rawData.length > 0) {
      const slugParts = page.slug.split('/');
      const rawDir = join(outDir, ...slugParts.slice(0, -1), '.raw');
      mkdirSync(rawDir, { recursive: true });
      const rawPath = join(rawDir, slugParts[slugParts.length - 1] + '.json');

      const rawObj: Record<string, unknown> = {};
      for (const rd of rawData) {
        rawObj[rd.source] = rd.data;
      }
      writeFileSync(rawPath, JSON.stringify(rawObj, null, 2) + '\n');
    }

    exported++;
    progress.tick();
  }

  progress.finish();
  // Stdout summary preserved so scripts that grep for "Exported N pages" keep working.
  console.log(`Exported ${exported} pages to ${outDir}/`);
}

async function runExportMissing(engine: BrainEngine, args: string[]): Promise<void> {
  validateExportMissingArgs(args);

  const repoPath = readFlag(args, '--repo');
  const sourceId = readFlag(args, '--source') ?? undefined;
  const manifestPath = readFlag(args, '--manifest') ?? undefined;
  const json = args.includes('--json');
  const write = args.includes('--write');
  const explicitDryRun = args.includes('--dry-run');
  const dryRun = explicitDryRun || !write;

  if (write && explicitDryRun) {
    throw new Error('cannot combine --write and --dry-run');
  }

  const mode = parseMode(args);

  if (write && !repoPath) {
    throw new Error('gbrain export missing --write requires --repo <path> so files are written to the intended brain repo.');
  }

  const targetRepo = repoPath ?? process.cwd();
  const manifest = await runMissingExport(engine, {
    repoPath: targetRepo,
    sourceId,
    write: write && !dryRun,
    mode,
    manifestPath,
  });

  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  printMissingSummary(manifest);
}

function validateExportMissingArgs(args: string[]): void {
  const valueFlags = new Set(['--repo', '--source', '--manifest', '--mode']);
  const booleanFlags = new Set(['--json', '--write', '--dry-run', '--complete', '--conservative']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected export missing argument: ${arg}`);
    }

    if (valueFlags.has(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i++;
      continue;
    }

    if (!booleanFlags.has(arg)) {
      throw new Error(`Unknown export missing flag: ${arg}`);
    }
  }
}

function readFlag(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseMode(args: string[]): MissingExportMode {
  const hasComplete = args.includes('--complete');
  const hasConservative = args.includes('--conservative');
  const modeIdx = args.indexOf('--mode');
  const hasMode = modeIdx !== -1;

  if (hasComplete && hasConservative) {
    throw new Error('cannot combine --complete and --conservative');
  }
  if (hasMode && (hasComplete || hasConservative)) {
    throw new Error('cannot combine --mode with --complete or --conservative');
  }

  if (hasComplete) return 'complete';
  if (hasConservative) return 'conservative';
  if (!hasMode) return 'conservative';
  const value = args[modeIdx + 1];
  if (value !== 'conservative' && value !== 'complete') {
    throw new Error('--mode must be "conservative" or "complete"');
  }
  return value;
}

function printMissingSummary(manifest: MissingExportManifest): void {
  console.log(`DB-only export reconciliation (${manifest.dry_run ? 'dry-run' : 'write'}, ${manifest.mode})`);
  console.log(`Source: ${manifest.source_id}`);
  console.log(`Repo: ${manifest.repo_path}`);
  console.log(`Scanned DB pages: ${manifest.summary.scanned}`);
  console.log(`DB-only candidates: ${manifest.summary.candidates}`);
  console.log(`Exported: ${manifest.summary.exported}`);
  console.log(`Skipped: ${manifest.summary.skipped}`);
  console.log(`Present: ${manifest.summary.present}`);
  console.log(`Mismatches: ${manifest.summary.mismatches}`);
  console.log(`Errors: ${manifest.summary.errors}`);
}
