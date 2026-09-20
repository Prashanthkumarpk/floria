/**
 * WebLLMService.ts
 *
 * Manages the lifecycle of the on-device large language model used to translate
 * natural-language questions into OData v4 query plans.
 *
 * The model (Qwen2.5-0.5B-Instruct, Q4F16 quantised) runs entirely in the browser
 * via WebGPU using the WebLLM / MLC-LLM runtime. No data ever leaves the device
 * during inference — a key requirement for enterprise deployments under GDPR or
 * strict data-governance policies.
 *
 * Loading strategy
 * ----------------
 * SAP UI5 uses an AMD module loader that cannot resolve npm-style ESM imports.
 * Instead of fighting the module system, we dynamically inject a <script type="module">
 * tag that loads WebLLM outside AMD and writes the engine factory to window.mlc.
 * UI5 TypeScript code then accesses it as a plain global.
 *
 * The loader script path is resolved via sap.ui.require.toUrl() so it works
 * correctly whether the app is launched from index.html or test/flpSandbox.html.
 *
 * First load: ~40 s (model download + WebGPU shader compilation, cached in IndexedDB).
 * Subsequent loads: < 4 s (cache hit, shader reuse).
 */

// Extend the browser Window interface so TypeScript knows about the MLC global
// that the loader script injects at runtime.
declare global {
  interface Window {
    mlc?: Record<string, unknown>;
    mlcLoaded?: boolean;
  }
}

/**
 * The structured output produced by the LLM for every user question.
 * The controller and ODataQueryBuilder consume this interface; the validator
 * checks its field names against the live Northwind schema.
 */
export interface QueryPlan {
  /** Northwind entity set name, e.g. "Products" or "Customers" */
  entity: string;
  /** OData v4 $filter expression, or empty string if no filter is needed */
  filter?: string;
  /** OData $orderby expression, e.g. "UnitPrice asc" */
  orderby?: string;
  /** Maximum records to retrieve; clamped to [1, 50] by ODataQueryBuilder */
  top?: number;
}

interface InitProgressReport {
  progress: number;   // 0.0 – 1.0
  timeElapsed: number;
  text: string;
}

export type ProgressCallback = (report: InitProgressReport) => void;

// Opaque type for the MLC engine — we only use it through the chat.completions API.
type MLCEngine = Record<string, unknown>;

export interface ModelInfo {
  id: string;
  label: string;
  vendor: string;
  sizeLabel: string;
  params: string;
}

export const MODEL_REGISTRY: ModelInfo[] = [
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",       label: "Qwen2.5-0.5B",       vendor: "Alibaba",   sizeLabel: "~300 MB", params: "0.5B"  },
  { id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",  label: "Qwen2.5-Coder-1.5B", vendor: "Alibaba",   sizeLabel: "~900 MB", params: "1.5B"  },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",        label: "Llama-3.2-3B",       vendor: "Meta",      sizeLabel: "~2.0 GB", params: "3B"    },
  { id: "gemma-2-2b-it-q4f16_1-MLC",                label: "Gemma-2-2B",          vendor: "Google",    sizeLabel: "~1.5 GB", params: "2B"    },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC",        label: "Phi-3.5-mini",        vendor: "Microsoft", sizeLabel: "~2.2 GB", params: "3.8B"  },
];

/**
 * @namespace research.chat.util
 */
export default class WebLLMService {

  private currentModelId = MODEL_REGISTRY[0].id;

  private engine: MLCEngine | null = null;
  private initPromise: Promise<void> | null = null;
  private isReady = false;

  // Static flags prevent duplicate script injection across multiple service instances.
  private static scriptLoaded = false;
  private static scriptLoadPromise: Promise<void> | null = null;

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns true when WebGPU is available in the current browser.
   * Chrome/Edge 113+ and Safari 18+ support it natively. Firefox requires a flag.
   * Without WebGPU the service falls back gracefully; the controller switches to
   * keyword-based direct-mode search.
   */
  public static isWebGPUAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  /**
   * Starts model initialisation and returns a promise that resolves when the
   * engine is ready to accept queries. Safe to call multiple times — subsequent
   * calls return the same promise.
   *
   * @param progressCallback  Optional callback invoked during model download and
   *                          shader compilation to update the UI progress bar.
   */
  public async initialize(progressCallback?: ProgressCallback): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (!WebLLMService.isWebGPUAvailable()) throw new Error("WebGPU unavailable.");

