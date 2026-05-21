---
name: citation-fixer
version: 1.0.0
description: |
  Audit and fix citation formatting across brain pages. Ensures every fact has
  an inline [Source: ...] citation matching the standard format.
triggers:
  - "fix citations"
  - "citation audit"
  - "check citations"
tools:
  - search
  - get_page
  - put_page
  - list_pages
mutating: true
---

# Citation Fixer Skill

## Contract

This skill guarantees:
- Every brain page is scanned for citation compliance
- Missing citations are flagged with specific location
- Malformed citations are fixed to match the standard format
- Results reported with counts (scanned, fixed, remaining)

## Phases

1. **Scan pages.** List pages and read each one, checking for inline `[Source: ...]` citations.
2. **Identify issues:**
   - Facts without any citation
   - Citations missing date
   - Citations missing source type
   - Citations with wrong format
   - Citations that put Obsidian wikilinks or nested Markdown links inside
     `[Source: ...]`
3. **Fix format issues.** Rewrite malformed citations to match `skills/conventions/quality.md`.
   Move a deterministic internal source wikilink adjacent to the plain citation:
   `[[sources/readwise/example|Readwise highlight]] [Source: Readwise highlight, 2026-05-21]`.
   Whole-citation external links remain valid:
   `[Source: X/@handle, 2026-05-21](https://example.com/post)`.
   If source/date pairing is ambiguous, report it instead of guessing.
4. **Report results.** Count: pages scanned, citations found, issues fixed, remaining gaps.

## Output Format

```
Citation Audit Report
=====================
Pages scanned: N
Citations found: N
Issues fixed: N
Remaining gaps: N (pages with uncitable facts)
```

## Anti-Patterns

- Inventing citations for facts that have no source
- Removing facts that lack citations (flag them, don't delete)
- Fixing citations without reading the full page context
- Batch-fixing without checking quality (test-before-bulk convention)
