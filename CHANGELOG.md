# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

## [Unreleased]

### Changed

- **Breaking:** Intelligence asks now scope with `dataset_ids` (a list). `POST /intelligence/query`
  retired the singular `dataset_id` and answers any request carrying it with a 400 — which the CLI
  sent on **every** ask, because it defaulted the field to `"all"`. That default is gone: an
  unscoped ask now omits the field, which is how the API spells "every dataset you can see".
- `VectorAmpClient.ask`/`askStream` reject a `datasetId`/`dataset_id` body field locally, naming
  `datasetIds` as the replacement, rather than letting the request bounce off the API.

### Added

- `vectoramp ask --datasets <ids>` scopes one question to several datasets. Repeat the flag or
  comma-separate the ids. (The name is `--datasets` because the global `-d, --dataset` claims the
  singular flag.)

## [0.4.0] - 2026-08-20

### Added

- Add `github` and `gitlab` source type commands.
- Add `githubSource` and `gitlabSource` source helpers to the programmatic API.

## [0.3.0] - 2026-07-20

### Added

- Add metadata-schema fields when creating datasets.
- Add commands for metadata-schema merge/patch and full replacement.
- Document create, merge, and replace schema workflows.

## [0.2.0] - 2026-07-14

### Added

- Add vector deletion commands and client support for deleting selected vector IDs.
- Add organization secret commands and OpenAI embedding secret wiring for dataset creation.

## [0.1.0] - 2026-07-02

### Added

- Initial public-ready package baseline for VectorAmp SDK/CLI migration to GitHub.
- GitHub Actions CI workflow.
