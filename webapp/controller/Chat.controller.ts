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
import WebLLMService, { QueryPlan, MODEL_REGISTRY, PROMPT_VERSION, GenerationTrace, ModelProvider } from "../util/WebLLMService";
import { GoldEntry, filterFromUrl, isExactMatch } from "../util/ExactMatch";
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
  modelId: string;
  modelLabel: string;
  /** Post-processed plan that was actually sent; null if generation threw. */
  plan: QueryPlan | null;
  /** Plan as parsed from the model, before fixKnownMistakes; null if unparseable. */
  prePostProcessPlan: QueryPlan | null;
  rawLlmText: string | null;
  url: string | null;
  httpStatus: number | null;
  recordCount: number | null;
  error: string | null;
  errorStage: "generate" | "build" | "fetch" | null;
  /** Which planner produced this row: on-device model, cloud model, or the keyword fallback. */
  llmMode: ModelProvider;
  /** Gold query this result was scored against; null for custom queries or if gold failed to load. */
  goldIdx: number | null;
  goldFilter: string | null;
  /** Exact match (entity + normalized $filter vs gold); null when no gold is available. */
  exactMatch: boolean | null;
}

/** Aggregate statistics for one benchmark run; written into both the CSV summary block and the JSON export. */
interface RunSummary {
  model: string;
  modelId: string;
  promptVersion: string;
  runDate: string;
  totalQueries: number;
  passed: number;
  esrPct: number;
  /** Rows that had a gold entry; EM percentages use this as the denominator. */
  emScored: number;
  emPassed: number;
  emPct: number;
  /** ESR passed but EM failed — ESR's false positives, and their rate over all ESR passes. */
  esrFalsePositives: number;
  esrFpRatePct: number;
  byType: Record<string, { total: number; passed: number; pct: number; em: number; emPct: number }>;
  entityMatchCount: number;
  hasResultsCount: number;
  validationPassedCount: number;
  errorCount: number;
  medianMs: number;
  meanMs: number;
  maxMs: number;
  stalls: number;
}

/** One complete pass over the query set; a benchmark run holds 1..N of these for variance reporting. */
interface RunRepetition {
  index: number;
  startedAt: string;
  finishedAt: string;
  results: BenchmarkResult[];
  summary: RunSummary;
}

/** Subset of the WebGPU adapter surface we read for hardware attribution (typed loosely; not all browsers expose it). */
interface GpuAdapterLike {
  info?: Record<string, string>;
  requestAdapterInfo?: () => Promise<Record<string, string>>;
  limits?: Record<string, number>;
}

/** Generation time above which a query counts as a WebGPU scheduler stall (inflates means 2–100×). */
const STALL_THRESHOLD_MS = 100_000;

const csvEscape = (v: unknown): string => {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
};

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
  Categories:    ["category","categories","group","groups","type","types","kind","section",
                  "product group","product groups","product category","product categories"],
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
 * 100-query benchmark suite — 20 queries per taxonomy type T1–T5, spanning all
 * 7 Northwind entities. Pass criteria: entity correctly detected AND results
 * array is non-empty (proxy for OData filter correctness).
 */
