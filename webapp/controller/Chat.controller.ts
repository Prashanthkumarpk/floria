/**
 * Chat.controller.ts
 *
 * Primary application controller for Floria — NL2OData Explorer.
 *
 * Orchestrates the full query pipeline:
 *   1. User types a natural-language question in the search bar.
 *   2. If WebGPU is available and the model is loaded, WebLLMService translates
 *      the question into a structured QueryPlan; otherwise detectEntity /
 *      extractKeyTerm produce a lightweight direct-mode plan.
 *   3. QueryValidator checks field names against the Northwind schema and
 *      surfaces human-readable errors before any network request is made.
 *   4. ODataQueryBuilder assembles the validated plan into an OData v4 URL.
 *   5. The URL is fetched via the local CORS proxy (port 4004).
 *   6. Results are rendered in a dynamically rebuilt sap.m.Table.
 *
 * Research features
 * -----------------
 * The Research Dashboard section implements the evaluation framework described
 * in the NL2OData paper (submitted to ICON India 2026):
 *   - Query taxonomy classification T1–T5 (classifyQueryType)
 *   - Session statistics strip with Effective Success Rate (updateStats)
 *   - Query history panel with per-entry metadata (pushHistory)
 *   - 10-query benchmark runner with entity match + result presence checks
 *     (onRunBenchmark)
 *
 * Model structure (JSONModel at /):
 *   /query             — current textarea value
 *   /loading           — spinner visibility
 *   /hasResults        — results panel visibility
 *   /noResults         — empty-result MessageStrip visibility
 *   /results[]         — fetched records
 *   /countLabel        — "77 records · showing 20" text
 *   /oDataQuery/…      — plan + URL + metadata for the query log panel
 *   /timing/…          — parseMs, fetchMs, totalMs (pipeline timing display)
 *   /validation/…      — state, text, errors[] for the validation bar
 *   /llm/…             — loading, ready, progress, status icon/text/state
 *   /stats/…           — session counters and ESR%
 *   /history[]         — query history entries (max 50, newest first)
 *   /benchmark/…       — running flag, results[], accuracy, progress
 *   /error             — error MessageStrip text
 */

import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageToast from "sap/m/MessageToast";
import Table from "sap/m/Table";
import Column from "sap/m/Column";
import ColumnListItem from "sap/m/ColumnListItem";
import Text from "sap/m/Text";
import Label from "sap/m/Label";
import ObjectNumber from "sap/m/ObjectNumber";
import WebLLMService, { QueryPlan } from "../util/WebLLMService";
import ODataQueryBuilder from "../util/ODataQueryBuilder";
import QueryValidator, { ValidationResult } from "../util/QueryValidator";

/** Column definition used by ENTITY_COLS to drive dynamic table column creation. */
interface ColDef { key: string; label: string; width: string; numeric?: boolean }

/**
 * A single entry in the query history list.
 * Immutable once created — we push new entries to the front of the array
 * rather than mutating existing ones so model binding stays reactive.
 */
interface HistoryEntry {
  id: number;
  query: string;
  entity: string;
  queryType: string;
  typeLabel: string;
  validationState: string;
  validatorCaught: boolean;
  resultCount: number;
  totalMs: number;
  mode: string;
  confidence: string;
  confidenceState: string;
  timestamp: string;
  success: boolean;
  url: string;
}

/**
 * One row in the benchmark runner table.
 * entityMatch and hasResults are the two pass criteria;
 * `passed` is their conjunction.
 */
interface BenchmarkResult {
  idx: number;
  query: string;
  expectedEntity: string;
  queryType: string;
  detectedEntity: string;
  entityMatch: boolean;
  hasResults: boolean;
  validationPassed: boolean;
  totalMs: number;
  passed: boolean;
  status: string;
  statusState: string;
}

// ─── Static data ───────────────────────────────────────────────────────────────

/**
 * Column definitions for each Northwind entity.
 * Keys match the OData field names exactly (case-sensitive) — they are used as
 * binding paths in Text and ObjectNumber cells. Add or remove fields here to
 * change what is displayed in the results table without touching the view.
 */
