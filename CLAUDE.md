# Floria — NL2OData Explorer: Architecture Guide

This document is the authoritative reference for the Floria codebase. It explains
every layer of the application — what it is, why it was built that way, and how
the pieces fit together. Read this before making changes; update it when the
architecture changes.

---

## 1. What Floria Is

Floria is a browser-based SAP Fiori application that lets users query the
**Northwind OData v4** database using plain English. It is also a research
prototype: the application implements and demonstrates the evaluation framework
described in the paper

> *NL2OData: Natural Language to OData Query Translation Using On-Device LLMs*

submitted to **ICON India 2026** (IEEE Xplore publication target).

The application runs the entire AI inference pipeline on-device in the browser
using WebGPU. No query text ever reaches a remote inference server.

---

## 2. Technology Stack

| Layer | Technology | Why |
|---|---|---|
| UI framework | **OpenUI5 1.130.2** | SAP standard; rich data binding, Fiori design system |
| Layout | `sap.uxap.ObjectPageLayout` | Standard pattern for detail-heavy Fiori apps |
| Language | **TypeScript** (transpiled via UI5 toolchain) | Type safety on OData field names; catches schema mismatches at compile time |
| AI inference | **WebLLM / MLC-LLM** (npm `@mlc-ai/web-llm`) | Runs LLM in browser via WebGPU — no server, no API key |
| Model | **Qwen2.5-0.5B-Instruct, Q4F16** quantisation | Smallest capable model; fits integrated GPU VRAM; 300 MB cached in IndexedDB |
| OData target | **Northwind v4** (`services.odata.org/V4/Northwind/Northwind.svc/`) | Public, stable, well-known for demos |
| CORS proxy | **Express.js** (`srv/server.mjs`, port 4004) | Northwind does not set CORS headers; proxy adds them |
| Build / dev | `@sap/ui5-tooling`, `fiori run` (port 8081) | Standard SAP Fiori toolchain |

---

## 3. How to Run

```bash
# Terminal 1 — CORS proxy (must be running before the app)
node srv/server.mjs

# Terminal 2 — UI5 dev server
npm start          # or: npx fiori run --open index.html
```

Open `http://localhost:8081/index.html` in Chrome or Edge (WebGPU required for AI mode).

**First launch:** The LLM model (~300 MB) is downloaded from HuggingFace and
cached in IndexedDB. A progress bar shows the download. Subsequent launches use
the cache and load in under 4 seconds.

**Type-check without building:**
```bash
npx tsc --noEmit
```

---

## 4. Directory Structure

```
floria/
├── webapp/
│   ├── Component.ts                  # UI5 app entry point
│   ├── manifest.json                 # App descriptor (routing, data sources)
│   ├── index.html                    # Bootstrap HTML
│   ├── controller/
│   │   └── Chat.controller.ts        # Main controller — all pipeline logic
│   ├── view/
│   │   └── Chat.view.xml             # Entire UI (ObjectPageLayout, 3 sections)
│   ├── util/
│   │   ├── WebLLMService.ts          # LLM lifecycle + query plan generation
│   │   ├── QueryValidator.ts         # Schema validation + Levenshtein suggest
│   │   └── ODataQueryBuilder.ts      # QueryPlan → OData v4 URL
│   ├── libs/
│   │   └── web-llm/
│   │       └── loader.js             # ESM script that loads WebLLM into window.mlc
│   ├── i18n/
│   │   └── i18n.properties           # Localisation strings
│   └── css/
│       └── style.css                 # Custom styles (pipeline bar, tiles, chips, etc.)
├── srv/
│   └── server.mjs                    # Express CORS proxy (port 4004)
├── tsconfig.json
├── ui5.yaml                          # UI5 tooling config
└── CLAUDE.md                         # This file
```

---

## 5. Data Flow — One Query End-to-End

