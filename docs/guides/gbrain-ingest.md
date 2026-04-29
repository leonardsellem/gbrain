# gbrain-ingest

`gbrain-ingest` is the agent-native ingest entrypoint. It validates a text, URL,
or local text file, enqueues a protected `gbrain-ingest` Minions job, prints a
job id immediately, and returns. Workers do enrichment, canonical writes,
database import, and embeddings later.

```bash
printf '%s\n' 'Remember this: retrieval notes should cite sources.' | gbrain-ingest
gbrain-ingest --url https://example.com/article --json
gbrain ingest --file ./notes/meeting.md --title "Meeting notes"
gbrain jobs get <job-id>
```

## Modes

- `--mode explicit` preserves the submitted source/provenance and is for direct
  user or agent requests.
- `--mode signal` is for hooks. Signal payloads must be distilled summaries or
  explicit `remember this` content, never raw prompts, tool output, or full
  transcripts.

## Worker Contract

Workers claim jobs from the shared PostgreSQL Minions queue. The foreground
command only validates and enqueues; it does not fetch URLs, call inference,
write wiki pages, write canonical pages, or embed content.

The ingest worker writes accepted source pages to the configured filesystem
brain source when `sources.local_path` is set, then imports the same markdown
into PostgreSQL/searchable state with embeddings deferred. If no local path is
configured for the target source, the worker records `wiki_write:
skipped_no_local_path` and still imports into PostgreSQL. Enrichment uses Codex
OAuth with `gpt-5.4-mini` only. OpenAI API keys are not read for inference.
Embeddings use the existing scoped embedding-key path and unchanged chunks reuse
existing vectors.

## Status And Debugging

```bash
gbrain jobs list --status waiting --limit 50
gbrain jobs list --status active
gbrain jobs get <job-id>
gbrain jobs supervisor status --json
```

Progress phases include `resolve`, `wiki_write`, `db_import`, optional
`enrich`, and `done`. Repeated identical submissions coalesce by idempotency key
or complete as `no-op`.

## Hook Canaries

Unit tests prove the hook emits/enqueues distilled payloads. They do not prove a
model saw dynamic context. Treat OpenClaw `agent:bootstrap` as the supported
prompt-visible path unless a live canary proves another hook surface reaches the
final model prompt.