const BENCHMARK_QUERIES: Array<{ query: string; expectedEntity: string; type: string }> = [
  // ── T1: Entity Read (no filter) ──────────────────────────────────────────────
  { query: "list all categories",                         expectedEntity: "Categories",   type: "T1" },
  { query: "show all employees",                          expectedEntity: "Employees",    type: "T1" },
  { query: "show all products",                           expectedEntity: "Products",     type: "T1" },
  { query: "list all customers",                          expectedEntity: "Customers",    type: "T1" },
  { query: "show all orders",                             expectedEntity: "Orders",       type: "T1" },
  { query: "list all suppliers",                          expectedEntity: "Suppliers",    type: "T1" },
  { query: "show all order details",                      expectedEntity: "Order_Details",type: "T1" },
  { query: "display all product categories",              expectedEntity: "Categories",   type: "T1" },
  { query: "get all staff",                               expectedEntity: "Employees",    type: "T1" },
  { query: "what products do we have",                    expectedEntity: "Products",     type: "T1" },
  { query: "show me all clients",                         expectedEntity: "Customers",    type: "T1" },
  { query: "list all shipments",                          expectedEntity: "Orders",       type: "T1" },
  { query: "show all vendors",                            expectedEntity: "Suppliers",    type: "T1" },
  { query: "list all line items",                         expectedEntity: "Order_Details",type: "T1" },
  { query: "get all product groups",                      expectedEntity: "Categories",   type: "T1" },
  { query: "fetch all workers",                           expectedEntity: "Employees",    type: "T1" },
  { query: "display all items in catalog",                expectedEntity: "Products",     type: "T1" },
  { query: "show all buyers",                             expectedEntity: "Customers",    type: "T1" },
  { query: "list all purchases",                          expectedEntity: "Orders",       type: "T1" },
  { query: "show me all manufacturers",                   expectedEntity: "Suppliers",    type: "T1" },

  // ── T2: Numeric Range ────────────────────────────────────────────────────────
  { query: "products cheaper than $15",                   expectedEntity: "Products",     type: "T2" },
  { query: "orders with freight over 100",                expectedEntity: "Orders",       type: "T2" },
  { query: "products with unit price above 50",           expectedEntity: "Products",     type: "T2" },
  { query: "items with less than 5 units in stock",       expectedEntity: "Products",     type: "T2" },
  { query: "products priced under 20 dollars",            expectedEntity: "Products",     type: "T2" },
  { query: "orders with freight less than 20",            expectedEntity: "Orders",       type: "T2" },
  { query: "products with more than 100 units in stock",  expectedEntity: "Products",     type: "T2" },
  { query: "order details with quantity greater than 50", expectedEntity: "Order_Details",type: "T2" },
  { query: "products costing more than 100",              expectedEntity: "Products",     type: "T2" },
  { query: "order details with discount over 0.2",        expectedEntity: "Order_Details",type: "T2" },
  { query: "orders with high freight above 200",          expectedEntity: "Orders",       type: "T2" },
  { query: "products with stock below 10",                expectedEntity: "Products",     type: "T2" },
  { query: "order line items with unit price above 30",   expectedEntity: "Order_Details",type: "T2" },
  { query: "order line items with quantity over 100",     expectedEntity: "Order_Details",type: "T2" },
  { query: "products with stock between 20 and 50",       expectedEntity: "Products",     type: "T2" },
  { query: "orders with freight between 50 and 150",      expectedEntity: "Orders",       type: "T2" },
  { query: "order details with zero discount",            expectedEntity: "Order_Details",type: "T2" },
  { query: "order line items with unit price under 10",   expectedEntity: "Order_Details",type: "T2" },
  { query: "products in stock less than 20 units",        expectedEntity: "Products",     type: "T2" },
  { query: "products with price above 75",                expectedEntity: "Products",     type: "T2" },

  // ── T3: String Match ─────────────────────────────────────────────────────────
  { query: "products with chai in the name",              expectedEntity: "Products",     type: "T3" },
  { query: "customers with restaurant in name",           expectedEntity: "Customers",    type: "T3" },
  { query: "suppliers starting with exotic",              expectedEntity: "Suppliers",    type: "T3" },
  { query: "employees with last name starting with D",    expectedEntity: "Employees",    type: "T3" },
  { query: "customers whose company starts with B",       expectedEntity: "Customers",    type: "T3" },
  { query: "products containing sauce",                   expectedEntity: "Products",     type: "T3" },
  { query: "products with tofu in the name",              expectedEntity: "Products",     type: "T3" },
  { query: "customers with Trading in their company name",expectedEntity: "Customers",    type: "T3" },
  { query: "employees with name starting with A",         expectedEntity: "Employees",    type: "T3" },
  { query: "products containing syrup",                   expectedEntity: "Products",     type: "T3" },
  { query: "customers with Import in their name",         expectedEntity: "Customers",    type: "T3" },
  { query: "orders shipped to cities starting with L",    expectedEntity: "Orders",       type: "T3" },
  { query: "products starting with Chef",                 expectedEntity: "Products",     type: "T3" },
  { query: "customers with Gourmet in their name",        expectedEntity: "Customers",    type: "T3" },
  { query: "orders shipped to Berlin",                    expectedEntity: "Orders",       type: "T3" },
  { query: "products containing pasta",                   expectedEntity: "Products",     type: "T3" },
  { query: "suppliers with Tokyo in their city",          expectedEntity: "Suppliers",    type: "T3" },
  { query: "products with anchov in the name",            expectedEntity: "Products",     type: "T3" },
  { query: "products with caviar in the name",            expectedEntity: "Products",     type: "T3" },
  { query: "customers in cities starting with M",         expectedEntity: "Customers",    type: "T3" },

  // ── T4: Categorical Equality ─────────────────────────────────────────────────
  { query: "discontinued products",                       expectedEntity: "Products",     type: "T4" },
  { query: "employees from USA",                          expectedEntity: "Employees",    type: "T4" },
  { query: "customers from Germany",                      expectedEntity: "Customers",    type: "T4" },
  { query: "suppliers from USA",                          expectedEntity: "Suppliers",    type: "T4" },
  { query: "employees based in UK",                       expectedEntity: "Employees",    type: "T4" },
  { query: "customers located in London",                 expectedEntity: "Customers",    type: "T4" },
  { query: "orders shipped to France",                    expectedEntity: "Orders",       type: "T4" },
  { query: "customers from Mexico",                       expectedEntity: "Customers",    type: "T4" },
  { query: "employees in Seattle",                        expectedEntity: "Employees",    type: "T4" },
  { query: "suppliers from Japan",                        expectedEntity: "Suppliers",    type: "T4" },
  { query: "customers from Brazil",                       expectedEntity: "Customers",    type: "T4" },
  { query: "orders going to Germany",                     expectedEntity: "Orders",       type: "T4" },
  { query: "employees from London",                       expectedEntity: "Employees",    type: "T4" },
  { query: "customers from Spain",                        expectedEntity: "Customers",    type: "T4" },
  { query: "suppliers based in France",                   expectedEntity: "Suppliers",    type: "T4" },
  { query: "orders shipped to Argentina",                 expectedEntity: "Orders",       type: "T4" },
  { query: "customers from Sweden",                       expectedEntity: "Customers",    type: "T4" },
  { query: "employees in Tacoma",                         expectedEntity: "Employees",    type: "T4" },
  { query: "orders delivered to USA",                     expectedEntity: "Orders",       type: "T4" },
  { query: "active products",                             expectedEntity: "Products",     type: "T4" },

  // ── T5: Multi-value OR ───────────────────────────────────────────────────────
  { query: "customers from Germany or France",            expectedEntity: "Customers",    type: "T5" },
  { query: "orders to France or Brazil",                  expectedEntity: "Orders",       type: "T5" },
  { query: "employees from USA or UK",                    expectedEntity: "Employees",    type: "T5" },
  { query: "customers from Mexico or Argentina",          expectedEntity: "Customers",    type: "T5" },
  { query: "products containing chai or tofu",            expectedEntity: "Products",     type: "T5" },
  { query: "suppliers from Germany or France",            expectedEntity: "Suppliers",    type: "T5" },
  { query: "customers from Sweden or Denmark",            expectedEntity: "Customers",    type: "T5" },
  { query: "orders shipped to Germany or Austria",        expectedEntity: "Orders",       type: "T5" },
  { query: "employees from Seattle or Tacoma",            expectedEntity: "Employees",    type: "T5" },
  { query: "customers from Spain or Portugal",            expectedEntity: "Customers",    type: "T5" },
  { query: "products with sauce or syrup in name",        expectedEntity: "Products",     type: "T5" },
  { query: "orders to Italy or Switzerland",              expectedEntity: "Orders",       type: "T5" },
  { query: "customers from USA or Canada",                expectedEntity: "Customers",    type: "T5" },
  { query: "suppliers from UK or USA",                    expectedEntity: "Suppliers",    type: "T5" },
  { query: "employees from UK or Germany",                expectedEntity: "Employees",    type: "T5" },
  { query: "orders to Austria or Belgium",                expectedEntity: "Orders",       type: "T5" },
  { query: "customers from Australia or New Zealand",     expectedEntity: "Customers",    type: "T5" },
  { query: "suppliers from Spain or Italy",               expectedEntity: "Suppliers",    type: "T5" },
  { query: "products with chai or anchovy in name",       expectedEntity: "Products",     type: "T5" },
  { query: "customers from Norway or Finland",            expectedEntity: "Customers",    type: "T5" },
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
  /** Gold queries keyed by query text, loaded from the proxy at startup; empty if unavailable. */
  private goldByQuery = new Map<string, GoldEntry>();

  /** Auto-incrementing ID for history entries — monotone so React-style keys are stable. */
  private historySeq = 0;

  private readonly CACHE_STORE_KEY = "floria_cached_models";

  private getCachedModelIds(): Set<string> {
    try {
      const s = localStorage.getItem(this.CACHE_STORE_KEY);
      return new Set(s ? (JSON.parse(s) as string[]) : []);
    } catch { return new Set(); }
  }

  private markModelCached(modelId: string): void {
    const s = this.getCachedModelIds();
    s.add(modelId);
    localStorage.setItem(this.CACHE_STORE_KEY, JSON.stringify([...s]));
  }

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
        modelLabel: "",
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
        emPassed: 0,
        emAccuracy: "—",
        falsePositives: 0,
        goldCount: 0,
        repeat: "1",
        repeatIndex: 0,
        repeatLabel: "",
        repetitions: [] as RunRepetition[],
        results: [] as BenchmarkResult[],
        queryCount: "100",
        customQueries: [] as Array<{ query: string; expectedEntity: string; type: string }>,
        currentQueryText: "",
        modelLabel: "",
        typeStats: {
          T1: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
          T2: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
          T3: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
          T4: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
          T5: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
        },
        newQuery: { query: "", entity: "Products", type: "T1" }
      },
      llm: {
        ready: false, loading: false, progress: 0,
        progressLabel: "", loadingText: "",
        statusText: "Direct Search", statusState: "Information",
        statusIcon: "sap-icon://search",
        selectedModelId:     MODEL_REGISTRY[0].id,
        selectedModelLabel:  MODEL_REGISTRY[0].label,
        selectedModelVendor: MODEL_REGISTRY[0].vendor,
        selectedModelSize:   MODEL_REGISTRY[0].sizeLabel,
      },
      error: "",
      precaching: false,
      models: MODEL_REGISTRY.map(m => {
        const local  = m.provider === "webllm";
        const cached = local && this.getCachedModelIds().has(m.id);
        return {
          id:             m.id,
          label:          m.label,
          vendor:         m.vendor,
          sizeLabel:      m.sizeLabel,
          params:         m.params,
          provider:       m.provider,
          cacheStatus:    !local ? (m.provider === "bedrock" ? "Cloud API" : "No model") : (cached ? "Cached" : "Not cached"),
          cacheState:     !local ? "Information" : (cached ? "Success" : "None"),
          cacheIcon:      !local ? (m.provider === "bedrock" ? "sap-icon://cloud" : "sap-icon://search") : (cached ? "sap-icon://accept" : "sap-icon://download"),
          cacheProgress:  cached ? 100 : 0,
          cacheProgressPct: cached ? "100%" : "",
          isDownloading:  false,
        };
      }),
    });
    this.getView()?.setModel(this.model);

    this.llmService    = new WebLLMService(new URL(this.ODATA_BASE).origin);
    this.queryBuilder  = new ODataQueryBuilder();
    this.queryValidator = new QueryValidator();
    void this.loadGold();
    void this.captureHardware();

    // Start model warm-up only when WebGPU is present; the await is intentionally
    // fire-and-forget — errors are caught inside initLLM and the UI degrades
    // gracefully to direct-mode search.
    if (this.canInitSelectedModel()) void this.initLLM();
  }

  // ─── LLM init ──────────────────────────────────────────────────────────────

  /**
   * Starts WebLLM initialisation and mirrors progress into the model.
   * On success, /llm/ready flips to true and all subsequent searches use the AI
   * path. On failure, the app silently continues in direct-mode — no error is
   * shown to the user because direct-mode still produces useful results.
   */
  private async initLLM(): Promise<void> {
    const mid   = this.model.getProperty("/llm/selectedModelId") as string;
    const mInfo = MODEL_REGISTRY.find(m => m.id === mid) ?? MODEL_REGISTRY[0];
    const loadingText =
      mInfo.provider === "bedrock" ? `Connecting to ${mInfo.label} via the local proxy…`
      : mInfo.provider === "direct" ? "Keyword planner — no model to load"
      : `Downloading ${mInfo.label} (${mInfo.sizeLabel}, cached after first run)…`;

    this.model.setProperty("/llm/loading",      true);
    this.model.setProperty("/llm/ready",        false);
    this.model.setProperty("/llm/loadingText",  loadingText);
    this.model.setProperty("/llm/statusText",   mInfo.provider === "webllm" ? "Loading AI…" : "Connecting…");
    this.model.setProperty("/llm/statusState",  "Warning");
    this.model.setProperty("/llm/statusIcon",   "sap-icon://synchronize");
    try {
      await this.llmService.switchModel(mid, (r) => {
        const pct = Math.round(r.progress * 100);
        this.model.setProperty("/llm/progress",      pct);
        this.model.setProperty("/llm/progressLabel", `${pct}%`);
        this.model.setProperty("/llm/loadingText",   r.text || "Initializing…");
      });
      this.model.setProperty("/llm/loading",      false);
      this.model.setProperty("/llm/ready",        true);
      this.model.setProperty("/llm/statusText",   `${mInfo.label} Ready`);
      this.model.setProperty("/llm/statusState",  "Success");
      this.model.setProperty("/llm/statusIcon",   mInfo.provider === "bedrock" ? "sap-icon://cloud" : mInfo.provider === "direct" ? "sap-icon://search" : "sap-icon://ai");
      if (mInfo.provider === "webllm") {
        this.markModelCached(mid);
        const models = this.model.getProperty("/models") as Array<Record<string, unknown>>;
        const idx = models.findIndex(m => m.id === mid);
        if (idx !== -1) {
          this.model.setProperty(`/models/${idx}/cacheStatus`,   "Cached");
          this.model.setProperty(`/models/${idx}/cacheState`,    "Success");
          this.model.setProperty(`/models/${idx}/cacheIcon`,     "sap-icon://accept");
          this.model.setProperty(`/models/${idx}/cacheProgress`, 100);
          this.model.setProperty(`/models/${idx}/cacheProgressPct`, "100%");
        }
      }
    } catch (e) {
      this.model.setProperty("/llm/loading",      false);
      this.model.setProperty("/llm/statusText",   mInfo.provider === "bedrock" ? "Cloud unavailable — Direct Search" : "Direct Search");
      this.model.setProperty("/llm/statusState",  mInfo.provider === "bedrock" ? "Error" : "Information");
      this.model.setProperty("/llm/statusIcon",   "sap-icon://search");
      // The on-device path degrades silently (direct search is still useful); a misconfigured cloud baseline must be visible.
      if (mInfo.provider === "bedrock") MessageToast.show(e instanceof Error ? e.message : String(e), { duration: 6000 });
    }
  }

  /** On-device models need WebGPU; cloud and keyword baselines do not. */
  private canInitSelectedModel(): boolean {
    return this.currentProvider() !== "webllm" || WebLLMService.isWebGPUAvailable();
  }

  private currentProvider(): ModelProvider {
    const mid = this.model.getProperty("/llm/selectedModelId") as string;
    return MODEL_REGISTRY.find(m => m.id === mid)?.provider ?? "webllm";
  }

  public onModelChange(event: { getSource(): { getSelectedKey(): string } }): void {
    const mid   = event.getSource().getSelectedKey();
    const mInfo = MODEL_REGISTRY.find(m => m.id === mid);
    if (!mInfo) return;
    this.model.setProperty("/llm/selectedModelId",     mInfo.id);
    this.model.setProperty("/llm/selectedModelLabel",  mInfo.label);
    this.model.setProperty("/llm/selectedModelVendor", mInfo.vendor);
    this.model.setProperty("/llm/selectedModelSize",   mInfo.sizeLabel);
    this.model.setProperty("/llm/ready",               false);
    if (this.canInitSelectedModel()) void this.initLLM();
  }

  public async onPrecacheAll(): Promise<void> {
    if (this.model.getProperty("/precaching") as boolean) return;
    this.model.setProperty("/precaching", true);

    const models = this.model.getProperty("/models") as Array<Record<string, unknown>>;
    const activeMid = this.model.getProperty("/llm/selectedModelId") as string;

    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      if ((m.cacheStatus as string) === "Cached" || (m.provider as string) !== "webllm") continue;

      this.model.setProperty(`/models/${i}/isDownloading`,  true);
      this.model.setProperty(`/models/${i}/cacheStatus`,    "Downloading…");
      this.model.setProperty(`/models/${i}/cacheState`,     "Warning");
      this.model.setProperty(`/models/${i}/cacheProgress`,  0);

      try {
        if ((m.id as string) === activeMid) {
          // Active model already loaded — just mark cached
        } else {
          await this.llmService.precacheModel(m.id as string, (r) => {
            const pct = Math.round(r.progress * 100);
            this.model.setProperty(`/models/${i}/cacheProgress`,    pct);
            this.model.setProperty(`/models/${i}/cacheProgressPct`, `${pct}%`);
          });
        }
        this.markModelCached(m.id as string);
        this.model.setProperty(`/models/${i}/cacheStatus`,       "Cached");
        this.model.setProperty(`/models/${i}/cacheState`,        "Success");
        this.model.setProperty(`/models/${i}/cacheIcon`,         "sap-icon://accept");
        this.model.setProperty(`/models/${i}/cacheProgress`,     100);
        this.model.setProperty(`/models/${i}/cacheProgressPct`,  "100%");
      } catch {
        this.model.setProperty(`/models/${i}/cacheStatus`,  "Error");
        this.model.setProperty(`/models/${i}/cacheState`,   "Error");
        this.model.setProperty(`/models/${i}/cacheIcon`,    "sap-icon://error");
      }
      this.model.setProperty(`/models/${i}/isDownloading`, false);
    }

    this.model.setProperty("/precaching", false);
    MessageToast.show("All models pre-cached — switching is now instant");
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

    const llmReady = (this.model.getProperty("/llm/ready") as boolean) && this.currentProvider() !== "direct";
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
      this.model.setProperty("/oDataQuery/modelLabel",     this.model.getProperty("/llm/selectedModelLabel") as string);
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

    const queries  = this.getQueriesToRun();
    const repeat   = Math.max(1, parseInt(this.model.getProperty("/benchmark/repeat") as string, 10) || 1);
    const provider = this.currentProvider();
    // The keyword baseline is selectable as a "model"; it never uses the LLM path.
    const llmReady = (this.model.getProperty("/llm/ready") as boolean) && provider !== "direct";
    const benchModelId    = this.model.getProperty("/llm/selectedModelId")    as string;
    const benchModelLabel = this.model.getProperty("/llm/selectedModelLabel") as string;

    this.model.setProperty("/benchmark/running",     true);
    this.model.setProperty("/benchmark/done",        false);
    this.model.setProperty("/benchmark/modelLabel",  benchModelLabel);
    this.model.setProperty("/benchmark/total",       queries.length);
    this.model.setProperty("/benchmark/repetitions", []);

    const repetitions: RunRepetition[] = [];
    for (let rep = 0; rep < repeat; rep++) {
      this.model.setProperty("/benchmark/repeatIndex", rep + 1);
      this.model.setProperty("/benchmark/repeatLabel", repeat > 1 ? `Run ${rep + 1}/${repeat}` : "");
      const startedAt = new Date().toISOString();
      this.model.setProperty("/benchmark/startedAt", startedAt);

      const results = await this.runBenchmarkOnce(queries, { benchModelId, benchModelLabel, llmReady, provider });
      repetitions.push({ index: rep + 1, startedAt, finishedAt: new Date().toISOString(), results, summary: this.computeRunSummary(results) });
      this.model.setProperty("/benchmark/repetitions", [...repetitions]);
    }

    this.model.setProperty("/benchmark/running",          false);
    this.model.setProperty("/benchmark/done",             true);
    this.model.setProperty("/benchmark/currentQueryText", "");

    const last    = repetitions[repetitions.length - 1].summary;
    const emNote  = this.goldByQuery.size ? ` · EM ${last.emPassed}/${last.totalQueries}` : "";
    const repNote = repeat > 1 ? ` · ${repeat} runs` : "";
    MessageToast.show(`Benchmark complete — ESR ${last.passed}/${last.totalQueries} (${Math.round(last.esrPct)}%)${emNote}${repNote}`);
  }

  /** Runs the query set once, streaming rows into /benchmark/results as they complete. */
  private async runBenchmarkOnce(
    queries: Array<{ query: string; expectedEntity: string; type: string }>,
    ctx: { benchModelId: string; benchModelLabel: string; llmReady: boolean; provider: ModelProvider }
  ): Promise<BenchmarkResult[]> {
    const { benchModelId, benchModelLabel, llmReady, provider } = ctx;

    this.model.setProperty("/benchmark/progress",         0);
    this.model.setProperty("/benchmark/passed",           0);
    this.model.setProperty("/benchmark/accuracy",         "—");
    this.model.setProperty("/benchmark/emPassed",         0);
    this.model.setProperty("/benchmark/emAccuracy",       "—");
    this.model.setProperty("/benchmark/falsePositives",   0);
    this.model.setProperty("/benchmark/results",          []);
    this.model.setProperty("/benchmark/currentQueryText", "");
    this.model.setProperty("/benchmark/typeStats", {
      T1: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
      T2: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
      T3: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
      T4: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
      T5: { total: 0, passed: 0, pct: "—", em: 0, emPct: "—" },
    });

    const results: BenchmarkResult[] = [];
    let passed = 0;
    let emPassed = 0;
    let falsePositives = 0;

    for (let i = 0; i < queries.length; i++) {
      const bq = queries[i];
      this.model.setProperty("/query",                      bq.query);
      this.model.setProperty("/benchmark/currentQueryText", bq.query);

      const t0 = performance.now();
      let detectedEntity = "";
      let hasResults     = false;
      let validationPass = false;
      let entityMatch    = false;
      let planOut: QueryPlan | null = null;
      let trace: GenerationTrace | null = null;
      let urlOut: string | null = null;
      let httpStatus: number | null = null;
      let recordCount: number | null = null;
      let error: string | null = null;
      let stage: "generate" | "build" | "fetch" = "generate";

      try {
        let plan: QueryPlan;
        if (llmReady) {
          plan  = await this.llmService.generateQueryPlan(bq.query);
          trace = this.llmService.lastGeneration;
        } else {
          const entity = this.detectEntity(bq.query);
          const term   = this.extractKeyTerm(bq.query);
          plan = { entity, filter: (DIRECT_FILTERS[entity] ?? DIRECT_FILTERS.Products)(term), orderby: "", top: 20 };
        }

        planOut        = plan;
        detectedEntity = plan.entity;
        entityMatch    = plan.entity === bq.expectedEntity;

        const vr  = this.queryValidator.validate(plan);
        validationPass = vr.valid;

        stage = "build";
        const url = this.queryBuilder.build(plan, this.ODATA_BASE);
        urlOut = url;

        stage = "fetch";
        const res  = await fetch(url, { headers: { Accept: "application/json" } });
        httpStatus = res.status;
        if (res.ok) {
          const data  = await res.json() as { value: unknown[] };
          recordCount = (data.value ?? []).length;
          hasResults  = recordCount > 0;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        // A JSON-parse failure throws before `trace` is assigned; recover it so rawLlmText is still logged.
        if (llmReady) trace = trace ?? this.llmService.lastGeneration;
      }
      const errorStage = error ? stage : null;

      const totalMs  = Math.round(performance.now() - t0);
      const isPassed = entityMatch && hasResults;
      if (isPassed) passed++;

      // Exact match against the gold query (looked up by text so query subsets still align).
      // Scored on what was actually sent — the URL — falling back to the plan if build() threw.
      const gold = this.goldByQuery.get(bq.query) ?? null;
      let exactMatch: boolean | null = null;
      if (gold) {
        let gotEntity = detectedEntity, gotFilter = planOut?.filter ?? "";
        if (urlOut) ({ entity: gotEntity, filter: gotFilter } = filterFromUrl(urlOut));
        exactMatch = planOut !== null && isExactMatch(gotEntity, gotFilter, gold);
      }
      if (exactMatch) emPassed++;
      if (isPassed && exactMatch === false) falsePositives++;

      // Per-type accuracy update
      const ts = this.model.getProperty("/benchmark/typeStats") as Record<string, { total: number; passed: number; pct: string; em: number; emPct: string }>;
      const qt = bq.type;
      const tTotal  = (ts[qt]?.total  ?? 0) + 1;
      const tPassed = (ts[qt]?.passed ?? 0) + (isPassed ? 1 : 0);
      const tEm     = (ts[qt]?.em     ?? 0) + (exactMatch ? 1 : 0);
      this.model.setProperty(`/benchmark/typeStats/${qt}`, {
        total: tTotal, passed: tPassed,
        pct: `${Math.round((tPassed / tTotal) * 100)}%`,
        em: tEm,
        emPct: gold ? `${Math.round((tEm / tTotal) * 100)}%` : "—"
      });

      const entry: BenchmarkResult = {
        idx: i + 1, query: bq.query, expectedEntity: bq.expectedEntity,
        queryType: bq.type, detectedEntity, entityMatch, hasResults,
        validationPassed: validationPass, totalMs, passed: isPassed,
        status: isPassed ? "Passed" : "Failed",
        statusState: isPassed ? "Success" : "Error",
        modelId:    benchModelId,
        modelLabel: benchModelLabel,
        plan: planOut,
        prePostProcessPlan: trace?.prePostProcessPlan ?? null,
        rawLlmText: trace?.rawText ?? null,
        url: urlOut,
        httpStatus,
        recordCount,
        error,
        errorStage,
        llmMode: llmReady ? provider : "direct",
        goldIdx: gold?.idx ?? null,
        goldFilter: gold?.filter ?? null,
        exactMatch,
      };

      results.push(entry);
      this.model.setProperty("/benchmark/results",          [...results]);
      this.model.setProperty("/benchmark/progress",         Math.round(((i + 1) / queries.length) * 100));
      this.model.setProperty("/benchmark/passed",           passed);
      this.model.setProperty("/benchmark/accuracy",         `${Math.round((passed / (i + 1)) * 100)}%`);
      this.model.setProperty("/benchmark/emPassed",         emPassed);
      this.model.setProperty("/benchmark/emAccuracy",       this.goldByQuery.size ? `${Math.round((emPassed / (i + 1)) * 100)}%` : "—");
      this.model.setProperty("/benchmark/falsePositives",   falsePositives);
    }

    return results;
  }

  /** Returns the proportional query subset based on selected count, with custom queries appended. */
  private getQueriesToRun(): Array<{ query: string; expectedEntity: string; type: string }> {
    const count = parseInt(this.model.getProperty("/benchmark/queryCount") as string, 10) || 100;
    const custom = this.model.getProperty("/benchmark/customQueries") as Array<{ query: string; expectedEntity: string; type: string }>;

    if (count >= 100) return [...BENCHMARK_QUERIES, ...custom];

    const byType: Record<string, typeof BENCHMARK_QUERIES> = { T1: [], T2: [], T3: [], T4: [], T5: [] };
    BENCHMARK_QUERIES.forEach(q => byType[q.type]?.push(q));
    const perType = Math.max(1, Math.floor(count / 5));
    const selected = (["T1", "T2", "T3", "T4", "T5"] as const).flatMap(t => (byType[t] ?? []).slice(0, perType));

    return [...selected, ...custom];
  }

  /** Opens the Add Custom Query dialog. */
  public onOpenAddQuery(): void {
    this.model.setProperty("/benchmark/newQuery", { query: "", entity: "Products", type: "T1" });
    const dialog = this.byId("addQueryDialog");
    if (dialog) (dialog as unknown as { open(): void }).open();
  }

  /** Confirms adding a custom query to the benchmark queue. */
  public onConfirmAddQuery(): void {
    const nq = this.model.getProperty("/benchmark/newQuery") as { query: string; entity: string; type: string };
    if (!nq.query.trim()) { MessageToast.show("Please enter a query"); return; }
    const custom = this.model.getProperty("/benchmark/customQueries") as Array<{ query: string; expectedEntity: string; type: string }>;
    this.model.setProperty("/benchmark/customQueries", [
      ...custom, { query: nq.query.trim(), expectedEntity: nq.entity, type: nq.type }
    ]);
    const dialog = this.byId("addQueryDialog");
    if (dialog) (dialog as unknown as { close(): void }).close();
    MessageToast.show(`Custom query added (${custom.length + 1} total)`);
  }

  /** Closes the Add Custom Query dialog without saving. */
  public onCancelAddQuery(): void {
    const dialog = this.byId("addQueryDialog");
    if (dialog) (dialog as unknown as { close(): void }).close();
  }

  /** Removes a custom query from the queue by its list binding index. */
  public onRemoveCustomQuery(event: { getSource(): { getBindingContext(): { getPath(): string } } }): void {
    const path = event.getSource().getBindingContext().getPath();
    const idx  = parseInt(path.split("/").pop() ?? "0", 10);
    const custom = (this.model.getProperty("/benchmark/customQueries") as Array<unknown>).filter((_, i) => i !== idx);
    this.model.setProperty("/benchmark/customQueries", custom);
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

  /**
   * Downloads the completed benchmark results as a CSV file that Excel can open.
   * Each row represents one benchmark query with all pass/fail criteria columns.
   * Bound to the "Download Results" button in the Benchmark Runner section.
   */
  public onDownloadBenchmark(): void {
    const results = this.model.getProperty("/benchmark/results") as BenchmarkResult[];
    if (!results || results.length === 0) {
      MessageToast.show("No results to download — run the benchmark first");
      return;
    }

    const headers = [
      "#", "Model", "Query", "Type", "Expected Entity", "Detected Entity",
      "Entity Match", "Has Results", "Validation Passed", "Time (ms)", "Status",
      "Expected Query (Gold)", "Generated Query", "Exact Match", "OData URL", "Error"
    ];

    const rows = results.map(r => [
      r.idx,
      csvEscape(r.modelLabel || ""),
      csvEscape(r.query),
      r.queryType,
      r.expectedEntity,
      r.detectedEntity || "",
      r.entityMatch ? "Yes" : "No",
      r.hasResults ? "Yes" : "No",
      r.validationPassed ? "Yes" : "No",
      r.totalMs,
      r.passed ? "Pass" : "Fail",
      csvEscape(r.goldFilter ?? ""),
      csvEscape(r.plan?.filter ?? ""),
      r.exactMatch === null ? "n/a" : (r.exactMatch ? "Yes" : "No"),
      csvEscape(r.url ?? ""),
      csvEscape(r.error ?? "")
    ].join(","));

    const s = this.computeRunSummary(results);
    const summaryRows: Array<[string, unknown]> = [
      ["Model", s.model],
      ["Model ID", s.modelId],
      ["Prompt Version", s.promptVersion],
      ["Run Date", s.runDate],
      ["Total Queries", s.totalQueries],
      ["Passed (ESR)", s.passed],
      ["ESR %", s.esrPct],
      ["Exact Match (EM)", s.emPassed],
      ["EM %", s.emPct],
      ["EM Scored (rows with gold)", s.emScored],
      ["ESR False Positives (ESR pass, EM fail)", s.esrFalsePositives],
      ["ESR FP Rate % (of ESR passes)", s.esrFpRatePct],
      ...(["T1", "T2", "T3", "T4", "T5"] as const).flatMap((t): Array<[string, unknown]> => [
        [`${t} Passed (ESR)`, s.byType[t].passed],
        [`${t} Total`,        s.byType[t].total],
        [`${t} ESR %`,        s.byType[t].pct],
        [`${t} EM`,           s.byType[t].em],
        [`${t} EM %`,         s.byType[t].emPct],
      ]),
      ["Entity Match Count", s.entityMatchCount],
      ["Has Results Count", s.hasResultsCount],
      ["Validation Passed Count", s.validationPassedCount],
      ["Errors", s.errorCount],
      ["Median ms", s.medianMs],
      ["Mean ms", s.meanMs],
      ["Max ms", s.maxMs],
      [`Stalls (>${STALL_THRESHOLD_MS} ms)`, s.stalls],
      ["Provider", this.currentProvider()],
      ["Model Size", MODEL_REGISTRY.find(m => m.id === s.modelId)?.sizeLabel ?? ""],
      ["GPU", this.gpuLabel()],
      ["Browser", navigator.userAgent],
      ["JS Heap Used (MB)", this.jsHeapUsedMb() ?? "n/a"],
    ];
    const reps = this.model.getProperty("/benchmark/repetitions") as RunRepetition[];
    summaryRows.push(["Repetition Shown", `${this.model.getProperty("/benchmark/repeatIndex") as number} of ${reps.length || 1}`]);
    if (reps.length > 1) {
      const esr = this.meanSd(reps.map(r => r.summary.esrPct));
      const em  = this.meanSd(reps.map(r => r.summary.emPct));
      summaryRows.push([`ESR % mean ± sd (${reps.length} runs)`, `${esr.mean} ± ${esr.sd}`]);
      summaryRows.push([`EM % mean ± sd (${reps.length} runs)`,  `${em.mean} ± ${em.sd}`]);
    }

    const csv = [
      headers.join(","),
      ...rows,
      "",
      "Metric,Value",
      ...summaryRows.map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`)
    ].join("\r\n");

    const bom  = "﻿"; // UTF-8 BOM so Excel detects encoding correctly
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
    this.triggerDownload(blob, this.benchmarkFileName("csv"));
    MessageToast.show(`Downloaded ${results.length} benchmark results`);
  }

  /**
   * Downloads the completed benchmark as JSON, including every generated query
   * plan and OData URL. This is the input for scripts/score-exact-match.mjs;
   * drop the file into BENCHMARK/runs/ and run `npm run score`.
   */
  public onDownloadBenchmarkJson(): void {
    const results = this.model.getProperty("/benchmark/results") as BenchmarkResult[];
    if (!results || results.length === 0) {
      MessageToast.show("No results to download — run the benchmark first");
      return;
    }

    const summary = this.computeRunSummary(results);
    const reps    = this.model.getProperty("/benchmark/repetitions") as RunRepetition[];
    const aggregate = reps.length > 1 ? {
      runs:   reps.length,
      esrPct: this.meanSd(reps.map(r => r.summary.esrPct)),
      emPct:  this.meanSd(reps.map(r => r.summary.emPct)),
      esrFpRatePct: this.meanSd(reps.map(r => r.summary.esrFpRatePct)),
      medianMs: this.meanSd(reps.map(r => r.summary.medianMs)),
    } : null;
    const payload = {
      schemaVersion: 2,
      model:         summary.model,
      modelId:       summary.modelId,
      provider:      this.currentProvider(),
      modelSize:     MODEL_REGISTRY.find(m => m.id === summary.modelId)?.sizeLabel ?? null,
      promptVersion: PROMPT_VERSION,
      odataBase:     this.ODATA_BASE,
      date:          summary.runDate,
      queryCount:    results.length,
      llmMode:       results[0]?.llmMode ?? this.currentProvider(),
      goldCount:     this.goldByQuery.size,
      hardware:      { ...this.hardware, jsHeapUsedMb: this.jsHeapUsedMb() },
      repeat:        reps.length || 1,
      aggregate,
      summary,
      results,
      repetitions:   reps.map(r => ({ index: r.index, startedAt: r.startedAt, finishedAt: r.finishedAt, summary: r.summary, results: r.results })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    this.triggerDownload(blob, this.benchmarkFileName("json"));
    MessageToast.show(`Downloaded ${results.length} results as JSON`);
  }

  private hardware: Record<string, unknown> = {};

  /**
   * Records what a browser can tell us about the client for the paper's performance section:
   * UA, cores, (Chrome) device memory, and the WebGPU adapter description/limits. True VRAM
   * use and GPU utilisation are not exposed to web pages and must be measured externally.
   */
  private async captureHardware(): Promise<void> {
    const nav = navigator as Navigator & { deviceMemory?: number; gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } };
    const hw: Record<string, unknown> = {
      userAgent: nav.userAgent,
      platform: nav.platform,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemoryGb: nav.deviceMemory ?? null,
      gpu: null,
      gpuLimits: null,
    };
    try {
      const adapter = await nav.gpu?.requestAdapter();
      if (adapter) {
        const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : undefined);
        if (info) hw.gpu = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
        if (adapter.limits) hw.gpuLimits = { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize };
      }
    } catch { /* adapter info unavailable in this browser */ }
    this.hardware = hw;
  }

  private gpuLabel(): string {
    const g = this.hardware.gpu as Record<string, string> | null | undefined;
    if (!g) return "n/a";
    return [g.vendor, g.architecture, g.device, g.description].filter(Boolean).join(" · ");
  }

  private jsHeapUsedMb(): number | null {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? Math.round(mem.usedJSHeapSize / 1_048_576) : null;
  }

  /** Mean and sample standard deviation (n−1), both to one decimal. */
  private meanSd(xs: number[]): { mean: number; sd: number; n: number } {
    const n = xs.length;
    if (n === 0) return { mean: 0, sd: 0, n };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
    return { mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 10) / 10, n };
  }

  /**
   * Loads BENCHMARK/gold/gold_queries.json through the local proxy (srv/server.mjs serves
   * it at /gold). Exact match is only computed when this succeeds; otherwise EM shows "—".
   */
  private async loadGold(): Promise<void> {
    try {
      const res = await fetch(`${new URL(this.ODATA_BASE).origin}/gold/gold_queries.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { entries: GoldEntry[] };
      this.goldByQuery = new Map(data.entries.map(g => [g.query, g]));
      this.model.setProperty("/benchmark/goldCount", this.goldByQuery.size);
    } catch (e) {
      console.warn("Gold queries unavailable — exact-match column disabled.", e);
      this.model.setProperty("/benchmark/goldCount", 0);
    }
  }

  private computeRunSummary(results: BenchmarkResult[]): RunSummary {
    const times = results.map(r => r.totalMs).sort((a, b) => a - b);
    const n = times.length;
    const median = n === 0 ? 0
      : n % 2 === 1 ? times[(n - 1) / 2]
      : Math.round((times[n / 2 - 1] + times[n / 2]) / 2);
    const mean = n === 0 ? 0 : Math.round(times.reduce((a, b) => a + b, 0) / n);
    const pct  = (p: number, t: number) => (t === 0 ? 0 : Math.round((p / t) * 1000) / 10);

    const byType: RunSummary["byType"] = {};
    for (const t of ["T1", "T2", "T3", "T4", "T5"]) {
      const rows   = results.filter(r => r.queryType === t);
      const p      = rows.filter(r => r.passed).length;
      const em     = rows.filter(r => r.exactMatch === true).length;
      const scored = rows.filter(r => r.exactMatch !== null).length;
      byType[t]    = { total: rows.length, passed: p, pct: pct(p, rows.length), em, emPct: pct(em, scored) };
    }

    const passed            = results.filter(r => r.passed).length;
    const emScored          = results.filter(r => r.exactMatch !== null).length;
    const emPassed          = results.filter(r => r.exactMatch === true).length;
    const esrFalsePositives = results.filter(r => r.passed && r.exactMatch === false).length;
    return {
      model:         (this.model.getProperty("/benchmark/modelLabel") as string) || "unknown",
      modelId:       results[0]?.modelId ?? ((this.model.getProperty("/llm/selectedModelId") as string) || ""),
      promptVersion: PROMPT_VERSION,
      runDate:       (this.model.getProperty("/benchmark/startedAt") as string) || new Date().toISOString(),
      totalQueries:  n,
      passed,
      esrPct:        pct(passed, n),
      emScored,
      emPassed,
      emPct:         pct(emPassed, emScored),
      esrFalsePositives,
      esrFpRatePct:  pct(esrFalsePositives, passed),
      byType,
      entityMatchCount:      results.filter(r => r.entityMatch).length,
      hasResultsCount:       results.filter(r => r.hasResults).length,
      validationPassedCount: results.filter(r => r.validationPassed).length,
      errorCount:            results.filter(r => r.error).length,
      medianMs: median,
      meanMs:   mean,
      maxMs:    n ? times[n - 1] : 0,
      stalls:   results.filter(r => r.totalMs > STALL_THRESHOLD_MS).length,
    };
  }

  private benchmarkFileName(ext: "csv" | "json"): string {
    const label = ((this.model.getProperty("/benchmark/modelLabel") as string) || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
    return `floria_benchmark_${label}_${new Date().toISOString().slice(0, 10)}.${ext}`;
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