const ENTITY_COLS: Record<string, ColDef[]> = {
  Products: [
    { key: "ProductName",     label: "Product Name",  width: "30%"              },
    { key: "UnitPrice",       label: "Unit Price ($)", width: "13%", numeric: true },
    { key: "UnitsInStock",    label: "In Stock",       width: "11%", numeric: true },
    { key: "QuantityPerUnit", label: "Pack Size",      width: "22%"              },
    { key: "Discontinued",    label: "Status",         width: "14%"              },
  ],
  Categories: [
    { key: "CategoryName", label: "Category",    width: "25%" },
    { key: "Description",  label: "Description", width: "75%" },
  ],
  Customers: [
    { key: "CompanyName",  label: "Company", width: "28%" },
    { key: "ContactName",  label: "Contact", width: "20%" },
    { key: "ContactTitle", label: "Role",    width: "20%" },
    { key: "City",         label: "City",    width: "15%" },
    { key: "Country",      label: "Country", width: "13%" },
  ],
  Orders: [
    { key: "OrderID",     label: "Order #",      width: "10%", numeric: true },
    { key: "CustomerID",  label: "Customer",     width: "13%"              },
    { key: "OrderDate",   label: "Order Date",   width: "20%"              },
    { key: "ShipCity",    label: "Ship To",      width: "17%"              },
    { key: "ShipCountry", label: "Country",      width: "14%"              },
    { key: "Freight",     label: "Freight ($)",  width: "14%", numeric: true },
  ],
  Employees: [
    { key: "FirstName", label: "First Name", width: "18%" },
    { key: "LastName",  label: "Last Name",  width: "18%" },
    { key: "Title",     label: "Title",      width: "28%" },
    { key: "City",      label: "City",       width: "18%" },
    { key: "Country",   label: "Country",    width: "18%" },
  ],
  Suppliers: [
    { key: "CompanyName", label: "Company", width: "30%" },
    { key: "ContactName", label: "Contact", width: "22%" },
    { key: "City",        label: "City",    width: "20%" },
    { key: "Country",     label: "Country", width: "18%" },
    { key: "Phone",       label: "Phone",   width: "10%" },
  ],
  Order_Details: [
    { key: "OrderID",   label: "Order #",    width: "14%", numeric: true },
    { key: "ProductID", label: "Product #",  width: "14%", numeric: true },
    { key: "UnitPrice", label: "Unit Price", width: "18%", numeric: true },
    { key: "Quantity",  label: "Qty",        width: "14%", numeric: true },
    { key: "Discount",  label: "Discount",   width: "14%", numeric: true },
  ],
};

/**
 * Keyword list used by the entity auto-detection algorithm (detectEntity).
 * Multi-word phrases ("recent order", "line item") score 2 points because they
 * are unambiguous; single words score 1. The entity with the highest total score
 * wins. Default is Products when no keywords match.
 */
const ENTITY_KEYWORDS: Record<string, string[]> = {
  Products:      ["product","products","item","items","price","prices","stock","inventory",
                  "cheap","expensive","discontinued","unit","pack","sku","catalog"],
  Categories:    ["category","categories","group","groups","type","types","kind","section"],
  Customers:     ["customer","customers","client","clients","buyer","buyers",
                  "company","companies","contact","contacts"],
  Orders:        ["order","orders","purchase","purchases","shipment","ship","shipped",
                  "delivery","deliveries","freight","recent order","latest order"],
  Employees:     ["employee","employees","staff","worker","workers","person","people",
                  "hire","hired","manager","managers","report"],
  Suppliers:     ["supplier","suppliers","vendor","vendors","manufacturer","manufacturers","source"],
  Order_Details: ["order detail","order details","line item","line items","quantity",
                  "quantities","discount","discounts"],
};

/**
 * Words stripped from the user query before key-term extraction (direct mode).
 * Without stop-word removal, extractKeyTerm("recent orders to france") would
 * return "recent" rather than "France", producing a useless filter.
 * Entity names are included so they don't crowd out the actual search term.
 */
const STOP_WORDS = new Set([
  "show","me","give","find","list","get","fetch","search","display",
  "all","the","a","an","some","any",
  "to","from","in","for","of","with","by","and","or","not",
  "is","are","was","were","be","been",
  "recent","latest","oldest","top","last","first","most","least",
  "new","old","current","today",
  "product","products","category","categories","customer","customers",
  "order","orders","employee","employees","supplier","suppliers",
  "order_detail","order_details",
]);

