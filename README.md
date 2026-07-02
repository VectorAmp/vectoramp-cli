<div align="center">
  <a href="https://vectoramp.com/">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-full-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-full-dark.svg">
      <img alt="VectorAmp Logo" src=".github/images/logo-full-dark.svg" width="50%">
    </picture>
  </a>
</div>

# VectorAmp CLI

Official command-line interface for VectorAmp datasets, ingestion, semantic search, and Intelligence (RAG).

- Binary: `vectoramp` with short alias `va`
- Node.js 18+
- Auth via `VECTORAMP_API_KEY` or local config
- Default API: `https://api.vectoramp.com`
- Dataset creation is SABLE-only; the CLI always sends `index_type: sable`
- Every command supports `--json` for machine-readable output

## Install

```bash
npm install -g @vectorampdb/cli
```

One-command installer:

```bash
curl -fsSL https://raw.githubusercontent.com/vectoramp/vectoramp-cli/main/scripts/install.sh | bash
```

From source:

```bash
git clone https://github.com/vectoramp/vectoramp-cli.git
cd vectoramp-cli
npm ci
npm run build
npm link
```

## Configure

```bash
export VECTORAMP_API_KEY=vsk_...            # 64-hex API key
export VECTORAMP_BASE_URL=https://api.vectoramp.com   # optional

vectoramp config set --api-key vsk_...
vectoramp config set --base-url https://api.vectoramp.com
vectoramp config use ds_123                 # default dataset
vectoramp config show
```

Config is stored at `~/.config/vectoramp/config.json`. `VECTORAMP_API_KEY`, `VECTORAMP_BASE_URL`, and `VECTORAMP_API_PREFIX` override local config.

## Quick start

```bash
# Create a dataset — name only is enough (VectorAmp-Embedding-4B, dim 2560, cosine, SABLE)
vectoramp datasets create docs

# Make it the active dataset, then add some text
vectoramp config use ds_123
vectoramp datasets add-texts "VectorAmp uses SABLE for billion-scale vector search."

# Search and ask
vectoramp datasets search "how does SABLE work?" --top-k 5
vectoramp ask "Summarize this dataset" --stream
```

## Datasets

```bash
vectoramp datasets list --limit 50

# Minimal create (defaults: VectorAmp-Embedding-4B / dim 2560 / cosine / sable)
vectoramp datasets create docs

# Fine-grained create
vectoramp datasets create docs --openai small --metadata '{"team":"support"}'
vectoramp datasets create docs --embedding-provider cohere --embedding-model embed-v3 --dim 1024
vectoramp datasets create docs --hybrid           # enable dense + sparse hybrid search
vectoramp datasets create docs --dim 768 --metric dot

vectoramp datasets get ds_123
vectoramp datasets stats ds_123
vectoramp datasets delete ds_123 --yes
```

`index_type` is always forced to `sable` and is never accepted from the caller. The create body uses the `dim` field (not `dimension`).

## Search

```bash
# Text search (top_k defaults to 10)
vectoramp --dataset ds_123 datasets search "refund policy" --top-k 5

# Reranked search (VectorAmp-Rerank-v1)
vectoramp --dataset ds_123 datasets search "refund policy" --rerank

# Metadata filters (repeatable)
vectoramp --dataset ds_123 datasets search "tickets" --filter team=support --filter priority=2

# Hybrid (dense + sparse) search
vectoramp --dataset ds_123 datasets search "refund policy" --sparse refund --alpha 0.4

# Raw vector search
vectoramp --dataset ds_123 datasets search anything --vector '[0.1,0.2,0.3]'
```

## Vectors

```bash
# Insert a single raw vector. Integer ids stay JSON numbers on the wire.
vectoramp --dataset ds_123 vectors insert --id 42 --values '[0.1,0.2,0.3]' --metadata '{"src":"docs"}'

# Insert a batch
vectoramp --dataset ds_123 vectors insert --vectors '[{"id":1,"values":[0.1,0.2]},{"id":"doc-2","values":[0.3,0.4]}]'
```

## Documents

