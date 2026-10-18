/**
 * Guards against drift between the two normalizer implementations:
 *   scripts/lib/normalize.mjs  (offline scorer)
 *   webapp/util/ExactMatch.ts  (live in-app EM column)
 * Compiles the TS file to a temp dir with tsc, then feeds both the same inputs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeFilter as nodeNorm, normalizeEntity as nodeEnt } from "./lib/normalize.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "floria-em-"));
try {
  execFileSync("npx", ["tsc", join(root, "webapp/util/ExactMatch.ts"), "--outDir", out, "--module", "es2020", "--target", "es2020", "--moduleResolution", "node", "--skipLibCheck"], { stdio: "inherit" });
  const ts = await import(pathToFileURL(join(out, "ExactMatch.js")).href);

  const inputs = [
    "", "   ", "UnitPrice lt 15", "Country eq 'Germany' or Country eq 'France'", "Country eq 'France' or Country eq 'Germany'",
    "contains(ProductName, 'chai')", "(UnitPrice lt 15) and (UnitsInStock gt 0)", "Discount eq 0.0", "Country eq \"USA\"",
    "((Freight gt 100))", "(Country eq 'UK' or Country eq 'USA') and City eq 'London'", "A eq 1 and B eq 2 or C eq 3",
    "contains(ProductName,'a b')", "startswith(LastName, 'D')", "Discontinued eq true", "UnitsInStock ge 20 and UnitsInStock le 50",
    "contains(ProductName,'chai') or contains(ProductName,'tofu')", "Country eq 'O''Brien'", "ShipCity eq 'Berlin'",
  ];
  let failed = 0;
  for (const s of inputs) {
    const a = nodeNorm(s).normalized, b = ts.normalizeFilter(s);
    if (a !== b) { failed++; console.log(`✖  ${JSON.stringify(s)}\n     node: ${JSON.stringify(a)}\n     ts:   ${JSON.stringify(b)}`); }
  }
  for (const e of ["Products", " order_details ", "CUSTOMERS"]) {
    if (nodeEnt(e) !== ts.normalizeEntity(e)) { failed++; console.log(`✖  entity ${JSON.stringify(e)}`); }
  }
  console.log(failed ? `\n${failed} parity mismatch(es)` : `✅ normalizer parity: ${inputs.length} filters + 3 entities identical in node and TS`);
  process.exit(failed ? 1 : 0);
} finally {
  rmSync(out, { recursive: true, force: true });
}