    this.initPromise = (async () => {
      await this.loadWebLLM();
      if (!window.mlc?.CreateMLCEngine) throw new Error("WebLLM failed to load.");
      this.engine = await (window.mlc.CreateMLCEngine as Function)(
        this.currentModelId,
        { initProgressCallback: progressCallback }
      ) as MLCEngine;
      this.isReady = true;
    })();

    return this.initPromise;
  }

  /** Returns true once the engine has finished loading and is ready for inference. */
  public getIsReady(): boolean { return this.isReady; }

  public getCurrentModelId(): string { return this.currentModelId; }

  public async switchModel(modelId: string, progressCallback?: ProgressCallback): Promise<void> {
    this.engine      = null;
    this.isReady     = false;
    this.initPromise = null;
    this.currentModelId = modelId;
    return this.initialize(progressCallback);
  }

  public async precacheModel(modelId: string, progressCallback?: ProgressCallback): Promise<void> {
    await this.loadWebLLM();
    if (!window.mlc?.CreateMLCEngine) throw new Error("WebLLM not loaded.");
    await (window.mlc.CreateMLCEngine as Function)(modelId, { initProgressCallback: progressCallback });
  }

  /**
   * Sends the user's natural-language question to the local LLM and parses the
   * structured JSON query plan from the response.
   *
   * The model is prompted at temperature 0.1 to minimise hallucination while
   * still allowing slight paraphrasing. The response is post-processed to:
   *   1. Strip markdown fences the model sometimes wraps around the JSON.
   *   2. Extract the first {...} block if the model adds preamble text.
   *   3. Correct known OData v2 syntax mistakes (substringof → contains).
   *
   * @param userQuestion  Raw natural-language input from the search textarea.
   * @throws If the engine is not ready or the model returns unparseable JSON.
   */
  public async generateQueryPlan(userQuestion: string): Promise<QueryPlan> {
    if (!this.engine || !this.isReady) throw new Error("AI not ready yet.");

    const request = {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userQuestion }
      ],
      temperature: 0.1,
      max_tokens: 150
    };

    type CompletionsAPI = { create: (req: unknown) => Promise<Record<string, unknown>> };
    const response = await (this.engine as Record<string, Record<string, CompletionsAPI>>)
      .chat.completions.create(request);

    const choices = response.choices as Array<Record<string, Record<string, unknown>>>;
    let raw = (choices[0]?.message?.content as string ?? "").trim();

    // Strip optional markdown code fence (```json ... ```)
    const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenced) raw = fenced[1];

    // Extract the first well-formed JSON object in case the model adds prose
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);

    try {
      const plan = JSON.parse(raw) as QueryPlan;
      return this.fixKnownMistakes(plan);
    } catch {
      throw new Error("AI returned invalid JSON. Try rephrasing your question.");
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Injects the WebLLM loader script into the document head and waits for it to
   * signal readiness via the window.mlcLoaded flag.
   *
   * We use a polling interval rather than the script's onload because the MLC
   * engine factory is assigned asynchronously after the module script executes.
   * A 15-second timeout prevents silent hangs on slow networks or WebGPU failures.
   */
  private async loadWebLLM(): Promise<void> {
    if (WebLLMService.scriptLoaded && window.mlc) return;
    if (WebLLMService.scriptLoadPromise) return WebLLMService.scriptLoadPromise;

    WebLLMService.scriptLoadPromise = new Promise((resolve, reject) => {
      if (window.mlc) { WebLLMService.scriptLoaded = true; resolve(); return; }

      const script = document.createElement("script");
      script.type = "module";

      // sap.ui.require.toUrl() resolves the module path against the registered
      // resource root ("research.chat" → webapp/), giving the correct absolute
      // URL regardless of which HTML entry point launched the application.
      // @ts-ignore — sap is a UI5 bootstrap global; not visible to the TS compiler here
      const toUrl = (sap as unknown as { ui: { require: { toUrl(p: string): string } } })
        .ui.require.toUrl;
      script.src = toUrl("research/chat/libs/web-llm/loader.js");

      const checkInterval = setInterval(() => {
        if (window.mlcLoaded && window.mlc) {
          clearInterval(checkInterval);
          WebLLMService.scriptLoaded = true;
          resolve();
        }
      }, 100);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        if (!window.mlcLoaded) reject(new Error("Timeout loading WebLLM."));
      }, 15000);

      script.onload  = () => console.log("WebLLM loader injected");
      script.onerror = (e) => { clearInterval(checkInterval); clearTimeout(timeout); reject(e); };
      document.head.appendChild(script);
    });

    return WebLLMService.scriptLoadPromise;
  }

  /**
   * Corrects known generation errors from the 0.5B model before the plan reaches
   * the validator or query builder.
   *
   * Fix 1 — OData v2 substringof → v4 contains.
   * Fix 2 — Collapsed multi-value OR: Field eq 'A or B' → Field eq 'A' or Field eq 'B'.
   * Fix 3 — Entity alias normalisation: the model occasionally hallucinates entity
   *   names like "Catalog", "Customer" (singular), or "OrderDetails" (no underscore).
   * Fix 4 — Orders entity: standalone `Country` field → `ShipCountry` (Orders has no
   *   bare `Country` column; the destination field is always ShipCountry).
   * Fix 5 — Customers entity: model sometimes writes `CustomerCountry`, `CountryName`,
   *   or `ShipCountry` instead of the correct `Country` field.
   * Fix 6 — startswith capitalisation: Northwind string data is title-cased, so
   *   `startswith(LastName,'d')` returns nothing; capitalise the first search char.
   */
  private fixKnownMistakes(plan: QueryPlan): QueryPlan {
    // Fix 3: entity alias normalisation
    const ENTITY_ALIASES: Record<string, string> = {
      Catalog: "Products",     Product: "Products",
      Customer: "Customers",
      Employee: "Employees",
      Supplier: "Suppliers",
      Order: "Orders",
      Category: "Categories",
      OrderDetails: "Order_Details",  OrderDetail: "Order_Details",
    };
    if (ENTITY_ALIASES[plan.entity]) {
      plan = { ...plan, entity: ENTITY_ALIASES[plan.entity] };
    }

    if (!plan.filter) return plan;
    let f = plan.filter;

    // Fix 1a: substringof('term', Field) eq true  →  contains(Field,'term')
    f = f.replace(
      /substringof\(\s*'([^']+)'\s*,\s*([A-Za-z_]\w*)\s*\)\s*(?:eq\s*true)?/gi,
      "contains($2,'$1')"
    );
    // Fix 1b: reversed arg order
    f = f.replace(
      /substringof\(\s*([A-Za-z_]\w*)\s*,\s*'([^']+)'\s*\)\s*(?:eq\s*true)?/gi,
      "contains($1,'$2')"
    );

    // Fix 2: Field eq 'A or B'  →  Field eq 'A' or Field eq 'B'
    f = f.replace(
      /(\w+)\s+eq\s+'([^']+)\s+or\s+([^']+)'/gi,
      "$1 eq '$2' or $1 eq '$3'"
    );

    // Fix 4: Orders – bare Country → ShipCountry (negative lookbehind skips Ship prefix)
    if (plan.entity === "Orders") {
      f = f.replace(/(?<![A-Za-z])Country(?![A-Za-z])/g, "ShipCountry");
    }

    // Fix 5: Customers – wrong Country synonyms → Country
    if (plan.entity === "Customers") {
      f = f.replace(/\b(CustomerCountry|CountryName|ShipCountry)\b/g, "Country");
    }

    // Fix 6: capitalise first char of startswith search term (Northwind is title-cased)
    f = f.replace(
      /startswith\(([A-Za-z_]\w*)\s*,\s*'([a-z])/g,
      (_, field, firstChar) => `startswith(${field},'${firstChar.toUpperCase()}`
    );

    return { ...plan, filter: f.trim() };
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
//
// The prompt is the sole mechanism by which the model learns the Northwind schema
// and OData v4 syntax rules — no fine-tuning is performed. It is structured in
// four blocks following the approach described in the NL2OData paper:
//
//   [ENTITIES]  — field names per entity set (schema injection)
//   [FORMAT]    — required JSON output shape
//   [RULES]     — OData v4 filter grammar with explicit WRONG/RIGHT examples
//   [EXAMPLES]  — one shot per query taxonomy type T1–T5 (two each)
//
// Temperature is fixed at 0.1 across all runs to maximise determinism.
// response_format:{type:"json_object"} is intentionally excluded — in WebLLM
// v0.2.84 it triggers a WASM binding crash inside the TVM grammar compiler.

const SYSTEM_PROMPT = `You generate OData v4 query plans for the Northwind database.
Output ONLY a valid JSON object. No explanation, no markdown, no extra text.

ENTITIES AND FIELDS:
Products: ProductName, UnitPrice, UnitsInStock, UnitsOnOrder, ReorderLevel, Discontinued, QuantityPerUnit, CategoryID, SupplierID
Categories: CategoryName, Description
Customers: CompanyName, ContactName, ContactTitle, City, Region, Country, Phone, PostalCode
Orders: CustomerID, EmployeeID, OrderDate, RequiredDate, ShippedDate, Freight, ShipName, ShipCity, ShipCountry
Employees: FirstName, LastName, Title, City, Country, HireDate, BirthDate, ReportsTo
Suppliers: CompanyName, ContactName, City, Country, Phone
Order_Details: OrderID, ProductID, UnitPrice, Quantity, Discount

OUTPUT FORMAT:
{"entity":"<EntityName>","filter":"<OData v4 filter or empty string>","orderby":"<field asc|desc or empty>","top":<5-50>}

OData v4 FILTER RULES:
- String equality:   Country eq 'France'
- String contains:   contains(ProductName,'chai')
- String startswith: startswith(LastName,'D')
- Number compare:    UnitPrice lt 15  |  Freight gt 100  |  UnitsInStock le 10
- Boolean:           Discontinued eq true  |  Discontinued eq false
- AND condition:     (UnitPrice lt 15) and (UnitsInStock gt 0)
- OR two values:     Country eq 'Germany' or Country eq 'France'

CRITICAL RULES — NEVER BREAK THESE:
1. For string contains, ALWAYS use contains(Field,'term') — NEVER use substringof
2. For OR with two values, ALWAYS repeat the field name: Field eq 'A' or Field eq 'B'
   NEVER write: Field eq 'A or B'  or  Field eq 'A','B'
3. For "list all" / "show all" / "get all" / "display all" queries with no filter, use filter:""
4. For Orders location queries, use ShipCountry or ShipCity — NEVER bare Country or City
5. For Customers location queries, use Country or City — NEVER ShipCountry
6. For startswith, ALWAYS capitalise the first letter of the search term

EXAMPLES (follow these patterns exactly):

User: list all categories
{"entity":"Categories","filter":"","orderby":"CategoryName asc","top":20}

User: show all employees
{"entity":"Employees","filter":"","orderby":"LastName asc","top":20}

User: list all customers
{"entity":"Customers","filter":"","orderby":"CompanyName asc","top":20}

User: show all products
{"entity":"Products","filter":"","orderby":"ProductName asc","top":20}

User: show all orders
{"entity":"Orders","filter":"","orderby":"OrderDate desc","top":20}

User: products cheaper than $15
{"entity":"Products","filter":"UnitPrice lt 15","orderby":"UnitPrice asc","top":20}

User: orders with freight over 100
{"entity":"Orders","filter":"Freight gt 100","orderby":"Freight desc","top":20}

User: products with chai in the name
{"entity":"Products","filter":"contains(ProductName,'chai')","orderby":"ProductName asc","top":20}

User: customers with restaurant in name
{"entity":"Customers","filter":"contains(CompanyName,'restaurant')","orderby":"CompanyName asc","top":20}

User: employees with last name starting with D
{"entity":"Employees","filter":"startswith(LastName,'D')","orderby":"LastName asc","top":20}

User: discontinued products
{"entity":"Products","filter":"Discontinued eq true","orderby":"ProductName asc","top":20}

User: customers from Germany
{"entity":"Customers","filter":"Country eq 'Germany'","orderby":"CompanyName asc","top":20}

User: employees from USA
{"entity":"Employees","filter":"Country eq 'USA'","orderby":"LastName asc","top":20}

User: orders shipped to France
{"entity":"Orders","filter":"ShipCountry eq 'France'","orderby":"OrderDate desc","top":20}

User: orders going to Germany
{"entity":"Orders","filter":"ShipCountry eq 'Germany'","orderby":"OrderDate desc","top":20}

User: customers from Germany or France
{"entity":"Customers","filter":"Country eq 'Germany' or Country eq 'France'","orderby":"CompanyName asc","top":20}

User: orders to France or Brazil
{"entity":"Orders","filter":"ShipCountry eq 'France' or ShipCountry eq 'Brazil'","orderby":"OrderDate desc","top":20}

User: most expensive products
{"entity":"Products","filter":"","orderby":"UnitPrice desc","top":10}

User: suppliers from UK
{"entity":"Suppliers","filter":"Country eq 'UK'","orderby":"CompanyName asc","top":20}

User: low stock products
{"entity":"Products","filter":"UnitsInStock lt 10","orderby":"UnitsInStock asc","top":20}

User: order details with quantity greater than 50
{"entity":"Order_Details","filter":"Quantity gt 50","orderby":"Quantity desc","top":20}

Output ONLY the JSON object.`;
