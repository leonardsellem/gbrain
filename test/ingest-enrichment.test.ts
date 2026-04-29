import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { enrichAcceptedSource, validateEnrichmentOutput } from '../src/core/ingest/enrichment.ts';

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
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
});

describe('validateEnrichmentOutput', () => {
  test('rejects malformed output and uncited canonical candidates', () => {
    expect(() => validateEnrichmentOutput('not json')).toThrow(/valid JSON/);
    expect(() => validateEnrichmentOutput(JSON.stringify({
      people: [{ name: 'Alice' }],
    }))).toThrow(/citation/i);
  });
});

describe('enrichAcceptedSource', () => {
  test('writes cited people, organizations, concepts, relationships, and timeline entries', async () => {
    await engine.putPage('sources/demo', {
      type: 'source',
      title: 'Demo source',
      compiled_truth: 'Alice Chen at Acme discussed Async Ingest on 2026-04-29.',
      frontmatter: {},
    });

    const result = await enrichAcceptedSource({
      engine,
      sourceSlug: 'sources/demo',
      sourceTitle: 'Demo source',
      sourceText: 'Alice Chen at Acme discussed Async Ingest on 2026-04-29.',
      runner: async () => ({
        route: 'codex-oauth',
        text: JSON.stringify({
          people: [{ name: 'Alice Chen', citation: 'Alice Chen at Acme' }],
          organizations: [{ name: 'Acme', citation: 'at Acme' }],
          concepts: [{ name: 'Async Ingest', citation: 'Async Ingest' }],
          relationships: [{
            from: 'Alice Chen',
            to: 'Acme',
            type: 'works_with',
            citation: 'Alice Chen at Acme',
          }],
          timeline: [{
            date: '2026-04-29',
            summary: 'Alice Chen discussed Async Ingest at Acme.',
            citation: '2026-04-29',
          }],
        }),
      }),
    });

    expect(result.status).toBe('enriched');
    expect(result.updated_slugs).toEqual(expect.arrayContaining([
      'people/alice-chen',
      'companies/acme',
      'concepts/async-ingest',
    ]));

    const person = await engine.getPage('people/alice-chen');
    expect(person?.compiled_truth).toContain('Evidence');
    expect(person?.compiled_truth).toContain('sources/demo');

    const links = await engine.getLinks('people/alice-chen');
    expect(links.map(l => l.to_slug)).toContain('companies/acme');
    expect(links.map(l => l.to_slug)).toContain('sources/demo');

    const timeline = await engine.getTimeline('concepts/async-ingest');
    expect(timeline[0]?.summary).toContain('Alice Chen discussed');
  });

  test('low-confidence or uncited items are skipped without canonical writes', async () => {
    await engine.putPage('sources/demo', {
      type: 'source',
      title: 'Demo source',
      compiled_truth: 'Thin content.',
      frontmatter: {},
    });

    const result = await enrichAcceptedSource({
      engine,
      sourceSlug: 'sources/demo',
      sourceTitle: 'Demo source',
      sourceText: 'Thin content.',
      runner: async () => ({
        route: 'codex-oauth',
        text: JSON.stringify({
          concepts: [{ name: 'Uncited Concept' }],
          people: [],
          organizations: [],
          relationships: [],
          timeline: [],
        }),
      }),
      allowPartial: true,
    });

    expect(result.status).toBe('skipped');
    expect(await engine.getPage('concepts/uncited-concept')).toBeNull();
  });
});