Document listing uses cursor pagination. Pass the response `next_cursor` back with `--cursor`; do not assume offsets or totals. Downloads write retained original bytes and follow API/storage redirects. Omit `--output` to stream bytes to stdout.

```bash
vectoramp documents list ds_123 --limit 50 --status ready
vectoramp documents list ds_123 --cursor eyJpZCI6...
vectoramp documents download ds_123 doc_456 --output ./original.pdf
```

## Ingestion

Create reusable sources (all source types, including Confluence):

```bash
vectoramp sources web https://docs.example.com --name docs-web --config '{"include_assets":true,"max_assets_per_page":5}'
vectoramp sources s3 s3://my-bucket/docs --config '{"region":"us-west-2"}'
vectoramp sources gcs gs://my-bucket/docs --config '{"prefix":"docs/","auth_mode":"oauth"}'
vectoramp sources gdrive google-folder-id
vectoramp sources jira --config '{"cloud_id":"...","projects":["ENG"],"include_comments":true}'
vectoramp sources confluence https://acme.atlassian.net --config '{"spaces":["ENG"],"username":"u","api_token":"t"}'
vectoramp sources file_upload --name "Local upload"

vectoramp sources list
vectoramp sources get src_123
```

Create a source and start a job in one step (`sources ingest` creates the source, then starts a job via `POST /ingestion/jobs`):

```bash
vectoramp --dataset ds_123 sources ingest web https://docs.example.com --config '{"include_assets":true}'
vectoramp --dataset ds_123 sources ingest confluence https://acme.atlassian.net --config '{"spaces":["ENG"]}'
```

Local file ingestion hides the presigned upload flow — it auto-creates a `file_upload` source, initializes the upload, PUTs each file's bytes, completes the upload, then starts the ingestion job:

```bash
vectoramp --dataset ds_123 datasets ingest-files ./docs
vectoramp --dataset ds_123 datasets ingest-files ./docs --extensions md,txt --source-name "Product docs"
vectoramp --dataset ds_123 datasets ingest-files ./docs --source-id src_123
```

## Jobs

```bash
vectoramp jobs list --dataset-id ds_123
vectoramp jobs get job_123                 # one-shot status
vectoramp jobs get job_123 --poll          # poll until completed/failed/cancelled
vectoramp jobs retry job_123
```

## Schedules

```bash
vectoramp schedules list
vectoramp schedules create --source-id src_1 --dataset-id ds_1 --cron "0 0 * * *" --timezone UTC
vectoramp schedules update sch_1 --disable
vectoramp schedules trigger sch_1
vectoramp schedules delete sch_1 --yes
```

## Ask (RAG)

```bash
# Defaults: top_k 5, include_sources true, dataset "all" when unscoped
vectoramp ask "What changed in the latest release?"
vectoramp ask "Summarize my dataset" --dataset ds_123 --stream
vectoramp ask "List open risks" --dataset ds_123 --top-k 12
```

## Interactive mode

Run `vectoramp` with no subcommand to enter a slash-command REPL. The session opens with a `[ VectorAmp ]` banner showing the working directory and active dataset; the prompt itself shows the active dataset (`VectorAmp:ds_123 ›`). In non-TTY environments it falls back to a plain line reader.

```text
╭────────────────────────────────────────╮
│              [ VectorAmp ]             │
│                                        │
│ cwd ~/work/product-docs                │
│ ctx active dataset: ds_123             │
╰────────────────────────────────────────╯

Type / for commands. Plain text asks Intelligence.
```

Interactive commands:

```text
/help                     Show interactive commands
/datasets                 Pick an active dataset from a filterable list
/use <dataset-id>         Switch directly to a dataset by id
/context (/status)        Show the active dataset and working directory
/search <query>           Semantic search in the active dataset
/add-texts <text>         Add inline text to the active dataset
/ingest-files <path>      Upload local text files into the active dataset
/ask <question>           Ask Intelligence (keeps multi-turn context)
/reset (/new)             Clear the conversation history
/sources <type> <uri>     Create an ingestion source
/config                   Show resolved local CLI config
/exit (/quit)             Leave interactive mode
```