/**
 * Direct-mode filter builders for each entity — one function per entity that
 * accepts an extracted key term and returns an OData v4 $filter string.
 * Orders uses ShipCountry/ShipCity rather than CustomerID as the primary signal
 * because most geographic queries target the destination ("orders to France").
 */
const DIRECT_FILTERS: Record<string, (t: string) => string> = {
  Products:      t => t ? `contains(ProductName,'${t}')` : "",
  Categories:    t => t ? `contains(CategoryName,'${t}')` : "",
  Customers:     t => t ? `contains(CompanyName,'${t}') or contains(ContactName,'${t}') or contains(Country,'${t}') or contains(City,'${t}')` : "",
  Orders:        t => t ? `contains(ShipCountry,'${t}') or contains(ShipCity,'${t}') or contains(CustomerID,'${t}')` : "",
  Employees:     t => t ? `contains(LastName,'${t}') or contains(FirstName,'${t}') or contains(Country,'${t}') or contains(City,'${t}')` : "",
  Suppliers:     t => t ? `contains(CompanyName,'${t}') or contains(Country,'${t}') or contains(City,'${t}')` : "",
  Order_Details: () => "",
};

/**
 * The 10 benchmark queries used to evaluate the pipeline.
 * Two queries per taxonomy type T1–T5, matching the evaluation table in the
 * NL2OData paper. Pass criteria: entity is correctly detected AND results are
 * non-empty (proxy for OData filter correctness).
 */
const BENCHMARK_QUERIES: Array<{ query: string; expectedEntity: string; type: string }> = [
  { query: "list all categories",              expectedEntity: "Categories", type: "T1" },
  { query: "show all employees",               expectedEntity: "Employees",  type: "T1" },
  { query: "products cheaper than $15",        expectedEntity: "Products",   type: "T2" },
  { query: "orders with freight over 100",     expectedEntity: "Orders",     type: "T2" },
  { query: "products with chai in the name",   expectedEntity: "Products",   type: "T3" },
  { query: "customers with restaurant in name",expectedEntity: "Customers",  type: "T3" },
  { query: "discontinued products",            expectedEntity: "Products",   type: "T4" },
  { query: "employees from USA",               expectedEntity: "Employees",  type: "T4" },
  { query: "customers from Germany or France", expectedEntity: "Customers",  type: "T5" },
  { query: "orders to France or Brazil",       expectedEntity: "Orders",     type: "T5" },
];

/** Human-readable label map for query taxonomy type codes. */
const TYPE_LABELS: Record<string, string> = {
  T1: "T1 · Entity Read",
  T2: "T2 · Numeric Range",
  T3: "T3 · String Match",
  T4: "T4 · Categorical",
  T5: "T5 · Multi-value OR",
};

/**
 * @namespace research.chat.controller
 */
export default class ChatController extends Controller {
  private model!: JSONModel;
  private llmService!: WebLLMService;
  private queryBuilder!: ODataQueryBuilder;
  private queryValidator!: QueryValidator;

  /** Auto-incrementing ID for history entries — monotone so React-style keys are stable. */
  private historySeq = 0;

  /** OData proxy base. The proxy (srv/server.mjs) adds CORS headers for browser fetch. */
  private readonly ODATA_BASE = "http://localhost:4004/odata";

