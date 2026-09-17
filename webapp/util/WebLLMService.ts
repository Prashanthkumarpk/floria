declare global {
  interface Window {
    mlc?: Record<string, unknown>;
    mlcLoaded?: boolean;
  }
}

export interface QueryPlan {
  entity: string;
  filter?: string;
  orderby?: string;
  top?: number;
}

interface InitProgressReport {
  progress: number;
  timeElapsed: number;
  text: string;
}

export type ProgressCallback = (report: InitProgressReport) => void;
type MLCEngine = Record<string, unknown>;

/**
 * @namespace research.chat.util
 */
export default class WebLLMService {
  private static readonly MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

  private engine: MLCEngine | null = null;
  private initPromise: Promise<void> | null = null;
  private isReady = false;
  private static scriptLoaded = false;
  private static scriptLoadPromise: Promise<void> | null = null;

  public static isWebGPUAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  private async loadWebLLM(): Promise<void> {
    if (WebLLMService.scriptLoaded && window.mlc) return;
    if (WebLLMService.scriptLoadPromise) return WebLLMService.scriptLoadPromise;

    WebLLMService.scriptLoadPromise = new Promise((resolve, reject) => {
      if (window.mlc) { WebLLMService.scriptLoaded = true; resolve(); return; }

      const script = document.createElement("script");
      script.type = "module";
      script.src = "libs/web-llm/loader.js";

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

      script.onload = () => console.log("WebLLM loader injected");
      script.onerror = (e) => { clearInterval(checkInterval); clearTimeout(timeout); reject(e); };
      document.head.appendChild(script);
    });

    return WebLLMService.scriptLoadPromise;
  }

  public async initialize(progressCallback?: ProgressCallback): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (!WebLLMService.isWebGPUAvailable()) throw new Error("WebGPU unavailable.");

    this.initPromise = (async () => {
      await this.loadWebLLM();
      if (!window.mlc?.CreateMLCEngine) throw new Error("WebLLM failed to load.");
      this.engine = await (window.mlc.CreateMLCEngine as Function)(
        WebLLMService.MODEL_ID,
        { initProgressCallback: progressCallback }
      ) as MLCEngine;
      this.isReady = true;
    })();

    return this.initPromise;
  }

  public getIsReady(): boolean { return this.isReady; }

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

    const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenced) raw = fenced[1];

    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);

    try {
      return JSON.parse(raw) as QueryPlan;
    } catch {
      throw new Error("AI returned invalid JSON. Try rephrasing your question.");
    }
  }
}

const SYSTEM_PROMPT = `You generate OData v4 queries for the Northwind database.
Output ONLY a single JSON object. No explanation. No markdown.

Entities and their fields:
Products: ProductName, UnitPrice, UnitsInStock, UnitsOnOrder, ReorderLevel, Discontinued, QuantityPerUnit, CategoryID, SupplierID
Categories: CategoryName, Description
Customers: CompanyName, ContactName, ContactTitle, City, Region, Country, Phone, PostalCode
Orders: CustomerID, EmployeeID, OrderDate, RequiredDate, ShippedDate, Freight, ShipName, ShipCity, ShipCountry
Employees: FirstName, LastName, Title, City, Country, HireDate, BirthDate, ReportsTo
Suppliers: CompanyName, ContactName, City, Country, Phone
Order_Details: OrderID, ProductID, UnitPrice, Quantity, Discount

OData v4 filter rules:
  string:  Field eq 'Value'   OR   contains(Field,'Value')   OR   startswith(Field,'Value')
  number:  Field lt 20        OR   Field ge 100
  bool:    Field eq true      OR   Field eq false
  combine: (expr1) and (expr2)   OR   (expr1) or (expr2)

Output JSON: {"entity":"<EntityName>","filter":"<filter or empty>","orderby":"<field asc|desc or empty>","top":<number 5-50>}

Examples:
User: products cheaper than $15
{"entity":"Products","filter":"UnitPrice lt 15","orderby":"UnitPrice asc","top":20}

User: customers from Germany or France
{"entity":"Customers","filter":"Country eq 'Germany' or Country eq 'France'","orderby":"CompanyName asc","top":20}

User: discontinued products
{"entity":"Products","filter":"Discontinued eq true","orderby":"ProductName asc","top":20}

User: most expensive products
{"entity":"Products","filter":"","orderby":"UnitPrice desc","top":10}

User: employees from USA
{"entity":"Employees","filter":"Country eq 'USA'","orderby":"LastName asc","top":20}

User: recent orders to France
{"entity":"Orders","filter":"ShipCountry eq 'France'","orderby":"OrderDate desc","top":20}

User: all categories
{"entity":"Categories","filter":"","orderby":"CategoryName asc","top":20}

User: suppliers from UK
{"entity":"Suppliers","filter":"Country eq 'UK'","orderby":"CompanyName asc","top":20}

User: low stock products
{"entity":"Products","filter":"UnitsInStock lt 10","orderby":"UnitsInStock asc","top":20}

Output ONLY the JSON object.`;
