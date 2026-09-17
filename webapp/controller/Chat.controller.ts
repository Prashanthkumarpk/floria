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
import QueryValidator from "../util/QueryValidator";

interface ColDef {
  key: string;
  label: string;
  width: string;
  numeric?: boolean;
}

const ENTITY_COLS: Record<string, ColDef[]> = {
  Products: [
    { key: "ProductName",    label: "Product Name",   width: "30%"  },
    { key: "UnitPrice",      label: "Unit Price ($)",  width: "13%",  numeric: true },
    { key: "UnitsInStock",   label: "In Stock",        width: "11%",  numeric: true },
    { key: "QuantityPerUnit",label: "Pack Size",       width: "22%"  },
    { key: "Discontinued",   label: "Status",          width: "14%"  },
  ],
  Categories: [
    { key: "CategoryName",   label: "Category",       width: "25%"  },
    { key: "Description",    label: "Description",    width: "75%"  },
  ],
  Customers: [
    { key: "CompanyName",    label: "Company",        width: "28%"  },
    { key: "ContactName",    label: "Contact",        width: "20%"  },
    { key: "ContactTitle",   label: "Role",           width: "20%"  },
    { key: "City",           label: "City",           width: "15%"  },
    { key: "Country",        label: "Country",        width: "13%"  },
  ],
  Orders: [
    { key: "OrderID",        label: "Order #",        width: "10%",  numeric: true },
    { key: "CustomerID",     label: "Customer",       width: "13%"  },
    { key: "OrderDate",      label: "Order Date",     width: "20%"  },
    { key: "ShipCity",       label: "Ship To",        width: "17%"  },
    { key: "ShipCountry",    label: "Country",        width: "14%"  },
    { key: "Freight",        label: "Freight ($)",    width: "14%",  numeric: true },
  ],
  Employees: [
    { key: "FirstName",      label: "First Name",     width: "18%"  },
    { key: "LastName",       label: "Last Name",      width: "18%"  },
    { key: "Title",          label: "Title",          width: "28%"  },
    { key: "City",           label: "City",           width: "18%"  },
    { key: "Country",        label: "Country",        width: "18%"  },
  ],
  Suppliers: [
    { key: "CompanyName",    label: "Company",        width: "30%"  },
    { key: "ContactName",    label: "Contact",        width: "22%"  },
    { key: "City",           label: "City",           width: "20%"  },
    { key: "Country",        label: "Country",        width: "18%"  },
    { key: "Phone",          label: "Phone",          width: "10%"  },
  ],
  Order_Details: [
    { key: "OrderID",        label: "Order #",        width: "14%",  numeric: true },
    { key: "ProductID",      label: "Product #",      width: "14%",  numeric: true },
    { key: "UnitPrice",      label: "Unit Price",     width: "18%",  numeric: true },
    { key: "Quantity",       label: "Qty",            width: "14%",  numeric: true },
    { key: "Discount",       label: "Discount",       width: "14%",  numeric: true },
  ],
};

// Direct-mode filters when LLM is not available
const DIRECT_FILTERS: Record<string, (q: string) => string> = {
  Products:     q => `contains(ProductName,'${q.replace(/'/g, "''")}')`,
  Categories:   q => `contains(CategoryName,'${q.replace(/'/g, "''")}')`,
  Customers:    q => `contains(CompanyName,'${q.replace(/'/g, "''")}') or contains(ContactName,'${q.replace(/'/g, "''")}')`,
  Orders:       q => `contains(ShipCountry,'${q.replace(/'/g, "''")}') or contains(ShipCity,'${q.replace(/'/g, "''")}')`,
  Employees:    q => `contains(LastName,'${q.replace(/'/g, "''")}') or contains(FirstName,'${q.replace(/'/g, "''")}')`,
  Suppliers:    q => `contains(CompanyName,'${q.replace(/'/g, "''")}')`,
  Order_Details:q => ``,
};

