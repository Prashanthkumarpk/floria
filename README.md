# Floria — NL2OData Explorer

> **Small Language Models for NL2OData: A No-Fine-Tuning Approach Validated on SAP Fiori**  
> Prasanthkumar Yernagula · Independent Researcher  
> Submitted to ICON India 2026 (IEEE Xplore publication target)

Floria is a browser-based SAP Fiori application that translates plain-English questions into OData v4 queries using small language models running entirely on-device via WebGPU. No query text ever reaches a remote inference server. Five models from four providers (0.5B–3.8B parameters, none fine-tuned on OData) were evaluated against a 100-item benchmark, achieving an average Effective Success Rate (ESR) of **87.8%** across five structural query types.

---

## Why This Exists

SAP chose OData as the standard data access layer for Fiori applications. Business users who need ad-hoc reports must wait for developers to write queries. A natural-language interface removes that bottleneck — but a simple cloud-LLM proxy is often prohibited: many markets SAP serves impose data-governance restrictions, and HIPAA-compliant environments explicitly forbid this pattern.

WebGPU provides the alternative. It is a W3C-standardised API that allows browsers to run transformer models natively on the user's GPU via compute shaders compiled with Apache TVM. WebLLM achieves throughput comparable to server-side inference on the same hardware. The research question this project answers is: *can a sub-4B model perform NL-to-OData translation, at acceptable accuracy, using only schema injection — with no gradient updates?*

---

## Five-Stage Pipeline

```
User types question
        │
        ▼
 ┌──────────────┐
 │   NL Input   │
 └──────┬───────┘
        │
        ▼
 ┌──────────────────┐        ┌───────────────────────────┐
 │  Query Plan      │◄───────│  WebLLM (on-device GPU)   │
 │  (LLM or direct) │        │  Qwen / Gemma / Llama / Phi│
 └──────┬───────────┘        └───────────────────────────┘
        │
        ▼
 ┌──────────────────┐
 │ Schema Validate  │  ← QueryValidator (Levenshtein suggestions)
 └──────┬───────────┘
        │
        ▼
 ┌──────────────┐
 │  OData URL   │  ← ODataQueryBuilder (injection guard, $top clamp)
 └──────┬───────┘
        │
        ▼
 ┌──────────────┐
 │   Results    │  ← Northwind v4 via local CORS proxy
 └──────────────┘
```

If the model has not yet loaded, a keyword-scoring fallback (`detectEntity` + `extractKeyTerm`) builds the query plan directly without an LLM call.

---

## Schema Injection Prompt — Four-Block Design

All five models use the same system prompt. No model was fine-tuned.

| Block | Contents |
|---|---|
| `[ENTITIES]` | Field names and types for all seven Northwind entities |
| `[FORMAT]` | Required JSON output shape (`entity`, `filter`, `orderby`, `top`) |
| `[RULES]` | OData v4 filter grammar with WRONG/RIGHT example pairs for `substringof` |
| `[EXAMPLES]` | 21 few-shot demonstrations, at least two per structural category |

Temperature is fixed at **0.1** for maximum determinism. `response_format:{type:"json_object"}` is intentionally omitted — in WebLLM v0.2.84 it triggers a WASM binding crash in the TVM grammar compiler. Instead, markdown fences are stripped and the first `{...}` block in the model output is extracted and parsed.

---

## Post-Processor — Six-Category Error Correction

Small models trained predominantly on OData v2 data produce predictable, correctable errors. The post-processor handles six categories:

| Category | Error pattern | Correction applied |
|---|---|---|
| **T3 substringof** | `substringof('chai', ProductName) eq true` (OData v2) | → `contains(ProductName,'chai')` (OData v4), both argument orders handled |
| **T5 collapsed OR** | `Country eq 'Germany or France'` | → `Country eq 'Germany' or Country eq 'France'` |
| **Entity aliasing** | `Catalog/Products`, `OrderDetails` | → `Products`, `Order_Details` |
| **Field aliasing** | `Country` on the Orders entity | → `ShipCountry` |
| **Case sensitivity** | `startswith(LastName,'d')` (Northwind is title-cased) | → `startswith(LastName,'D')` |
| **Navigation prefix** | `Orders.ShipCountry` | → `ShipCountry` |

The prompt and post-processor are identical across all five models. Switching models requires only a different WebLLM model ID.

---

## Schema Validator

`QueryValidator` tokenises the `$filter` expression **after** stripping quoted string literals (an earlier version that tokenised first was generating false-positive "field not found" errors for values like `ShipCountry eq 'France'`). For any unrecognised field name it computes Levenshtein distance to every known field on that entity and surfaces the closest match within edit distance 3:

```
Field 'OrderYear' does not exist on Orders — did you mean 'OrderDate'?
```

Validation is advisory: the request proceeds regardless so the OData server's own error message is also visible. Only two conditions hard-reject: SQL injection sequences (`;`, `--`, `/*`, `<script`) and malformed sort direction.

---

## Models Tested

| Model | Provider | Params | Size (Q4F16) |
|---|---|---|---|
| Qwen2.5-0.5B-Instruct | Alibaba | 0.5B | ≈ 300 MB |
| Qwen2.5-Coder-1.5B-Instruct | Alibaba | 1.5B | ≈ 900 MB |
| Gemma-2-2B-it | Google | 2B | ≈ 1.5 GB |
| Llama-3.2-3B-Instruct | Meta | 3B | ≈ 2.0 GB |
| Phi-3.5-mini-instruct | Microsoft | 3.8B | ≈ 2.2 GB |

