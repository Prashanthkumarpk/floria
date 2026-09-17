import { QueryPlan } from "./WebLLMService";
import { ENTITIES } from "./QueryValidator";

const INJECT = /[;]|--|\/\*|<script/i;

/**
 * @namespace research.chat.util
 */
export default class ODataQueryBuilder {

  public build(plan: QueryPlan, baseUrl: string): string {
    if (!ENTITIES.includes(plan.entity)) {
      throw new Error(`Unknown entity: ${plan.entity}`);
    }

    const url = new URL(`${baseUrl}/${plan.entity}`);
    url.searchParams.set("$count", "true");

    if (plan.filter) {
      if (INJECT.test(plan.filter)) throw new Error("Rejected: unsafe filter content.");
      url.searchParams.set("$filter", plan.filter);
    }

    const top = Math.min(Math.max(1, plan.top ?? 20), 50);
    url.searchParams.set("$top", String(top));

    if (plan.orderby) {
      const parts = plan.orderby.trim().split(/\s+/);
      const dir = parts[1]?.toLowerCase() ?? "asc";
      if (!["asc", "desc"].includes(dir)) throw new Error(`Invalid sort direction: ${dir}`);
      url.searchParams.set("$orderby", plan.orderby.trim());
    }

    return url.toString();
  }
}