```
User types query
       │
       ▼
Chat.controller.ts → onSearch()
       │
       ├─ [LLM ready] → WebLLMService.generateQueryPlan(text)
       │                        │
       │                        ├─ Sends to Qwen2.5-0.5B via chat.completions API
       │                        ├─ Strips markdown fences from response
       │                        ├─ Extracts first {...} JSON block
       │                        ├─ JSON.parse → QueryPlan
       │                        └─ fixKnownMistakes(plan) post-processor
       │
       ├─ [LLM not ready] → detectEntity(text) + extractKeyTerm(text)
       │                        │
       │                        └─ Builds QueryPlan from keyword heuristics
       │
       ▼
QueryValidator.validate(plan)
       │  checks entity whitelist, $filter field names, $orderby field
       │  returns ValidationResult with errors[] and statusState
       │
       ▼
ODataQueryBuilder.build(plan, baseUrl)
       │  injection guard → entity check → URL construction
       │  appends $count=true, clamps $top to [1,50]
       │
       ▼
fetch(url, { headers: { Accept: "application/json" } })
       │  routed through Express CORS proxy on port 4004
       │  proxy strips /odata prefix and forwards to Northwind
       │
       ▼
Response parsed → model.setProperty("/results", data.value)
       │
       ▼
refreshResultTable(entity) → destroys columns, rebuilds from ENTITY_COLS
       │
       ▼
pushHistory() + updateStats()
       UI updates reactively via JSONModel bindings
```

---

## 6. Key Files — Detailed

### 6.1 `WebLLMService.ts`

**Role:** Manages the WebLLM engine lifecycle and translates natural-language
questions into structured `QueryPlan` objects.

**Loading strategy:** SAP UI5 uses AMD (`sap.ui.define`) which cannot resolve npm
ESM imports directly. Instead, a `<script type="module">` tag is dynamically
injected into `document.head` from `webapp/libs/web-llm/loader.js`. That script
loads the WebLLM npm package and assigns the engine factory to `window.mlc`.
The service polls `window.mlcLoaded` every 100 ms with a 15-second timeout.

**Model selection:** Qwen2.5-0.5B-Instruct, Q4F16 quantisation (~300 MB).
Temperature is fixed at 0.1 to maximise determinism. `response_format:{type:"json_object"}`
is intentionally excluded — in WebLLM v0.2.84 it triggers a WASM binding crash
inside the TVM grammar compiler.

**Post-processor (`fixKnownMistakes`):** The 0.5B model was pre-trained on far
more OData v2 than v4 content. It has two known failure modes:

1. **T3 substringof syntax:** Model generates `substringof('chai', ProductName) eq true`
   (OData v2). The post-processor converts both argument orders to OData v4
   `contains(ProductName,'chai')`.

2. **T5 collapsed OR:** Model generates `Country eq 'Germany or France'` instead
   of `Country eq 'Germany' or Country eq 'France'`. The post-processor splits
   the single quoted string back into two separate equality predicates.

**System prompt design:** Four-block structure following NL2OData paper methodology:
- `[ENTITIES]` — field names per entity (schema injection)
- `[FORMAT]` — required JSON output shape
- `[RULES]` — OData v4 filter grammar with WRONG/RIGHT examples
- `[EXAMPLES]` — 14 few-shot examples covering all T1–T5 types

### 6.2 `QueryValidator.ts`

**Role:** Client-side schema guard. Checks that field names in the LLM-generated
`$filter` and `$orderby` expressions actually exist on the target entity.

**Why client-side?** Sending an invalid OData URL to the server returns a terse
HTTP 400. Validating here lets the UI surface messages like:
`"Field 'OrderYear' does not exist on Orders — did you mean 'OrderDate'?"`

**Critical fix — quoted literal stripping:** The filter `ShipCountry eq 'France'`
was previously causing a false-positive validation error because the validator was
extracting `France` as a field name. The fix strips all quoted string literals
(replacing them with `''`) before tokenising the filter expression.

**Levenshtein spell-correction:** For any unknown field name, the validator
suggests the closest known field within edit distance 3. This surfaces typos in
LLM output during development and provides actionable feedback to users.

