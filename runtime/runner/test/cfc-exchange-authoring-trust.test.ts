import { assertEquals } from "@std/assert";
import {
  exchangeRule,
  exchangeRules,
  THIS_POLICY,
} from "@commonfabric/api/cfc-authoring";
import { isTrustedBuilderArtifact } from "../src/builder/pattern-metadata.ts";

Deno.test("exchange-rule authoring declarations never acquire builder trust", () => {
  const rule = exchangeRule({
    appliesTo: THIS_POLICY,
    guard: { policyState: [{ enabled: true }] },
    post: { dropClause: true },
  });
  const rules = exchangeRules([rule]);

  assertEquals(isTrustedBuilderArtifact(rule), false);
  assertEquals(isTrustedBuilderArtifact(rules), false);
});
