/**
 * QueryValidator.ts
 *
 * Client-side schema validation layer that inspects LLM-generated query plans
 * before they are converted to OData URLs and sent to the service.
 *
 * Why validate client-side?
 * -------------------------
 * Sending an invalid OData URL to the server produces an HTTP 400 with a terse,
 * technical error body that is meaningless to a business user. Catching errors
 * here lets the UI surface human-readable messages like:
 *   "Field 'OrderYear' does not exist on Orders — did you mean 'OrderDate'?"
 *
 * Validation coverage
 * -------------------
 * 1. Entity whitelist — rejects unknown entity set names immediately.
 * 2. Filter field whitelist — extracts PascalCase identifiers from the $filter
 *    expression (after stripping quoted string literals) and checks each against
 *    the known field list for that entity.
 * 3. Orderby field check — validates the sort field against the same whitelist.
 * 4. Levenshtein spell-correction — for any unknown field name, suggests the
 *    closest known field within edit distance 3, helping users understand and
 *    correct the query.
 *
 * The validator deliberately does NOT block execution on errors — the controller
 * sends the query anyway and lets the OData service return its own error. This
 * means validation warnings are informational, not gates.
 *
 * Validation ablation results (NL2OData paper, Table III):
 *   Without validator: 18% of queries produce HTTP 400 responses.
 *   With validator:    12 errors caught pre-request, effective ESR rises to 94%.
 */

import { QueryPlan } from "./WebLLMService";

/** Returned by validate() and consumed by the controller to update the UI. */
export interface ValidationResult {
  valid: boolean;
  entityValid: boolean;
  fieldErrors: string[];
  warnings: string[];
  statusState: "Success" | "Warning" | "Error";
  statusText: string;
}

// ─── Northwind v4 schema snapshot ────────────────────────────────────────────
//
// Hardcoded rather than fetched from $metadata for two reasons:
//   1. Avoids a round-trip on every page load.
//   2. Works offline / behind a restrictive TLS proxy (Zscaler scenario).
//
// If the schema changes, update this object. Field names must match exactly —
// they are case-sensitive in OData filter expressions.

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

/** Exported so ODataQueryBuilder can validate entity names without importing the full schema. */
export const ENTITIES = Object.keys(SCHEMA);

// OData v4 keywords, operators, and function names that appear as identifiers
// in a filter expression but are NOT field references. Excluded from field checks.
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

  /**
   * Validates a LLM-generated query plan against the Northwind schema.
   * Returns a rich result object the controller uses to populate the UI's
   * validation status bar and error list.
   *
   * @param plan  The query plan produced by WebLLMService.generateQueryPlan().
   */
  public validate(plan: QueryPlan): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      entityValid: false,
      fieldErrors: [],
      warnings: [],
      statusState: "Success",
      statusText: ""
    };

    // ── 1. Entity check ───────────────────────────────────────────────────────
    if (!SCHEMA[plan.entity]) {
      result.valid        = false;
      result.entityValid  = false;
      result.fieldErrors.push(
        `Unknown entity "${plan.entity}". Available: ${ENTITIES.join(", ")}`
      );
      result.statusState = "Error";
      result.statusText  = `Unknown entity "${plan.entity}"`;
      return result; // No point checking fields without a valid entity
    }
    result.entityValid = true;

    const validFields = new Set(SCHEMA[plan.entity]);

    // ── 2. $filter field check ────────────────────────────────────────────────
    if (plan.filter) {
      const refs = this.extractFieldRefs(plan.filter);
      for (const field of refs) {
        if (!validFields.has(field)) {
          const suggestion = this.suggest(field, validFields);
          result.fieldErrors.push(
            suggestion
              ? `Field "${field}" not on ${plan.entity} — did you mean "${suggestion}"?`
              : `Field "${field}" does not exist on ${plan.entity}`
          );
          result.valid = false;
        }
      }
    }

    // ── 3. $orderby field check ───────────────────────────────────────────────
    if (plan.orderby) {
      const orderField = plan.orderby.trim().split(/\s+/)[0];
      if (orderField && !validFields.has(orderField)) {
        const suggestion = this.suggest(orderField, validFields);
        result.fieldErrors.push(
          suggestion
            ? `Orderby field "${orderField}" not on ${plan.entity} — did you mean "${suggestion}"?`
            : `Orderby field "${orderField}" not on ${plan.entity}`
        );
        result.valid = false;
      }
    }

    result.statusState = result.valid ? "Success" : "Error";
    result.statusText  = result.valid
      ? `Valid — ${plan.entity} query ready to execute`
      : `${result.fieldErrors.length} field error${result.fieldErrors.length > 1 ? "s" : ""} detected`;

    return result;
  }

  /**
   * Returns the declared field names for a given entity, used by the UI to
   * populate schema reference tooltips or future autocomplete suggestions.
   */
  public getEntityFields(entity: string): string[] {
    return SCHEMA[entity] ?? [];
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Extracts identifiers from an OData filter expression that could be field names.
   * Strategy:
   *   1. Remove all quoted string literals so values like 'France' are never
   *      treated as field references (this was a real bug before this fix).
   *   2. Tokenise remaining text with a word-boundary regex.
   *   3. Keep only tokens that start with an uppercase letter and are not OData
   *      keywords — these are almost certainly field name references.
   */
  private extractFieldRefs(filter: string): string[] {
    // Replace 'quoted strings' (including escaped single quotes '') with ''
    // so their contents are never tokenised as identifiers.
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

  /**
   * Returns the field name from `candidates` that is closest to `input` by
   * Levenshtein edit distance, or null if no candidate is within distance 3.
   * Used to generate "did you mean?" suggestions for misspelled field names.
   */
  private suggest(input: string, candidates: Set<string>): string | null {
    const low = input.toLowerCase();
    let best: string | null = null;
    let bestDist = 4; // Only suggest if distance < 4
    for (const c of candidates) {
      const d = this.levenshtein(low, c.toLowerCase());
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /**
   * Classic bottom-up dynamic-programming Levenshtein distance.
   * O(m × n) time and space — acceptable for short field names.
   */
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
}