**ENTITIES export:** `QueryValidator.ts` exports the `ENTITIES` constant (the
keys of the schema map) so `ODataQueryBuilder.ts` can import it for entity
whitelist checks without duplicating the list.

### 6.3 `ODataQueryBuilder.ts`

**Role:** Converts a validated `QueryPlan` into a fully-formed OData v4 URL.

**Injection guard:** The regex `/[;]|--|\/\*|<script/i` rejects filter strings
containing SQL comment sequences, statement terminators, or script tags.
This is defence-in-depth — OData gateways cannot execute SQL injection, but
some SAP Gateway implementations parse filter strings in ways that vary.

**`$top` clamping:** The model occasionally outputs 0 or excessively large
numbers. The builder enforces a hard `[1, 50]` range.

**`$count=true`:** Always appended so the UI can display "77 records · showing 20"
even when `$top` limits the returned rows.

### 6.4 `Chat.controller.ts`

**Role:** Orchestrates the entire user-facing pipeline and all research features.

**Key methods:**

| Method | Purpose |
|---|---|
| `onInit` | Initialises JSONModel with all paths; starts LLM warm-up |
| `initLLM` | Loads Qwen2.5 model; mirrors download progress into model |
| `onSearch` | Main pipeline — plan → validate → fetch → render |
| `onRunBenchmark` | Sequential 10-query benchmark; updates table live |
| `classifyQueryType` | Assigns T1–T5 label from the filter expression |
| `computeConfidence` | Returns High/Medium/Low/Direct based on LLM state + validation |
| `detectEntity` | Keyword-scoring entity detection (direct mode) |
| `extractKeyTerm` | Stop-word stripping to find the filter search term |
| `refreshResultTable` | Destroys and rebuilds table columns for the current entity |
| `pushHistory` | Prepends entry to history list, caps at 50 |
| `updateStats` | Increments session counters, recomputes ESR% |

**Model initialisation — critical detail:** Every path that the view binds to
must exist in the initial model state. In particular, `confidenceState` must be
initialised to `"None"` (not `""`). The empty string `""` is not a valid
`sap.ui.core.ValueState` enum value and causes a runtime crash in `ObjectStatus`.

**ENTITY_KEYWORDS scoring:** Multi-word phrases ("recent order", "line item")
score 2 points on a match because they are unambiguous; single words score 1.
The entity with the highest total wins. This algorithm correctly handles:
- "recent orders to france" → Orders (not Products)
- "order details for product 5" → Order_Details

**DIRECT_FILTERS:** When the LLM is unavailable, each entity has a hardcoded
filter builder function. Orders uses `contains(ShipCountry,...)` rather than
`contains(CustomerID,...)` as the primary signal because geographic queries
("orders to France") are far more common than customer-ID queries.

### 6.5 `srv/server.mjs`

**Role:** Express.js CORS proxy running on port 4004.

The Northwind public endpoint does not set `Access-Control-Allow-Origin` headers,
which browsers block. The proxy forwards requests from `http://localhost:4004/odata/`
to `https://services.odata.org/V4/Northwind/Northwind.svc/` and adds CORS headers
to the response. Must be running before the UI5 dev server is started.

### 6.6 `webapp/manifest.json`

- **App ID:** `research.chat`
- **OData data source:** `http://localhost:4004/odata/`
- **Router route:** `/` → `Chat` view
- **Resource roots:** `research.chat` → `./` (maps TypeScript namespace to webapp dir)
- **Theme:** `sap_horizon` (SAP Fiori 4 design system)
- **Libraries:** `sap.m`, `sap.uxap`, `sap.ui.layout`

---

## 7. Research Dashboard — Evaluation Framework

The Research Dashboard section implements the paper's evaluation methodology live.

### Query Taxonomy (T1–T5)

Defined in `classifyQueryType()`:

