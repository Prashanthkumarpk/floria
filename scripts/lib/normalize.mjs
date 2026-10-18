/**
 * Canonicalisation of OData v4 $filter expressions for exact-match scoring.
 *
 * Two filters are treated as equivalent when they differ only in:
 *   - letter case (the Northwind service compares strings case-insensitively),
 *   - quote style (" vs '),
 *   - whitespace, including spacing around ( ) and ,
 *   - redundant parentheses around atomic comparisons,
 *   - operand order when every connector at a level is the same (A or B == B or A),
 *   - numeric literal spelling (15.0 == 15, 0.20 == 0.2).
 * Mixed and/or at one level is NOT reordered; gold files cover those via `alt`.
 *
 * webapp/util/ExactMatch.ts is a TypeScript twin used for the live in-app EM column.
 * Keep both in step; scripts/check-normalizer-parity.mjs verifies they agree.
 */

export function normalizeEntity(e) {
  return String(e ?? "").trim().toLowerCase();
}

/** Apply fn to every stretch of text outside single-quoted string literals. */
export function mapOutsideQuotes(s, fn) {
  let out = "", buf = "", inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inQuote) {
      if (ch === "'") { out += fn(buf); buf = ""; out += ch; inQuote = true; }
      else buf += ch;
    } else {
      out += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") { out += "'"; i++; }   // escaped quote ''
        else inQuote = false;
      }
    }
  }
  return out + fn(buf);
}

/** Split on top-level " and " / " or ", respecting parentheses and quoted strings. */
export function splitTopLevel(s) {
  const operands = [], connectors = [];
  let depth = 0, inQuote = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      cur += ch;
      if (ch === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else inQuote = false; }
      continue;
    }
    if (ch === "'") { inQuote = true; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && ch === " ") {
      const m = s.slice(i).match(/^ (and|or) /);
      if (m) { operands.push(cur); connectors.push(m[1]); cur = ""; i += m[0].length - 1; continue; }
    }
    cur += ch;
  }
  operands.push(cur);
  return { operands, connectors };
}

function wrappedInParens(s) {
  if (!s.startsWith("(") || !s.endsWith(")")) return false;
  let depth = 0, inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) { if (ch === "'") inQuote = false; continue; }
    if (ch === "'") { inQuote = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0 && i < s.length - 1) return false; }
  }
  return depth === 0;
}

export function stripOuterParens(s) {
  let t = s.trim();
  while (wrappedInParens(t)) t = t.slice(1, -1).trim();
  return t;
}

const canonNumbers = (s) => mapOutsideQuotes(s, seg => seg.replace(/\b\d+\.\d+\b/g, n => String(Number(n))));

function canonExpr(s) {
  s = stripOuterParens(s.trim());
  const { operands, connectors } = splitTopLevel(s);
  if (connectors.length === 0) return { text: canonNumbers(s), mixed: false };
  let mixed = new Set(connectors).size > 1;
  const parts = operands.map(op => {
    const inner = stripOuterParens(op.trim());
    if (splitTopLevel(inner).connectors.length === 0) return canonNumbers(inner);
    const r = canonExpr(inner);
    mixed = mixed || r.mixed;
    return `(${r.text})`;
  });
  if (!mixed) parts.sort();
  return { text: parts.join(` ${connectors[0]} `), mixed };
}

/** Returns { normalized, mixedConnectors }. Empty / null input normalizes to "". */
export function normalizeFilter(input) {
  let s = String(input ?? "").trim();
  if (!s) return { normalized: "", mixedConnectors: false };
  s = s.toLowerCase().replace(/"/g, "'");
  // Trim whitespace inside parens, around commas, and between a function name and its "(",
  // but keep the space before "(" / after ")" that separates a group from an and/or connector.
  s = mapOutsideQuotes(s, seg => seg
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .replace(/\b(?!and\b|or\b|not\b)([a-z_]\w*)\s+\(/g, "$1(")
  ).trim();
  const r = canonExpr(s);
  return { normalized: r.text, mixedConnectors: r.mixed };
}

export function normalizeOrderby(s) {
  const t = String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return "";
  return / (asc|desc)$/.test(t) ? t : `${t} asc`;
}

/** Pull entity + query options back out of a URL built by ODataQueryBuilder. */
export function extractFromUrl(url) {
  const u = new URL(url);
  const segs = u.pathname.split("/").filter(Boolean);
  return {
    entity:  segs[segs.length - 1] ?? "",
    filter:  u.searchParams.get("$filter") ?? "",
    top:     u.searchParams.get("$top"),
    orderby: u.searchParams.get("$orderby") ?? "",
  };
}
