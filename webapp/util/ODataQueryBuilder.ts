/**
 * ODataQueryBuilder.ts
 *
 * Converts a structured QueryPlan (produced by the LLM or the direct-mode
 * keyword fallback) into a fully formed OData v4 request URL.
 *
 * Responsibilities
 * ----------------
 * - Entity whitelist check (guards against LLM hallucinating non-existent sets).
 * - Injection guard — rejects filter expressions that contain SQL comment
 *   sequences (--), statement terminators (;), or <script tags. OData gateways
 *   on conformant servers cannot execute injected code, but SAP Gateway
 *   implementations vary, so we guard defensively.
 * - $top clamping — enforces the [1, 50] range regardless of what the model
 *   outputs. This prevents the model from requesting the entire dataset.
 * - $orderby direction validation — only "asc" or "desc" are accepted.
 * - $count=true is always appended so the UI can show the total record count
 *   ("77 records · showing 20") even when $top limits the returned rows.
 */

import { QueryPlan } from "./WebLLMService";
import { ENTITIES } from "./QueryValidator";

// Regex that matches characters/sequences commonly used in injection attacks.
// This is a defence-in-depth measure; the OData protocol itself does not
// allow SQL execution, but belt-and-suspenders is appropriate here.
const INJECT = /[;]|--|\/\*|<script/i;

/**
 * @namespace research.chat.util
 */
export default class ODataQueryBuilder {

  /**
   * Builds a complete OData v4 request URL from a validated query plan.
   *
   * Example output:
   *   http://localhost:4004/odata/Products?
   *     $count=true&$filter=UnitPrice+lt+15&$top=20&$orderby=UnitPrice+asc
   *
   * @param plan     Structured query plan from WebLLMService or direct-mode fallback.
   * @param baseUrl  Proxy base URL, e.g. "http://localhost:4004/odata".
   * @throws If the entity is unknown, the filter contains injection patterns,
   *         or the sort direction is not "asc" / "desc".
   */
  public build(plan: QueryPlan, baseUrl: string): string {
    if (!ENTITIES.includes(plan.entity)) {
      throw new Error(`Unknown entity: ${plan.entity}`);
    }

    const url = new URL(`${baseUrl}/${plan.entity}`);

    // Always request the total count; the UI uses it for "N records · showing M"
    url.searchParams.set("$count", "true");

    if (plan.filter) {
      if (INJECT.test(plan.filter)) {
        throw new Error("Rejected: unsafe filter content.");
      }
      url.searchParams.set("$filter", plan.filter);
    }

    // Clamp $top to a safe range. The model occasionally outputs 0 or very large
    // numbers, both of which produce bad UX or excessive server load.
    const top = Math.min(Math.max(1, plan.top ?? 20), 50);
    url.searchParams.set("$top", String(top));

    if (plan.orderby) {
      const parts = plan.orderby.trim().split(/\s+/);
      const dir   = parts[1]?.toLowerCase() ?? "asc";
      if (!["asc", "desc"].includes(dir)) {
        throw new Error(`Invalid sort direction: ${dir}`);
      }
      url.searchParams.set("$orderby", plan.orderby.trim());
    }

    return url.toString();
  }
}
