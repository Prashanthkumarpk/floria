/**
 * Loading and validation of BENCHMARK/gold/gold_queries.json against the
 * BENCHMARK_QUERIES literal in Chat.controller.ts, so the two cannot drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const GOLD_PATH = join(ROOT, "BENCHMARK/gold/gold_queries.json");
export const RUNS_DIR = join(ROOT, "BENCHMARK/runs");
export const OUT_DIR = join(ROOT, "BENCHMARK/exact_match");
const CONTROLLER = join(ROOT, "webapp/controller/Chat.controller.ts");

/** Mirror of SCHEMA in webapp/util/QueryValidator.ts. Keep in sync if the schema changes. */
export const SCHEMA = {
  Products: ["ProductID", "ProductName", "QuantityPerUnit", "UnitPrice", "UnitsInStock", "UnitsOnOrder", "ReorderLevel", "Discontinued", "CategoryID", "SupplierID"],
  Categories: ["CategoryID", "CategoryName", "Description"],
  Customers: ["CustomerID", "CompanyName", "ContactName", "ContactTitle", "Address", "City", "Region", "PostalCode", "Country", "Phone", "Fax"],
  Orders: ["OrderID", "CustomerID", "EmployeeID", "OrderDate", "RequiredDate", "ShippedDate", "ShipVia", "Freight", "ShipName", "ShipAddress", "ShipCity", "ShipRegion", "ShipPostalCode", "ShipCountry"],
  Employees: ["EmployeeID", "LastName", "FirstName", "Title", "TitleOfCourtesy", "BirthDate", "HireDate", "Address", "City", "Region", "PostalCode", "Country", "HomePhone", "Extension", "Notes", "ReportsTo"],
  Suppliers: ["SupplierID", "CompanyName", "ContactName", "ContactTitle", "Address", "City", "Region", "PostalCode", "Country", "Phone", "Fax", "HomePage"],
  Order_Details: ["OrderID", "ProductID", "UnitPrice", "Quantity", "Discount"],
};

const ODATA_KEYWORDS = new Set([
  "and", "or", "not", "eq", "ne", "lt", "gt", "le", "ge", "true", "false", "null",
  "contains", "startswith", "endswith", "tolower", "toupper", "length", "indexof", "substring",
  "year", "month", "day", "hour", "minute", "second", "now", "add", "sub", "mul", "div", "mod",
]);

export function loadGold() {
  const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8"));
  if (!Array.isArray(gold.entries)) throw new Error("gold_queries.json: missing entries[]");
  return gold;
}

/** Parse the BENCHMARK_QUERIES array literal straight out of the controller source. */
export function loadBenchmarkQueries() {
  const src = readFileSync(CONTROLLER, "utf8");
  const block = src.match(/const BENCHMARK_QUERIES[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("BENCHMARK_QUERIES not found in Chat.controller.ts");
  const re = /\{\s*query:\s*"((?:[^"\\]|\\.)*)",\s*expectedEntity:\s*"([^"]+)",\s*type:\s*"(T\d)"\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(block[1]))) out.push({ query: m[1], expectedEntity: m[2], type: m[3] });
  return out;
}

/** Field-name references in a filter, mirroring QueryValidator.extractFieldRefs. */
export function fieldRefs(filter) {
  const stripped = String(filter ?? "").replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set();
  for (const m of stripped.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const tok = m[1];
    if (!ODATA_KEYWORDS.has(tok.toLowerCase()) && /^[A-Z]/.test(tok)) found.add(tok);
  }
  return [...found];
}

/** Returns a list of human-readable problems; empty means the gold file is consistent. */
export function validateGold(gold, bench) {
  const errors = [];
  if (bench.length !== 100) errors.push(`controller: expected 100 BENCHMARK_QUERIES, found ${bench.length}`);
  if (gold.entries.length !== 100) errors.push(`gold: expected 100 entries, found ${gold.entries.length}`);

  const n = Math.min(gold.entries.length, bench.length);
  for (let i = 0; i < n; i++) {
    const g = gold.entries[i], b = bench[i], tag = `gold[${i}] (idx ${g.idx})`;
    if (g.idx !== i + 1) errors.push(`${tag}: idx should be ${i + 1}`);
    if (g.query !== b.query) errors.push(`${tag}: query "${g.query}" != controller "${b.query}"`);
    if (g.type !== b.type) errors.push(`${tag}: type ${g.type} != controller ${b.type}`);
    if (g.entity !== b.expectedEntity) errors.push(`${tag}: entity ${g.entity} != controller ${b.expectedEntity}`);
    if (!SCHEMA[g.entity]) { errors.push(`${tag}: unknown entity ${g.entity}`); continue; }

    const filters = [g.filter, ...(g.alt ?? [])];
    if (g.type === "T1" && g.filter !== "") errors.push(`${tag}: T1 gold must have an empty filter`);
    if (g.type !== "T1" && !g.filter) errors.push(`${tag}: non-T1 gold must have a filter`);
    for (const f of filters) {
      for (const field of fieldRefs(f)) {
        if (!SCHEMA[g.entity].includes(field)) errors.push(`${tag}: field "${field}" not on ${g.entity} (in "${f}")`);
      }
    }
  }
  return errors;
}
