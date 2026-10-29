import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  THIS_POLICY,
  v,
} from "@commonfabric/api/cfc-authoring";

Deno.test("CFC exchange-rule authoring helpers produce inert declaration data", () => {
  const principal = v("principal");
  const role = v("role");
  const requiredRole = cfcPattern.hasRole(
    principal,
    THIS_POLICY.subject,
    role,
  );
  const audience = cfcPattern.user(principal);
  const rule = exchangeRule({
    appliesTo: THIS_POLICY,
    pre: { integrity: [requiredRole] },
    post: { addAlternatives: [audience] },
  });
  const rules = exchangeRules([rule]);

  assertEquals(principal, { var: "principal" });
  assertEquals(requiredRole, {
    type: "https://commonfabric.org/cfc/atom/HasRole",
    principal: { var: "principal" },
    space: { thisPolicyField: "subject" },
    role: { var: "role" },
  });
  assertEquals(audience, {
    type: "https://commonfabric.org/cfc/atom/User",
    subject: { var: "principal" },
  });
  assertEquals(Object.keys(THIS_POLICY), ["thisPolicy"]);
  assertEquals({ ...THIS_POLICY }, { thisPolicy: true });
  assertEquals(THIS_POLICY.subject, { thisPolicyField: "subject" });
  assertEquals(THIS_POLICY.moduleIdentity, {
    thisPolicyField: "moduleIdentity",
  });
  assertStrictEquals(rules[0], rule);
  assertNotStrictEquals(rules, [rule]);
});

Deno.test("CFC exchange-rule declarations are deeply frozen", () => {
  const rule = exchangeRule({
    appliesTo: THIS_POLICY,
    guard: { policyState: [{ enabled: true }] },
    post: { dropClause: true },
  });
  const rules = exchangeRules([rule]);

  assertEquals(Object.isFrozen(THIS_POLICY), true);
  assertEquals(Object.isFrozen(THIS_POLICY.subject), true);
  assertEquals(Object.isFrozen(THIS_POLICY.moduleIdentity), true);
  assertEquals(Object.isFrozen(rule), true);
  assertEquals(Object.isFrozen(rule.guard), true);
  assertEquals(Object.isFrozen(rule.guard?.policyState), true);
  assertEquals(Object.isFrozen(rule.guard?.policyState?.[0]), true);
  assertEquals(Object.isFrozen(rules), true);
  assertThrows(() => {
    (rule.guard!.policyState[0] as { enabled: boolean }).enabled = false;
  }, TypeError);
});

Deno.test("CFC pattern variables require a non-empty identifier", () => {
  assertThrows(() => v(""), TypeError, "non-empty");
});
