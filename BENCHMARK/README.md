# Floria benchmark artifacts

| Path | What it is |
|---|---|
| `Archive/floria_benchmark_<Model>_2026-09-30.csv` | The original ESR-only runs (no filter/URL columns). Not used by the scorer. |
| `gold/gold_queries.json` | One gold OData v4 query per benchmark item (100), aligned to `BENCHMARK_QUERIES` in `webapp/controller/Chat.controller.ts`. `alt` = accepted equivalents; `review` = ambiguous readings awaiting author sign-off. |
| `runs/*.json` | Raw run files exported from the app's **JSON** button (one per model). Contain every generated query plan, OData URL, HTTP status, record count, and the raw LLM text. |
| `exact_match/` | Scorer output: `summary.json`, `summary.md` (tables + LaTeX rows), `mismatches.json` (input for failure-case analysis). |

## Reproducing the numbers

1. `npm start` (starts the proxy with `.env` loaded, plus the UI). Pick a model, wait for **Ready**.
   - **On-device models** (the paper's subject): the five WebLLM entries.
   - **Cloud baseline**: the two Claude entries route through the proxy to AWS Bedrock with the *same* prompt, post-processor, validator and scoring. Copy `.env.example` to `.env` and set `AWS_BEARER_TOKEN_BEDROCK` first; the proxy log says whether Bedrock is enabled.
   - **Keyword baseline**: "Direct (keyword baseline)" runs Floria's no-model fallback planner.
2. Research Dashboard → **100** queries × **3** runs (the ×N control) → click **JSON** (and **Download** for the Excel CSV, which ends with a summary block incl. mean ± sd across runs).
3. Save the JSON into `BENCHMARK/runs/`. Repeat per model.
4. `npm run check-gold` (gold ↔ controller consistency) then `npm run score`. Repetitions are aggregated per model into mean ± sample sd; baselines appear as extra rows.

**Metrics.** ESR = entity matched AND ≥1 record returned. EM = entity matched AND normalized `$filter` ∈ {gold.filter} ∪ gold.alt. **ESR false positives** = queries ESR passed but EM failed (wrong filter or wrong entity that still returned rows); the FP rate is reported over all ESR passes. Normalization lowercases, unifies quotes, trims whitespace, strips redundant parentheses, canonicalizes numerals (`15.0`→`15`), and sorts operands when a level uses a single connector (`A or B` ≡ `B or A`). `$top` / `$orderby` are logged but do not affect EM.

The app computes EM live (Expected Query / Generated Query / EM columns in the dashboard and CSV) by loading the gold file through the proxy at `http://localhost:4004/gold/gold_queries.json`; `npm run score` recomputes it offline from `runs/*.json` and is the reproducible reference. `node scripts/score-exact-match.mjs --self-test` exercises the normalization rules and `npm run check-parity` confirms the in-app and offline normalizers agree.