/**
 * @namespace research.chat.controller
 */
export default class ChatController extends Controller {
  private model!: JSONModel;
  private llmService!: WebLLMService;
  private queryBuilder!: ODataQueryBuilder;
  private queryValidator!: QueryValidator;
  private readonly ODATA_BASE = "http://localhost:4004/odata";

  public onInit(): void {
    this.model = new JSONModel({
      query: "",
      selectedEntity: "Products",
      hasResults: false,
      noResults: false,
      loading: false,
      results: [] as Record<string, unknown>[],
      resultEntity: "",
      countLabel: "",
      oDataQuery: { url: "", entity: "", filter: "", orderby: "", top: "" },
      validation: { state: "None", text: "", errors: [] as string[] },
      llm: {
        ready: false,
        loading: false,
        progress: 0,
        progressLabel: "",
        loadingText: "",
        statusText: "Direct Search",
        statusState: "Information",
        statusIcon: "sap-icon://search"
      },
      error: ""
    });
    this.getView()?.setModel(this.model);

    this.llmService    = new WebLLMService();
    this.queryBuilder  = new ODataQueryBuilder();
    this.queryValidator = new QueryValidator();

    if (WebLLMService.isWebGPUAvailable()) {
      void this.initLLM();
    }
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

    const llmReady        = this.model.getProperty("/llm/ready") as boolean;
    const selectedEntity  = this.model.getProperty("/selectedEntity") as string;

    try {
      // ── Step 1: Generate query plan ──
      let plan: QueryPlan;
      if (llmReady) {
        plan = await this.llmService.generateQueryPlan(text);
        // If user pre-selected an entity, respect it
        if (selectedEntity && selectedEntity !== "All") plan.entity = selectedEntity;
      } else {
        const entity = selectedEntity !== "All" ? selectedEntity : "Products";
        plan = {
          entity,
          filter: (DIRECT_FILTERS[entity] ?? DIRECT_FILTERS.Products)(text),
          orderby: "",
          top: 20
        };
      }

      // ── Step 2: Validate ──
      const vr = this.queryValidator.validate(plan);
      this.model.setProperty("/validation/state", vr.statusState);
      this.model.setProperty("/validation/text",  vr.statusText);
      this.model.setProperty("/validation/errors", vr.fieldErrors);

      // Build URL regardless of validation (let server return the real OData error if needed)
      const url = this.queryBuilder.build(plan, this.ODATA_BASE);

      this.model.setProperty("/oDataQuery/url",     url);
      this.model.setProperty("/oDataQuery/entity",  plan.entity);
      this.model.setProperty("/oDataQuery/filter",  plan.filter  ?? "");
      this.model.setProperty("/oDataQuery/orderby", plan.orderby ?? "");
      this.model.setProperty("/oDataQuery/top",     String(plan.top ?? 20));

      // ── Step 3: Execute ──
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `OData error ${res.status}`);
      }

      const data = await res.json() as { value: Record<string, unknown>[]; "@odata.count"?: number };
      const results = data.value ?? [];
      const total   = data["@odata.count"] ?? results.length;

      this.model.setProperty("/loading", false);

      if (results.length === 0) {
        this.model.setProperty("/noResults", true);
      } else {
        this.model.setProperty("/results",    results);
        this.model.setProperty("/countLabel", `${total.toLocaleString()} ${plan.entity} — showing ${results.length}`);
        this.model.setProperty("/resultEntity", plan.entity);
        this.model.setProperty("/hasResults",   true);
        this.refreshResultTable(plan.entity);
      }
    } catch (err) {
      this.model.setProperty("/loading", false);
      this.model.setProperty("/error", (err as Error).message);
    }
  }

  // ── Rebuild the table columns + template for the detected entity ──
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

  // ─── Entity selector ───────────────────────────────────────────────────────

  public onEntitySelect(): void {
    // triggers binding refresh for the selected entity badge in the view
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

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
