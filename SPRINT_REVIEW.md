# Sprint Review (Personal Note)

Date: 2026-02-10
Project: `de-gas-storage-tracker-bnetza`

## Goal Completed

Set up an automated daily data-analysis pipeline that:

- pulls public BNetzA data,
- computes projection scenarios,
- versions both source snapshot cache and derived analytics outputs in Git,
- publishes latest human-readable projection in `README.md`,
- runs on GitHub Actions at fixed noon GMT+1 (`11:00 UTC`).

## Final Architecture

Core script:

- `scripts/2026_gasspeicher_deutschland.py`
- responsibilities:
  - fetch `url_b` (with fallback to cache),
  - parse semicolon/comma-formatted German CSV,
  - compute projection scenarios from rolling lookback window,
  - append one row per run to `data/projections.csv`,
  - update README projection block in-place under `## Letzte Projektionen`.

Data artifacts (versioned):

- `data/bnetza_cache.csv` (latest raw snapshot / fallback source)
- `data/projections.csv` (append-only historical outputs)

Automation:

- `.github/workflows/daily-gasspeicher-projection.yml`
- daily cron + manual dispatch
- installs dependencies, runs script, commits changed data + README

## Key Implementation Decisions

- Chose **append-only CSV history** for projections to keep runs auditable and diff-friendly.
- Used **cache-first resilience** pattern: network fetch preferred, cache fallback on failure.
- Implemented **README in-place replacement** (not append) to preserve manual docs edits.
- Kept outputs in plain CSV/Markdown for maximum portability and minimal infrastructure.

## What Worked Well

- GitHub Actions is sufficient for low-volume recurring analysis tasks.
- Versioning both raw snapshot and derived output gives reproducibility and reviewability.
- Small CLI options (`--minimum`, `--lookback-days`, etc.) make the job reusable.
- Marker/section-based README update keeps docs current without manual steps.

## Pain Points / Risks Observed

- Time zone nuance: `11:00 UTC` equals `12:00 GMT+1` but not always local Berlin noon in DST.
- Public source schema can drift (column names/order/encoding).
- CI push permissions and branch context must be handled carefully.
- Frequent data commits can inflate repo history over long periods.

## Reusable Pattern For Similar Projects

1. Ingest:
   - fetch public dataset,
   - persist latest raw snapshot to `data/<source>_cache.csv`,
   - fallback to cache if fetch fails.
2. Transform/Analyze:
   - normalize schema defensively,
   - compute deterministic outputs,
   - append run-level row(s) to `data/<analysis>.csv`.
3. Publish:
   - update one README section in-place with latest narrative summary.
4. Automate:
   - schedule Action,
   - commit only changed generated artifacts.
5. Operate:
   - keep run logs readable,
   - fail hard only when no network and no cache.

## Checklist For Next Project

- [ ] Define clear raw cache file and append-only analytics file.
- [ ] Build parser tolerant to locale/encoding/schema changes.
- [ ] Add fallback strategy for network failure.
- [ ] Make cron schedule explicit about timezone assumptions.
- [ ] Ensure workflow commits only generated files.
- [ ] Add README auto-summary replacement in a bounded section.
- [ ] Validate first baseline run and commit baseline artifacts.
- [ ] Document local run + CI behavior clearly.

## Suggested Upgrades Later

- Add unit tests for parser and projection math.
- Add data-quality checks (missing dates, outlier jumps, stale source detection).
- Add retention policy or periodic squashing for very large history files.
- Optionally switch to Parquet + lightweight report generation if scale grows.
