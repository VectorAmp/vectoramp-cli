# VectorAmp CLI

Official command-line interface for VectorAmp datasets, ingestion, semantic search, and Intelligence.

- Binary: `vectoramp` with short alias `va`
- Node.js 18+
- Auth via `VECTORAMP_API_KEY` or local config
- Default API: `https://api.vectoramp.com`
- Dataset creation is SABLE-only; the CLI always sends `index_type: sable`

## Install

```bash
npm install -g @vectoramp/cli
```

One-command installer:

```bash
curl -fsSL https://gitlab.com/VectorAmp/SDK/CLI/-/raw/main/scripts/install.sh | bash
```

From source:

```bash
git clone git@gitlab.com:VectorAmp/SDK/CLI.git
cd CLI
npm ci
npm run build
npm link
```

## Configure

```bash
export VECTORAMP_API_KEY=va_live_...
export VECTORAMP_BASE_URL=https://api.vectoramp.com # optional

vectoramp config set --api-key va_live_...
vectoramp config set --base-url https://api.vectoramp.com
vectoramp config use ds_123
vectoramp config show
```

Config is stored at `~/.config/vectoramp/config.json`. `VECTORAMP_API_KEY`, `VECTORAMP_BASE_URL`, and `VECTORAMP_API_PREFIX` override local config.

## One-off commands

```bash
vectoramp datasets list
vectoramp datasets create docs --dimension 1536 --metadata '{"team":"support"}'
vectoramp datasets get ds_123
vectoramp datasets delete ds_123 --yes

vectoramp --dataset ds_123 datasets search "refund policy" --top-k 5
vectoramp --dataset ds_123 datasets add-texts "VectorAmp uses SABLE for vector search."
vectoramp --dataset ds_123 datasets add-texts --file ./intro.md
vectoramp --dataset ds_123 datasets ask "What is in this dataset?" --stream

vectoramp ask "Summarize my active dataset" --dataset ds_123 --stream
```

## Ingestion

Create reusable sources:

```bash
vectoramp sources web https://docs.example.com --name docs-web
vectoramp sources s3 s3://my-bucket/docs --config '{"recursive":true}'
vectoramp sources gdrive google-folder-id
vectoramp sources file_upload --name "Local upload"
```

Start ingestion from a source descriptor:

```bash
vectoramp --dataset ds_123 sources ingest web https://docs.example.com
vectoramp --dataset ds_123 sources ingest s3 s3://my-bucket/docs --config '{"recursive":true}'
```

Local file ingestion reads common text formats (`.md`, `.txt`, `.json`, `.csv`, `.html`, `.yaml`, etc.), creates a minimal `file_upload` source automatically when no source id is supplied, then uploads file contents to the filesystem ingestion endpoint:

```bash
vectoramp --dataset ds_123 datasets ingest-files ./docs
vectoramp --dataset ds_123 datasets ingest-files ./docs --extensions md,txt --source-name "Product docs"
vectoramp --dataset ds_123 datasets ingest-files ./docs --source-id src_123
```

## Interactive mode

Run `vectoramp` with no subcommand to enter a polished slash-command REPL inspired by Claude Code/Codex-style CLIs. The session opens with a `[ VectorAmp ]` banner, current working directory, and active dataset context.

```text
╭────────────────────────────────────────╮
│              [ VectorAmp ]             │
╰────────────────────────────────────────╯
cwd /work/product-docs
ctx active dataset: ds_123

────────────────────────────────────────────────────────
vectoramp › /se
 /search     Semantic search in the active dataset
```

Interactive niceties:

- Type `/` to show a filtered command palette with commands and descriptions.
- Use ↑/↓ to move the highlighted command.
- Press Tab to complete the highlighted slash command.
- Run `/use` to fetch your datasets and choose from a filterable arrow-key picker.
- Plain text without a slash is treated as `/ask` against the active dataset.

Common commands:

```text
/help
/use
/search how does SABLE work?
/add-texts SABLE is VectorAmp's billion-scale index architecture.
/ingest-files ./docs
/ask summarize this dataset
/sources web https://docs.example.com
/config
/exit
```

## UX notes

Network calls use spinners. Local file ingestion shows a progress bar while files are collected and a spinner while uploading. `ask --stream` uses Server-Sent Events when the API supports `/intelligence/query/stream`, with fallback to the non-streaming ask endpoint.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```
