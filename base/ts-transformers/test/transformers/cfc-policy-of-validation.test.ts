import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { validateSource } from "../utils.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

/**
 * The message of each `cfc-policy-of` diagnostic reported for a module that
 * imports `imports`, declares `rules` from `release`, and names
 * `PolicyOf<typeof rules>` in a schema.
 */
async function policyOfMessages(imports: string, rules: string) {
  const { diagnostics } = await validateSource(
    `/// <cts-enable />
import { Confidential, toSchema } from "commonfabric";
import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
${imports}
export const release = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [{ kind: "evidence" }] },
  post: { dropClause: true },
});
export const rules = ${rules};
export const schema = toSchema<
  Confidential<string, [PolicyOf<typeof rules>]>
>();
`,
    {
      types: COMMONFABRIC_TYPES,
      moduleIdentities: new Map([["/test.tsx", "sha256:policy-module"]]),
    },
  );
  return diagnostics
    .filter((diagnostic) => diagnostic.type === "cfc-policy-of")
    .map((diagnostic) => diagnostic.message);
}

describe("cfc-policy-of-validation", () => {
  const namedPolicyOf = `import type { PolicyOf } from "commonfabric/cfc";
import * as cfc from "commonfabric/cfc";`;

  it("reports nothing for a binding an imported `exchangeRules()` call declares", async () => {
    expect(await policyOfMessages(namedPolicyOf, "exchangeRules([release])"))
      .toEqual([]);
  });

  it("reports a binding declared by `exchangeRules()` read off a namespace", async () => {
    expect(
      await policyOfMessages(namedPolicyOf, "cfc.exchangeRules([release])"),
    ).toContain(
      "PolicyOf binding must resolve to an exchangeRules() declaration.",
    );
  });

  it("reports nothing for a `PolicyOf` that is not a named import", async () => {
    expect(
      await policyOfMessages(
        `import PolicyOf from "commonfabric/cfc";
import * as cfc from "commonfabric/cfc";`,
        "cfc.exchangeRules([release])",
      ),
    ).toEqual([]);
  });
});
