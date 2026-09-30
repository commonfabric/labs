import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

describe("qualified CFC metadata", () => {
  const policy = {
    type: "https://commonfabric.org/cfc/atom/Policy",
    policyRefKind: "module",
    moduleIdentity: "sha256:rules",
    symbol: "rules",
    policyDigest: expect.any(String),
    subject: { __ctOwningSpace: true },
  };

  for (
    const [spelling, imports, choice, binding, expectedChoice, expectedPolicy]
      of [
        [
          "the main library namespace",
          'import * as cf from "commonfabric";',
          "cf.AnyOf",
          "cf.PolicyOf",
          { anyOf: ["reader"] },
          policy,
        ],
        [
          "the companion library namespace",
          'import * as cf from "commonfabric/cfc";',
          "cf.AnyOf",
          "cf.PolicyOf",
          { anyOf: ["reader"] },
          policy,
        ],
        [
          "renamed library re-exports",
          'import * as cf from "./barrel.ts";',
          "cf.Choice",
          "cf.Policy",
          { anyOf: ["reader"] },
          policy,
        ],
        [
          "a re-exported library namespace",
          'import * as outer from "./namespace.ts";',
          "outer.cf.AnyOf",
          "outer.cf.PolicyOf",
          { anyOf: ["reader"] },
          policy,
        ],
        [
          "authored names beside library re-exports",
          'import * as other from "./other.ts";',
          "other.AnyOf",
          "other.PolicyOf",
          { label: "ordinary choice" },
          { label: "ordinary policy" },
        ],
      ] as const
  ) {
    it(`reads metadata from ${spelling}`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      const files = await transformFiles({
        "/rules.ts": `/// <cts-enable />
import { cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v } from "commonfabric/cfc";
export const release = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
  post: { addAlternatives: [cfcPattern.user(v("user"))] },
});
export const rules = exchangeRules([release]);`,
        "/barrel.ts":
          'export type { AnyOf as Choice, PolicyOf as Policy } from "commonfabric/cfc";',
        "/namespace.ts": 'export * as cf from "commonfabric/cfc";',
        "/other.ts":
          `export type { PolicyOf as RealPolicy } from "commonfabric/cfc";
export type AnyOf<T> = { label: "ordinary choice" };
export type PolicyOf<T> = { label: "ordinary policy" };`,
        "/main.tsx": `/// <cts-enable />
import { Cfc, pattern } from "commonfabric";
import { rules } from "./rules.ts";
${imports}
export default pattern<{
  either: Cfc<string, { confidentiality: [${choice}<["reader"]>] }>;
  controlled: Cfc<string, { confidentiality: [${binding}<typeof rules>] }>;
}>(({ either, controlled }) => ({ either, controlled }));`,
      }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        moduleIdentities: new Map([["/rules.ts", "sha256:rules"]]),
        pipelineDiagnostics: diagnostics,
      });
      expect(diagnostics.filter((entry) => entry.severity === "error"))
        .toEqual([]);
      const { input, output } = patternSchemas(parseModule(files["/main.tsx"]));
      const expected = {
        properties: {
          either: {
            type: "string",
            ifc: { confidentiality: [expectedChoice] },
          },
          controlled: {
            type: "string",
            ifc: { confidentiality: [expectedPolicy] },
          },
        },
      };
      expect(input).toMatchObject(expected);
      expect(output).toMatchObject(expected);
    });
  }
});
