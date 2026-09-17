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

interface ColDef { key: string; label: string; width: string; numeric?: boolean }

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

const DIRECT_FILTERS: Record<string, (t: string) => string> = {
  Products:      t => t ? `contains(ProductName,'${t}')` : "",
  Categories:    t => t ? `contains(CategoryName,'${t}')` : "",
  Customers:     t => t ? `contains(CompanyName,'${t}') or contains(ContactName,'${t}') or contains(Country,'${t}') or contains(City,'${t}')` : "",
  Orders:        t => t ? `contains(ShipCountry,'${t}') or contains(ShipCity,'${t}') or contains(CustomerID,'${t}')` : "",
  Employees:     t => t ? `contains(LastName,'${t}') or contains(FirstName,'${t}') or contains(Country,'${t}') or contains(City,'${t}')` : "",
  Suppliers:     t => t ? `contains(CompanyName,'${t}') or contains(Country,'${t}') or contains(City,'${t}')` : "",
  Order_Details: () => "",
};

// 10 benchmark queries — 2 per taxonomy type
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
  private historySeq = 0;
  private readonly ODATA_BASE = "http://localhost:4004/odata";

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

    if (WebLLMService.isWebGPUAvailable()) void this.initLLM();
  }

  // ─── LLM init ──────────────────────────────────────────────────────────────

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

  public async onSearch(): Promise<void> {
    const text = (this.model.getProperty("/query") as string).trim();
    if (!text) return;

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

      // ── History + stats ──
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
      } catch { /* count as failed */ }

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

  public onClearHistory(): void {
    this.model.setProperty("/history", []);
    this.model.setProperty("/stats", { total: 0, aiQueries: 0, directQueries: 0, validatorCatches: 0, serverErrors: 0, esr: "—" });
  }

  public onHistoryItemPress(event: { getSource(): { getBindingContext(): { getProperty(p: string): unknown } } }): void {
    const ctx   = event.getSource().getBindingContext();
    const query = ctx.getProperty("query") as string;
    this.model.setProperty("/query", query);
    void this.onSearch();
  }

  // ─── Table rebuild ─────────────────────────────────────────────────────────

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

  private classifyQueryType(plan: QueryPlan): string {
    const f = (plan.filter ?? "").toLowerCase();
    if (!f) return "T1";
    if (/ or /.test(f))                         return "T5";
    if (/contains\(|startswith\(/.test(f))      return "T3";
    if (/ lt | gt | le | ge /.test(f))          return "T2";
    return "T4";
  }

  private computeConfidence(vr: ValidationResult, llmReady: boolean): { label: string; state: string } {
    if (!llmReady)    return { label: "Direct Mode",         state: "Warning" };
    if (!vr.valid)    return { label: "Low — schema errors", state: "Error"   };
    if (vr.warnings?.length) return { label: "Medium",       state: "Warning" };
    return              { label: "High",                     state: "Success" };
  }

  // ─── Direct-mode helpers ───────────────────────────────────────────────────

  private extractKeyTerm(query: string): string {
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
    words.sort((a, b) => b.length - a.length);
    const t = words[0] ?? "";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

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

  private pushHistory(entry: Omit<HistoryEntry, "id" | "timestamp">): void {
    const id   = ++this.historySeq;
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
    const list = this.model.getProperty("/history") as HistoryEntry[];
    this.model.setProperty("/history", [{ id, timestamp: time, ...entry }, ...list].slice(0, 50));
  }

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

  public onExampleQuery(event: { getSource(): { data(key: string): string } }): void {
    const q = event.getSource().data("query");
    if (!q) return;
    this.model.setProperty("/query", q);
    void this.onSearch();
  }

  public onCopyQuery(): void {
    const url = this.model.getProperty("/oDataQuery/url") as string;
    if (!url) return;
    navigator.clipboard.writeText(url)
      .then(() => MessageToast.show("OData URL copied"))
      .catch(() => MessageToast.show(url));
  }

  public onCloseError(): void {
    this.model.setProperty("/error", "");
  }
}