All weights are downloaded from HuggingFace on first launch and cached in IndexedDB. Subsequent launches use the cache and load in under 4 seconds.

---

## Benchmark Results

100-item benchmark · 20 queries per structural type · Northwind OData v4 service  
A query is **successful** if the model selects the correct entity AND the query returns at least one record.

| Model | T1 | T2 | T3 | T4 | T5 | ESR |
|---|---|---|---|---|---|---|
| Qwen-0.5B | 85% | 90% | 55% | 90% | 90% | **82%** |
| Qwen-Coder-1.5B | 90% | 100% | 80% | 100% | 90% | **92%** |
| Gemma-2B | 95% | 90% | 65% | 95% | 95% | **88%** |
| Llama-3B | 95% | 95% | 65% | 95% | 95% | **89%** |
| Phi-3.5B | 80% | 100% | 80% | 100% | 80% | **88%** |

**Query taxonomy:**

| Type | Description | Example |
|---|---|---|
| T1 | Entity read — no filter | "list all suppliers" |
| T2 | Numeric range comparison | "products under $15" |
| T3 | String match (`contains` / `startswith`) | "products with chai in the name" |
| T4 | Categorical equality | "customers from Germany" |
| T5 | Multi-value disjunction | "customers from Germany or France" |

T3 is the hardest category across all models — the model must use OData v4 `contains(Field,'term')` syntax rather than the SQL `LIKE` operator or the OData v2 `substringof` function. T5 is checked before T3 in the classifier because a query with both OR and contains is more specifically a disjunction.

---

## Technology Stack

| Layer | Technology |
|---|---|
| UI framework | OpenUI5 1.130.2 — SAP standard Fiori design system |
| Language | TypeScript (UI5 toolchain transpilation) |
| AI inference | WebLLM / MLC-LLM (`@mlc-ai/web-llm`) via WebGPU |
| OData target | Northwind v4 (`services.odata.org/V4/Northwind/Northwind.svc/`) |
| CORS proxy | Express.js (`srv/server.mjs`, port 4004) |
| Build / dev | `@sap/ui5-tooling`, `fiori run` (port 8081) |

---

## Getting Started

**Requirements:** Node.js LTS · Chrome or Edge with WebGPU enabled (discrete or integrated GPU recommended for Phi-3.5B)

```bash
# 1. Install dependencies
npm install

# 2. Start the CORS proxy (must be running first)
node srv/server.mjs

# 3. In a second terminal, start the UI5 dev server
npm start
# opens http://localhost:8081/index.html
```

**First launch:** The selected model is downloaded from HuggingFace (~300 MB for Qwen-0.5B, up to ~2.2 GB for Phi-3.5B) and compiled to WebGPU shaders. A progress bar tracks the download. All subsequent launches use the IndexedDB cache.

**Type-check without building:**
```bash
npx tsc --noEmit
```

---

## Project Structure

```
floria/
├── webapp/
│   ├── controller/
│   │   └── Chat.controller.ts     # Pipeline orchestration, benchmark runner
│   ├── util/
│   │   ├── WebLLMService.ts       # LLM lifecycle + four-block schema prompt
│   │   ├── QueryValidator.ts      # Field validation + Levenshtein suggestions
│   │   └── ODataQueryBuilder.ts   # QueryPlan → OData v4 URL + injection guard
│   ├── view/
│   │   └── Chat.view.xml          # SAP ObjectPageLayout — query, results, research dashboard
│   └── libs/web-llm/loader.js     # ESM bridge: loads WebLLM into window.mlc
├── srv/
│   └── server.mjs                 # Express CORS proxy (port 4004)
└── CLAUDE.md                      # Full architecture reference
```

---

## Research Dashboard

The application includes a live implementation of the paper's evaluation framework:

- **Session statistics strip** — Total Queries · AI Mode · Direct Mode · Validator Catches · Server Errors · ESR %
- **Query taxonomy classifier** — assigns T1–T5 label to every query in real time
- **Query history panel** — timestamped entries with entity, type, validation state, timing, and confidence
- **Benchmark runner** — executes the 10-query embedded benchmark and populates a results table with entity match (✓/✗), result presence (✓/✗), and timing per query

---

## Known Limitations

- **T3 accuracy is the ceiling** — string-match queries are the hardest for all sub-4B models without fine-tuning. The post-processor closes part of the gap but cannot recover every case.
- **No `$expand` support** — navigation property expansion is not in the benchmark taxonomy and is not handled by the schema injection prompt.
- **ESR success definition** — a query is counted as successful if it returns any record. A filter that returns a subset of the correct entity still passes; a wrong entity that returns records also passes. Both are acknowledged limitations in the paper (Section V).
- **WebGPU required** — Firefox does not support WebGPU as of this writing. Use Chrome or Edge.

---

## Citation

```bibtex
@inproceedings{yernagula2026nl2odata,
  title     = {Small Language Models for NL2OData: A No-Fine-Tuning Approach Validated on SAP Fiori},
  author    = {Yernagula, Prasanthkumar},
  booktitle = {Proceedings of ICON India 2026},
  publisher = {IEEE},
  year      = {2026}
}
```
