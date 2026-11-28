import { expect } from "@std/expect";
import { assert } from "@std/assert";
import ts from "typescript";

import {
  TransformationContext,
  type TransformationDiagnostic,
} from "../../src/core/mod.ts";
import {
  CfcPolicyAuthoringTransformer,
  compileCfcPolicyManifestsForSource,
} from "../../src/transformers/cfc-policy-authoring.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { literalToValue, parseModule } from "../transformed-ast.ts";
import { transformSource, validateSource } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const IMPORTS =
  `import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";`;

const OPTIONS = {
  types: COMMONFABRIC_TYPES,
  moduleIdentities: new Map([["/test.tsx", "sha256:policy"]]),
};

/** A rule declaration whose integrity evidence is `evidence`. */
function ruleDeclaration(evidence = `{ kind: "evidence" }`): string {
  return `export const release = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [${evidence}] },
  post: { dropClause: true },
});`;
}

describe("cfc-policy-authoring", () => {
  describe("compileCfcPolicyManifestsForSource()", () => {
    /** The manifests compiled for a module holding `body`. */
    function compile(body: string) {
      return compileCfcPolicyManifestsForSource(
        ts.createSourceFile(
          "/policy.ts",
          `${IMPORTS}\n${body}`,
          ts.ScriptTarget.ES2020,
          true,
        ),
        "sha256:policy",
      );
    }

    it("returns one manifest per `exchangeRules()` declaration", () => {
      expect(
        compile(`${ruleDeclaration()}
export const rules = exchangeRules([release]);`).map((artifact) =>
          artifact.manifest.symbol
        ),
      ).toEqual(["rules"]);
    });

    it("throws for an `exchangeRule()` with more than one argument", () => {
      expect(() =>
        compile(`export const release = exchangeRule({}, {});
export const rules = exchangeRules([release]);`)
      ).toThrow("exchangeRule() requires one argument");
    });

    it("throws for an `exchangeRules()` whose argument is not an array", () => {
      expect(() =>
        compile(`${ruleDeclaration()}
export const rules = exchangeRules(release);`)
      ).toThrow(
        "exchangeRules() requires one static array of exported rule identifiers",
      );
    });
  });

  describe("CfcPolicyAuthoringTransformer", () => {
    it("emits null, numeric, and numerically named evidence fields as static literals", async () => {
      const output = parseModule(
        await transformSource(
          `/// <cts-enable />
${IMPORTS}
${ruleDeclaration(`{ kind: "evidence", level: 2, note: null, 1: "one" }`)}
export const rules = exchangeRules([release]);
`,
          OPTIONS,
        ),
      );
      const release = output.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => statement.declarationList.declarations)
        .find((declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "release"
        );
      // Module-scope data is emitted inside a `__cf_data()` wrapper.
      const initializer = release?.initializer;
      assert(initializer && ts.isCallExpression(initializer));
      expect(literalToValue(initializer.arguments[0]!)).toEqual({
        appliesTo: { thisPolicy: true },
        pre: {
          integrity: [{ kind: "evidence", level: 2, note: null, "1": "one" }],
        },
        post: { dropClause: true },
      });
    });

    describe("with a node factory that fails", () => {
      const failure = new Error("node factory failure");

      /**
       * Runs the transformer over a module holding `body`, with a factory
       * whose object literal construction throws `failure`, and returns the
       * diagnostics it reported.
       */
      function transformWithFailingFactory(body: string) {
        const sourceFile = ts.createSourceFile(
          "/test.tsx",
          `${IMPORTS}\n${body}`,
          ts.ScriptTarget.ES2020,
          true,
        );
        const program = ts.createProgram({ rootNames: [], options: {} });
        const diagnostics: TransformationDiagnostic[] = [];
        ts.transform(sourceFile, [
          (tsContext) => (root) =>
            new CfcPolicyAuthoringTransformer({}).transform(
              new TransformationContext({
                program,
                sourceFile: root,
                tsContext: {
                  ...tsContext,
                  factory: {
                    ...tsContext.factory,
                    createObjectLiteralExpression: () => {
                      throw failure;
                    },
                  },
                },
                options: {
                  diagnosticsCollector: diagnostics,
                  moduleIdentities: OPTIONS.moduleIdentities,
                },
              }),
            ),
        ]);
        return diagnostics;
      }

      it("propagates the failure instead of reporting it as a diagnostic", () => {
        expect(() =>
          transformWithFailingFactory(`${ruleDeclaration()}
export const rules = exchangeRules([release]);`)
        ).toThrow(failure);
      });

      it("still reports invalid declarations that never reach the factory", () => {
        expect(
          transformWithFailingFactory(
            `export const release = exchangeRule({}, {});
export const rules = exchangeRules(release);`,
          ).map((diagnostic) => diagnostic.message),
        ).toEqual([
          "exchangeRule() requires one argument",
          "exchangeRules() requires one static array of exported rule identifiers",
          'exported rule "release" must belong to one exchangeRules() declaration',
        ]);
      });
    });

    it("reports nothing for a declaration without an initializer beside the rules", async () => {
      const { diagnostics } = await validateSource(
        `/// <cts-enable />
${IMPORTS}
declare const pending: number;
${ruleDeclaration()}
export const rules = exchangeRules([release]);
`,
        OPTIONS,
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      )
        .toEqual([]);
    });
  });
});