  /**
   * Lifecycle: called once when the view is instantiated.
   * Initialises the JSON model with all paths the view binds to, ensuring every
   * binding resolves immediately rather than waiting for the first user action.
   * Starting the LLM here (not on first query) means the ~4 s warm-up overhead
   * is hidden behind the user reading the page.
   */
  public onInit(): void {
    this.model = new JSONModel({
      query: "",
      hasResults: false,
      noResults: false,
      loading: false,
      results: [] as Record<string, unknown>[],
      resultEntity: "",
      countLabel: "",
      oDataQuery: {
        url: "", entity: "", filter: "", orderby: "", top: "",
        rawPlan: "", naturalQuery: "", mode: "",
        queryType: "", typeLabel: "",
        confidence: "", confidenceState: "None"
      },
      timing: { parseMs: 0, fetchMs: 0, totalMs: 0 },
      validation: { state: "None", text: "", errors: [] as string[] },
      stats: {
        total: 0, aiQueries: 0, directQueries: 0,
        validatorCatches: 0, serverErrors: 0, esr: "—"
      },
      history: [] as HistoryEntry[],
      benchmark: {
        running: false,
        done: false,
        progress: 0,
        total: BENCHMARK_QUERIES.length,
        passed: 0,
        accuracy: "—",
        results: [] as BenchmarkResult[]
      },
      llm: {
        ready: false, loading: false, progress: 0,
        progressLabel: "", loadingText: "",
        statusText: "Direct Search", statusState: "Information",
        statusIcon: "sap-icon://search"
      },
      error: ""
    });
    this.getView()?.setModel(this.model);

    this.llmService    = new WebLLMService();
    this.queryBuilder  = new ODataQueryBuilder();
    this.queryValidator = new QueryValidator();

    // Start model warm-up only when WebGPU is present; the await is intentionally
    // fire-and-forget — errors are caught inside initLLM and the UI degrades
    // gracefully to direct-mode search.
    if (WebLLMService.isWebGPUAvailable()) void this.initLLM();
  }

  // ─── LLM init ──────────────────────────────────────────────────────────────