Niceties: type `/` to filter the command palette; ↑/↓ to highlight, Tab/Enter to complete. Plain text without a slash is treated as `/ask` against the active dataset and keeps a rolling multi-turn conversation. `--history <n>` controls how many prior messages are included (default 10). Switching datasets resets the conversation.

## Multi-turn conversations

The Intelligence API is stateless, so follow-up questions need prior turns sent as context. One-off `ask` commands are single-turn. In interactive mode the REPL keeps the running conversation and sends a window of recent messages with each follow-up, so questions like "and why is that?" resolve against earlier turns.

## Programmatic use

The package also exports a typed client for embedding the same behavior in scripts:

```ts
import { VectorAmpClient, confluenceSource } from '@vectorampdb/cli';

const client = new VectorAmpClient({ apiKey: process.env.VECTORAMP_API_KEY!, baseUrl: 'https://api.vectoramp.com', apiPrefix: '' });

const dataset = await client.createDataset({ name: 'docs', hybrid: true });
await client.addTexts(dataset.id, ['VectorAmp uses SABLE.']);
await client.search(dataset.id, 'how does SABLE work?', { topK: 5, rerank: true });
await client.ingestSource(dataset.id, confluenceSource({ cloudId: 'cid', spaces: ['ENG'] }));
```

## Method reference (client)

| Method | Required args | Optional |
|---|---|---|
| `listDatasets(params?)` | — | `limit`, `offset` |
| `getDataset(id)` | `id` | — |
| `createDataset(body)` | `body.name` | `dim` (inferred for built-in models), `metric` (cosine), `embedding`, `hybrid`, `metadata`. `index_type` is always `sable`. |
| `deleteDataset(id)` | `id` | — |
| `stats(id)` | `id` | — |
| `search(id, query, options?)` | `id`, `query` (string \| float[] \| object) | `topK` (10), `filters`, `hybrid`, `sparseQuery`, `alpha`, `rerank` (`true` expands to the full object), `includeDocuments`, `includeMetadata` |
| `embed(id, input, options?)` | `id`, `input` (string \| string[]) | model/provider overrides |
| `insert(id, vectors)` / `insertVectors(id, vectors)` | `id`, `vectors` (record \| record[]) | `id` accepts string **or** integer; integers stay JSON numbers |
| `addTexts(id, texts, metadata?, ids?)` | `id`, `texts` (string \| string[]) | `metadata` (shared or per-text), `ids` (auto-generated when omitted); copies text into `metadata.text` |
| `listDocuments(id, params?)` | `id` | `limit`, `cursor`, `status` |
| `downloadDocument(id, documentId)` | `id`, `documentId` | returns `ArrayBuffer` |
| `createSource(input)` | `input` (descriptor or URL string) | — |
| `listSources(params?)` / `getSource(id)` | — / `id` | `limit`, `offset` |
| `ingestSource(id, src, options?)` | `id`, `src` | `pipelineId` — creates the source then `POST /ingestion/jobs` |
| `ingestFiles(id, files, options?)` | `id`, `files` (IngestFile[]) | `sourceId`, `sourceName`, `pipelineId` — runs the presigned upload flow |
| `startJob(body)` / `listJobs(params?)` / `getJob(id)` / `retryJob(id)` | per signature | — |
| `waitForJob(id, options?)` | `id` | `intervalMs`, `timeoutMs`, `onPoll` |
| `listSchedules / getSchedule / createSchedule / updateSchedule / deleteSchedule / triggerSchedule` | per signature | — |
| `ask(body)` / `askStream(body)` | `body.query` | `datasetId` ("all"), `topK` (5), `includeSources` (true), `conversationHistory` |
| `createSession / listSessions / getSession / deleteSession / appendMessage / listMessages` | per signature | — |

Source helpers (`@vectorampdb/cli`): `webSource`, `s3Source`, `gcsSource`, `googleDriveSource`, `jiraSource`, `confluenceSource`, `fileUploadSource`, and the generic `source({ sourceType, config })` escape hatch.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
