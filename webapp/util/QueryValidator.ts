import { QueryPlan } from "./WebLLMService";

export interface ValidationResult {
  valid: boolean;
  entityValid: boolean;
  fieldErrors: string[];
  warnings: string[];
  statusState: "Success" | "Warning" | "Error";
  statusText: string;
}

// Known fields per Northwind entity
const SCHEMA: Record<string, string[]> = {
  Products: [
    "ProductID", "ProductName", "QuantityPerUnit", "UnitPrice",
    "UnitsInStock", "UnitsOnOrder", "ReorderLevel", "Discontinued",
    "CategoryID", "SupplierID"
  ],
  Categories: ["CategoryID", "CategoryName", "Description"],
  Customers: [
    "CustomerID", "CompanyName", "ContactName", "ContactTitle",
    "Address", "City", "Region", "PostalCode", "Country", "Phone", "Fax"
  ],
  Orders: [
    "OrderID", "CustomerID", "EmployeeID", "OrderDate", "RequiredDate",
    "ShippedDate", "ShipVia", "Freight", "ShipName", "ShipAddress",
    "ShipCity", "ShipRegion", "ShipPostalCode", "ShipCountry"
  ],
  Employees: [
    "EmployeeID", "LastName", "FirstName", "Title", "TitleOfCourtesy",
    "BirthDate", "HireDate", "Address", "City", "Region", "PostalCode",
    "Country", "HomePhone", "Extension", "Notes", "ReportsTo"
  ],
  Suppliers: [
    "SupplierID", "CompanyName", "ContactName", "ContactTitle",
    "Address", "City", "Region", "PostalCode", "Country", "Phone", "Fax", "HomePage"
  ],
  Order_Details: ["OrderID", "ProductID", "UnitPrice", "Quantity", "Discount"],
};

export const ENTITIES = Object.keys(SCHEMA);

const ODATA_KEYWORDS = new Set([
  "and", "or", "not", "eq", "ne", "lt", "gt", "le", "ge",
  "true", "false", "null", "contains", "startswith", "endswith",
  "tolower", "toupper", "length", "indexof", "substring",
  "year", "month", "day", "hour", "minute", "second", "now",
  "add", "sub", "mul", "div", "mod"
]);

/**
 * @namespace research.chat.util
 */
export default class QueryValidator {

  public validate(plan: QueryPlan): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      entityValid: false,
      fieldErrors: [],
      warnings: [],
      statusState: "Success",
      statusText: ""
    };

    // 1. Entity check
    if (!SCHEMA[plan.entity]) {
      result.valid = false;
      result.entityValid = false;
      result.fieldErrors.push(
        `Unknown entity "${plan.entity}". Available: ${ENTITIES.join(", ")}`
      );
      result.statusState = "Error";
      result.statusText = `Unknown entity "${plan.entity}"`;
      return result;
    }
    result.entityValid = true;

    const validFields = new Set(SCHEMA[plan.entity]);

    // 2. Filter field check
    if (plan.filter) {
      const refs = this.extractFieldRefs(plan.filter);
      for (const field of refs) {
        if (!validFields.has(field)) {
          const suggestion = this.suggest(field, validFields);
          const msg = suggestion
            ? `Field "${field}" not on ${plan.entity} — did you mean "${suggestion}"?`
            : `Field "${field}" does not exist on ${plan.entity}`;
          result.fieldErrors.push(msg);
          result.valid = false;
        }
      }
    }

    // 3. Orderby field check
    if (plan.orderby) {
      const orderField = plan.orderby.trim().split(/\s+/)[0];
      if (orderField && !validFields.has(orderField)) {
        const suggestion = this.suggest(orderField, validFields);
        const msg = suggestion
          ? `Orderby field "${orderField}" not on ${plan.entity} — did you mean "${suggestion}"?`
          : `Orderby field "${orderField}" not on ${plan.entity}`;
        result.fieldErrors.push(msg);
        result.valid = false;
      }
    }

    if (result.valid) {
      result.statusState = "Success";
      result.statusText = `Valid — ${plan.entity} query ready to execute`;
    } else {
      result.statusState = "Error";
      result.statusText = `${result.fieldErrors.length} field error${result.fieldErrors.length > 1 ? "s" : ""} detected`;
    }

    return result;
  }

  // Extract PascalCase/CamelCase identifiers from OData filter that look like field names.
  // Strip quoted string literals first so values like 'France' are never mistaken for fields.
  private extractFieldRefs(filter: string): string[] {
    const stripped = filter.replace(/'(?:[^']|'')*'/g, "''");
    const found: string[] = [];
    const tokenRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(stripped)) !== null) {
      const token = m[1];
      if (!ODATA_KEYWORDS.has(token.toLowerCase()) && /^[A-Z]/.test(token)) {
        found.push(token);
      }
    }
    return [...new Set(found)];
  }

  // Simple edit-distance suggestion (Levenshtein ≤ 3)
  private suggest(input: string, candidates: Set<string>): string | null {
    const low = input.toLowerCase();
    let best: string | null = null;
    let bestDist = 4;
    for (const c of candidates) {
      const d = this.levenshtein(low, c.toLowerCase());
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
  }

  public getEntityFields(entity: string): string[] {
    return SCHEMA[entity] ?? [];
  }
}