  /**
   * Starts WebLLM initialisation and mirrors progress into the model.
   * On success, /llm/ready flips to true and all subsequent searches use the AI
   * path. On failure, the app silently continues in direct-mode — no error is
   * shown to the user because direct-mode still produces useful results.
   */
  private async initLLM(): Promise<void> {
    this.model.setProperty("/llm/loading", true);
    this.model.setProperty("/llm/loadingText", "Downloading Qwen2.5-0.5B (~300 MB, cached after first run)…");
    this.model.setProperty("/llm/statusText", "Loading AI…");
    this.model.setProperty("/llm/statusState", "Warning");
    this.model.setProperty("/llm/statusIcon", "sap-icon://synchronize");
    try {
      await this.llmService.initialize((r) => {
        const pct = Math.round(r.progress * 100);
        this.model.setProperty("/llm/progress", pct);
        this.model.setProperty("/llm/progressLabel", `${pct}%`);
        this.model.setProperty("/llm/loadingText", r.text || "Initializing…");
      });
      this.model.setProperty("/llm/loading", false);
      this.model.setProperty("/llm/ready", true);
      this.model.setProperty("/llm/statusText", "AI Mode Active");
      this.model.setProperty("/llm/statusState", "Success");
      this.model.setProperty("/llm/statusIcon", "sap-icon://ai");
    } catch {
      this.model.setProperty("/llm/loading", false);
      this.model.setProperty("/llm/statusText", "Direct Search");
      this.model.setProperty("/llm/statusState", "Information");
      this.model.setProperty("/llm/statusIcon", "sap-icon://search");
    }
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  /**
   * Main query handler — bound to the Search button and Enter key in the view.
   *
   * Pipeline:
   *   Step 1 (Parse)    — LLM or direct-mode produces a QueryPlan.
   *   Step 2 (Validate) — QueryValidator checks field names and updates the UI bar.
   *   Step 3 (Execute)  — OData URL is fetched through the local CORS proxy.
   *   Post              — History entry and session statistics are updated.
   *
   * All three steps are timed independently; the timings feed the pipeline
   * visualisation bar in the "Generated OData v4 Query" section.
   */
  public async onSearch(): Promise<void> {
    const text = (this.model.getProperty("/query") as string).trim();
    if (!text) return;

    // Reset result state so stale data never bleeds into a new query's display
    this.model.setProperty("/loading", true);
    this.model.setProperty("/error", "");
    this.model.setProperty("/hasResults", false);
    this.model.setProperty("/noResults", false);
    this.model.setProperty("/results", []);
    this.model.setProperty("/validation/state", "None");
    this.model.setProperty("/validation/errors", []);
    this.model.setProperty("/timing/parseMs", 0);
    this.model.setProperty("/timing/fetchMs", 0);
    this.model.setProperty("/timing/totalMs", 0);

    const llmReady = this.model.getProperty("/llm/ready") as boolean;
    const t0 = performance.now();
    let validatorCaught = false;
    let serverError = false;
    let resultCount = 0;

    try {
      // ── Step 1: Generate plan ──
      let plan: QueryPlan;
      const t1 = performance.now();
      if (llmReady) {
        plan = await this.llmService.generateQueryPlan(text);
      } else {
        // Direct mode: detect entity by keyword scoring, extract key term for filter
        const entity = this.detectEntity(text);
        const term   = this.extractKeyTerm(text);
        plan = { entity, filter: (DIRECT_FILTERS[entity] ?? DIRECT_FILTERS.Products)(term), orderby: "", top: 20 };
      }
      const parseMs = Math.round(performance.now() - t1);
      this.model.setProperty("/timing/parseMs", parseMs);

      // ── Step 2: Validate ──
      const vr = this.queryValidator.validate(plan);
      validatorCaught = vr.fieldErrors.length > 0;
      this.model.setProperty("/validation/state",  vr.statusState);
      this.model.setProperty("/validation/text",   vr.statusText);
      this.model.setProperty("/validation/errors", vr.fieldErrors);

      const queryType  = this.classifyQueryType(plan);
      const confidence = this.computeConfidence(vr, llmReady);
      const url        = this.queryBuilder.build(plan, this.ODATA_BASE);

      // Populate the query log panel in the view
      this.model.setProperty("/oDataQuery/url",           url);
      this.model.setProperty("/oDataQuery/entity",        plan.entity);
      this.model.setProperty("/oDataQuery/filter",        plan.filter  ?? "");
      this.model.setProperty("/oDataQuery/orderby",       plan.orderby ?? "");
      this.model.setProperty("/oDataQuery/top",           String(plan.top ?? 20));
      this.model.setProperty("/oDataQuery/rawPlan",       JSON.stringify(plan, null, 2));
      this.model.setProperty("/oDataQuery/naturalQuery",  text);
      this.model.setProperty("/oDataQuery/mode",          llmReady ? "AI" : "Direct");
      this.model.setProperty("/oDataQuery/queryType",     queryType);
      this.model.setProperty("/oDataQuery/typeLabel",     TYPE_LABELS[queryType] ?? queryType);
      this.model.setProperty("/oDataQuery/confidence",    confidence.label);
      this.model.setProperty("/oDataQuery/confidenceState", confidence.state);

      // ── Step 3: Execute ──
      const t2 = performance.now();
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        serverError = true;
        const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `OData error ${res.status}`);
      }
      const data = await res.json() as { value: Record<string, unknown>[]; "@odata.count"?: number };
      const fetchMs = Math.round(performance.now() - t2);
      const totalMs = Math.round(performance.now() - t0);
      this.model.setProperty("/timing/fetchMs", fetchMs);
      this.model.setProperty("/timing/totalMs", totalMs);

      const results = data.value ?? [];
      const total   = data["@odata.count"] ?? results.length;
      resultCount   = results.length;

      this.model.setProperty("/loading", false);
      if (results.length === 0) {
        this.model.setProperty("/noResults", true);
      } else {
        this.model.setProperty("/results",     results);
        this.model.setProperty("/countLabel",  `${total.toLocaleString()} record${total !== 1 ? "s" : ""} · showing ${results.length}`);
        this.model.setProperty("/resultEntity", plan.entity);
        this.model.setProperty("/hasResults",   true);
        this.refreshResultTable(plan.entity);
      }

      // Record the query in history and update session statistics
      this.pushHistory({
        query: text, entity: plan.entity, queryType, typeLabel: TYPE_LABELS[queryType] ?? queryType,
        validationState: vr.statusState, validatorCaught,
        resultCount, totalMs, mode: llmReady ? "AI" : "Direct",
        confidence: confidence.label, confidenceState: confidence.state,
        success: true, url
      });
      this.updateStats(llmReady, validatorCaught, false);

    } catch (err) {
      const totalMs = Math.round(performance.now() - t0);
      this.model.setProperty("/loading", false);
      this.model.setProperty("/error", (err as Error).message);
      this.pushHistory({
        query: text, entity: "", queryType: "—", typeLabel: "—",
        validationState: "Error", validatorCaught,
        resultCount: 0, totalMs, mode: llmReady ? "AI" : "Direct",
        confidence: "Low", confidenceState: "Error",
        success: false, url: ""
      });
      this.updateStats(llmReady, validatorCaught, true);
    }
  }

  // ─── Benchmark ─────────────────────────────────────────────────────────────

  /**
   * Runs all 10 benchmark queries sequentially and populates the benchmark
   * results table row-by-row so the user can watch progress in real time.
   *
   * Each query runs the same pipeline as onSearch (plan → validate → fetch)
   * but uses a simplified pass/fail criterion:
   *   PASS = entity correctly detected AND results array is non-empty
   *
   * The accuracy percentage shown in the table header corresponds to Table II
   * in the NL2OData paper submission.
   *
   * Note: This method is intentionally sequential rather than concurrent —
   * the WebLLM engine processes one request at a time, and the visual
   * row-by-row update demonstrates the live pipeline to conference reviewers.
   */
  public async onRunBenchmark(): Promise<void> {
    if (this.model.getProperty("/benchmark/running") as boolean) return;

    this.model.setProperty("/benchmark/running",  true);
    this.model.setProperty("/benchmark/done",     false);
    this.model.setProperty("/benchmark/progress", 0);
    this.model.setProperty("/benchmark/passed",   0);
    this.model.setProperty("/benchmark/accuracy", "—");
    this.model.setProperty("/benchmark/results",  []);

    const llmReady = this.model.getProperty("/llm/ready") as boolean;
    let passed = 0;

    for (let i = 0; i < BENCHMARK_QUERIES.length; i++) {
      const bq = BENCHMARK_QUERIES[i];
      this.model.setProperty("/query", bq.query);
      const t0 = performance.now();

      let detectedEntity = "";
      let hasResults     = false;
      let validationPass = false;
      let entityMatch    = false;

      try {
        let plan: QueryPlan;
        if (llmReady) {
          plan = await this.llmService.generateQueryPlan(bq.query);
        } else {
          const entity = this.detectEntity(bq.query);
          const term   = this.extractKeyTerm(bq.query);
          plan = { entity, filter: (DIRECT_FILTERS[entity] ?? DIRECT_FILTERS.Products)(term), orderby: "", top: 20 };
        }

        detectedEntity = plan.entity;
        entityMatch    = plan.entity === bq.expectedEntity;

        const vr  = this.queryValidator.validate(plan);
        validationPass = vr.valid;

        const url = this.queryBuilder.build(plan, this.ODATA_BASE);
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (res.ok) {
          const data = await res.json() as { value: unknown[] };
          hasResults = (data.value ?? []).length > 0;
        }
      } catch { /* count as failed; continue to next benchmark query */ }

      const totalMs  = Math.round(performance.now() - t0);
      const isPassed = entityMatch && hasResults;
      if (isPassed) passed++;

      const entry: BenchmarkResult = {
        idx: i + 1, query: bq.query, expectedEntity: bq.expectedEntity,
        queryType: bq.type, detectedEntity, entityMatch, hasResults,
        validationPassed: validationPass, totalMs, passed: isPassed,
        status: isPassed ? "Passed" : "Failed",
        statusState: isPassed ? "Success" : "Error"
      };

      // Append immutably so the List binding detects the array reference change
      const current = this.model.getProperty("/benchmark/results") as BenchmarkResult[];
      this.model.setProperty("/benchmark/results",  [...current, entry]);
      this.model.setProperty("/benchmark/progress", Math.round(((i + 1) / BENCHMARK_QUERIES.length) * 100));
      this.model.setProperty("/benchmark/passed",   passed);
      this.model.setProperty("/benchmark/accuracy", `${Math.round((passed / (i + 1)) * 100)}%`);
    }

    this.model.setProperty("/benchmark/running", false);
    this.model.setProperty("/benchmark/done",    true);
    MessageToast.show(`Benchmark complete — ${passed}/${BENCHMARK_QUERIES.length} passed (${Math.round((passed / BENCHMARK_QUERIES.length) * 100)}%)`);
  }

  /**
   * Resets the query history list and all session statistics counters.
   * Bound to the "Clear" button in the Query History toolbar.
   */
  public onClearHistory(): void {
    this.model.setProperty("/history", []);
    this.model.setProperty("/stats", { total: 0, aiQueries: 0, directQueries: 0, validatorCatches: 0, serverErrors: 0, esr: "—" });
  }

  /**
   * Replays a history entry: copies its query text into the search field and
   * immediately re-executes the search. Bound to list item press in the
   * Query History panel.
   */
  public onHistoryItemPress(event: { getSource(): { getBindingContext(): { getProperty(p: string): unknown } } }): void {
    const ctx   = event.getSource().getBindingContext();
    const query = ctx.getProperty("query") as string;
    this.model.setProperty("/query", query);
    void this.onSearch();
  }

  // ─── Table rebuild ─────────────────────────────────────────────────────────

  /**
   * Destroys all existing columns on the results Table and rebuilds them from
   * ENTITY_COLS for the given entity. Also creates a new item template with
   * the appropriate cell types (Text for strings, ObjectNumber for numerics).
   *
   * This approach is used instead of a static table definition because the 7
   * Northwind entities have different column sets and cardinalities. Dynamic
   * column creation is the standard pattern for OData-driven tables in SAP Fiori.
   */
  private refreshResultTable(entity: string): void {
    const table = this.byId("resultsTable") as Table | undefined;
    if (!table) return;
    const cols = ENTITY_COLS[entity] ?? [];
    table.destroyColumns();
    cols.forEach(col => {
      table.addColumn(new Column({
        header: new Label({ text: col.label }),
        width:  col.width,
        hAlign: col.numeric ? "End" : "Begin"
      }));
    });
    const template = new ColumnListItem({
      cells: cols.map(col =>
        col.numeric
          ? new ObjectNumber({ number: `{${col.key}}`, emphasized: false })
          : new Text({ text: `{${col.key}}`, wrapping: false })
      )
    });
    table.bindItems({ path: "/results", template, templateShareable: false });
  }

  // ─── Classification helpers ─────────────────────────────────────────────────

  /**
   * Assigns a taxonomy type T1–T5 to the generated query plan.
   * Priority order is important — T5 (OR) is checked before T3 (contains)
   * because a query can have both; classifying it as T5 is more informative.
   *
   *   T1 — no filter (entity read only)
   *   T2 — numeric comparison (lt, gt, le, ge)
   *   T3 — string function (contains, startswith)
   *   T4 — categorical equality (eq with a string value)
   *   T5 — multi-value OR condition
   *
   * @param plan  The generated query plan.
   */
  private classifyQueryType(plan: QueryPlan): string {
    const f = (plan.filter ?? "").toLowerCase();
    if (!f) return "T1";
    if (/ or /.test(f))                         return "T5";
    if (/contains\(|startswith\(/.test(f))      return "T3";
    if (/ lt | gt | le | ge /.test(f))          return "T2";
    return "T4";
  }

  /**
   * Computes a confidence indicator for the last generated query plan.
   * Displayed as a coloured badge in the query log panel.
   *
   *   High    — AI mode, schema validation passed, no warnings.
   *   Medium  — AI mode, schema validation passed, but warnings exist.
   *   Low     — AI mode, schema validation failed (field errors).
   *   Direct  — LLM not available; plan generated by keyword heuristic.
   *
   * @param vr        ValidationResult from QueryValidator.
   * @param llmReady  Whether the LLM engine is loaded and active.
   */
  private computeConfidence(vr: ValidationResult, llmReady: boolean): { label: string; state: string } {
    if (!llmReady)    return { label: "Direct Mode",         state: "Warning" };
    if (!vr.valid)    return { label: "Low — schema errors", state: "Error"   };
    if (vr.warnings?.length) return { label: "Medium",       state: "Warning" };
    return              { label: "High",                     state: "Success" };
  }

  // ─── Direct-mode helpers ───────────────────────────────────────────────────

  /**
   * Extracts the most semantically significant word from a natural-language
   * query to use as the filter term when the LLM is unavailable.
   *
   * Algorithm:
   *   1. Lowercase and strip punctuation.
   *   2. Split on whitespace, remove stop words and single-character tokens.
   *   3. Sort by length descending — longer words are typically more specific
   *      ("restaurant" > "name" > "with").
   *   4. Capitalise first letter to match the casing OData string comparisons
   *      typically expect (e.g. 'France' not 'france').
   *
   * @param query  Raw user query string.
   */
  private extractKeyTerm(query: string): string {
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
    words.sort((a, b) => b.length - a.length);
    const t = words[0] ?? "";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /**
   * Determines the most likely Northwind entity set from a natural-language
   * query using keyword scoring — without calling the LLM.
   *
   * Each keyword in ENTITY_KEYWORDS is tested against the lowercase query:
   *   - Multi-word phrase match: +2 (unambiguous signal)
   *   - Single-word match:       +1
   * The entity with the highest score wins. Ties go to whichever entity
   * appears first in ENTITY_KEYWORDS (Products is first, so it is the default).
   *
   * @param query  Raw user query string.
   */
  private detectEntity(query: string): string {
    const q = query.toLowerCase();
    let best = "Products", bestScore = -1;
    for (const [entity, words] of Object.entries(ENTITY_KEYWORDS)) {
      const score = words.reduce((acc, w) => acc + (q.includes(w) ? (w.includes(" ") ? 2 : 1) : 0), 0);
      if (score > bestScore) { bestScore = score; best = entity; }
    }
    return best;
  }

  // ─── Stats helpers ─────────────────────────────────────────────────────────

  /**
   * Prepends a new entry to the history list and caps the list at 50 entries.
   * The newest-first ordering matches user expectation and avoids a sort on
   * every insertion. The 50-entry cap prevents unbounded memory growth during
   * long demo sessions.
   *
   * @param entry  All fields except id and timestamp, which are computed here.
   */
  private pushHistory(entry: Omit<HistoryEntry, "id" | "timestamp">): void {
    const id   = ++this.historySeq;
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
    const list = this.model.getProperty("/history") as HistoryEntry[];
    this.model.setProperty("/history", [{ id, timestamp: time, ...entry }, ...list].slice(0, 50));
  }

  /**
   * Increments the session statistics counters after each query and recomputes
   * the Effective Success Rate (ESR = successful queries / total queries).
   * ESR is the primary quality metric shown in the header actions strip and
   * in Table III of the NL2OData paper.
   *
   * @param llmReady       Whether this query used the AI path.
   * @param validatorCaught  Whether the validator found schema errors.
   * @param serverError    Whether the OData fetch returned a non-2xx status.
   */
  private updateStats(llmReady: boolean, validatorCaught: boolean, serverError: boolean): void {
    const s = this.model.getProperty("/stats") as Record<string, number | string>;
    const total     = (s.total as number)           + 1;
    const aiQ       = (s.aiQueries as number)       + (llmReady ? 1 : 0);
    const directQ   = (s.directQueries as number)   + (llmReady ? 0 : 1);
    const catches   = (s.validatorCatches as number) + (validatorCaught ? 1 : 0);
    const errors    = (s.serverErrors as number)    + (serverError ? 1 : 0);
    const esr       = total > 0 ? `${Math.round(((total - errors) / total) * 100)}%` : "—";
    this.model.setProperty("/stats", { total, aiQueries: aiQ, directQueries: directQ, validatorCatches: catches, serverErrors: errors, esr });
  }

  // ─── UI actions ────────────────────────────────────────────────────────────

  /**
   * Handles click on one of the example query chips in the Results empty state.
   * Reads the query text from the CustomData key "query" attached to the Button,
   * writes it into the search field, and fires onSearch immediately.
   *
   * @param event  Press event; the source Button carries the query in its CustomData.
   */
  public onExampleQuery(event: { getSource(): { data(key: string): string } }): void {
    const q = event.getSource().data("query");
    if (!q) return;
    this.model.setProperty("/query", q);
    void this.onSearch();
  }

  /**
   * Copies the last generated OData URL to the system clipboard.
   * Falls back to a MessageToast with the URL text on browsers that block
   * clipboard access (e.g. non-HTTPS origins).
   */
  public onCopyQuery(): void {
    const url = this.model.getProperty("/oDataQuery/url") as string;
    if (!url) return;
    navigator.clipboard.writeText(url)
      .then(() => MessageToast.show("OData URL copied"))
      .catch(() => MessageToast.show(url));
  }

  /** Dismisses the error MessageStrip by clearing the /error model path. */
  public onCloseError(): void {
    this.model.setProperty("/error", "");
  }
}