| Type | Description | Detection |
|---|---|---|
| T1 | Entity read (no filter) | `filter === ""` |
| T2 | Numeric range comparison | `/ lt \| gt \| le \| ge /` |
| T3 | String match (contains / startswith) | `/contains\(\|startswith\(/` |
| T4 | Categorical equality | Any `eq` filter not caught above |
| T5 | Multi-value OR condition | `/ or /` (checked first) |

T5 is checked before T3 because a query like "products containing chai or basil"
has both OR and contains — T5 is the more descriptive classification.

### Session Statistics Strip

Six KPI tiles in the header actions area, visible after the first query:

| Stat | What it measures |
|---|---|
| Total Queries | Cumulative queries this session |
| AI Mode | Queries handled by Qwen2.5 |
| Direct Mode | Queries handled by keyword heuristic |
| Validator Catches | Queries where schema validation found errors |
| Server Errors | OData requests that returned non-2xx |
| ESR (%) | Effective Success Rate = (total − errors) / total |

ESR is the headline metric in Table III of the paper.

### Benchmark Runner

10 predefined queries, 2 per taxonomy type. Pass criteria: entity is correctly
detected AND the result set is non-empty (proxy for filter correctness).

The 10 queries are listed in `BENCHMARK_QUERIES` in `Chat.controller.ts`.
Results populate the benchmark table row-by-row during the run, showing:
query text, expected entity, detected entity, entity match (✓/✗), result
presence (✓/✗), validation pass, timing (ms), and overall pass/fail status.

The accuracy percentage shown in the table header corresponds to Table II of
the NL2OData paper.

---

## 8. Known Issues and Workarounds

### `@sap-ux/eslint-plugin-fiori-tools` missing

ESLint exits with `Cannot find module '@sap-ux/eslint-plugin-fiori-tools'`.
This package is referenced in `eslint.config.mjs` but is not installed in
`node_modules`. This is a pre-existing project configuration issue — it was
present before any of the current development. It does not affect the running
application. TypeScript (`npx tsc --noEmit`) is clean.

**Workaround:** Use `npx tsc --noEmit` for type-checking. Skip ESLint for now
or install the missing package with `npm install --save-dev @sap-ux/eslint-plugin-fiori-tools`.

### `response_format:{type:"json_object"}` WebLLM crash

Enabling structured JSON output mode in WebLLM v0.2.84 triggers a WASM binding
crash in the TVM grammar compiler. The response is parsed with a manual
JSON extraction approach instead (strip fences → find first `{...}` block →
`JSON.parse`).

### First-load timing

On the first launch, downloading and compiling the model takes 30–60 seconds
depending on network speed and GPU. Subsequent launches use the IndexedDB cache
and take under 4 seconds. Show the progress bar and set appropriate user expectations.

---

## 9. Extension Points

To add a new entity to the app:

1. **`webapp/util/QueryValidator.ts`** — Add the entity name and its field list to the `SCHEMA` object.
2. **`webapp/controller/Chat.controller.ts`** — Add a `ColDef[]` entry to `ENTITY_COLS` and a keyword array to `ENTITY_KEYWORDS`.
3. **`webapp/util/WebLLMService.ts`** — Add the entity and its key fields to the `ENTITIES AND FIELDS` block in `SYSTEM_PROMPT`.

To add a new benchmark query:

1. Append to `BENCHMARK_QUERIES` in `Chat.controller.ts`.
2. Update `benchmark.total` initial value (or make it derive from `BENCHMARK_QUERIES.length` — it already does).
3. Add a matching few-shot example to `SYSTEM_PROMPT` in `WebLLMService.ts` if it covers a new query pattern.

---

## 10. Northwind Entity Reference

| Entity | Key fields for filters |
|---|---|
| Products | ProductName, UnitPrice, UnitsInStock, Discontinued, CategoryID |
| Categories | CategoryName |
| Customers | CompanyName, Country, City |
| Orders | ShipCountry, ShipCity, Freight, OrderDate |
| Employees | FirstName, LastName, Country, City |
| Suppliers | CompanyName, Country, City |
| Order_Details | OrderID, ProductID, Quantity, Discount |
