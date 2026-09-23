import { assertEquals, assertThrows } from "@std/assert";

import ts from "typescript";

import { CFC_CANONICAL_ALIAS_NAMES } from "../src/cfc-authoring.ts";
import {
  CrossStageState,
  SchemaInjectionTransformer,
  transformCfDirective,
} from "../src/mod.ts";
import type {
  CfcPolicyCompilerManifestV1,
  TransformationDiagnostic,
} from "../src/mod.ts";
import { compileCfcPolicyManifestsForSource } from "../src/transformers/cfc-policy-authoring.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, writerIdentityMarkers } from "./transformed-ast.ts";
import {
  transformFiles,
  transformSource,
  validateFiles,
  validateSource,
} from "./utils.ts";

function normalizePrintedNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .replace(/\s+/g, " ")
    .trim();
}

function extractVariableInitializer(
  output: string,
  variableName: string,
): string {
  const sourceFile = ts.createSourceFile(
    "/output.tsx",
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let initializer: string | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      const unwrapped = ts.isCallExpression(node.initializer) &&
          ts.isPropertyAccessExpression(node.initializer.expression) &&
          ts.isIdentifier(node.initializer.expression.expression) &&
          node.initializer.expression.expression.text === "__cfHelpers" &&
          (
            node.initializer.expression.name.text === "__ct_data" ||
            node.initializer.expression.name.text === "__cf_data"
          ) &&
          node.initializer.arguments[0]
        ? node.initializer.arguments[0]
        : node.initializer;
      initializer = normalizePrintedNode(unwrapped, sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!initializer) {
    throw new Error(`Missing variable initializer for ${variableName}`);
  }

  return initializer;
}

function extractPatternSchemaPairs(output: string): string[][] {
  const sourceFile = ts.createSourceFile(
    "/output.tsx",
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const pairs: string[][] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "pattern" &&
      node.arguments.length >= 3
    ) {
      pairs.push([
        normalizePrintedNode(node.arguments[1]!, sourceFile),
        normalizePrintedNode(node.arguments[2]!, sourceFile),
      ]);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return pairs;
}

function compilePolicySource(
  source: string,
): readonly CfcPolicyCompilerManifestV1[] {
  const sourceFile = ts.createSourceFile(
    "/policy.ts",
    `
      import {
        cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
      } from "commonfabric/cfc";
      ${source}
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return compileCfcPolicyManifestsForSource(sourceFile, "sha256:policy");
}

function transformWithSchemaInjection(source: string): string {
  const fileName = "/test.tsx";
  const transformedSource = transformCfDirective(source);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictBindCallApply: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const rootFiles = [fileName, ...Object.keys(COMMONFABRIC_TYPES)];
  const sourceFiles = new Map<string, string>([
    [fileName, transformedSource],
    ...Object.entries(COMMONFABRIC_TYPES),
  ]);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    name,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const sourceText = sourceFiles.get(name);
    if (sourceText !== undefined) {
      return ts.createSourceFile(name, sourceText, languageVersion, true);
    }
    return originalGetSourceFile(
      name,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (name) => sourceFiles.get(name) ?? originalReadFile(name);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sourceFiles.has(name) || originalFileExists(name);
  host.resolveModuleNames = (moduleNames) =>
    moduleNames.map((name) => {
      if (name === "commonfabric") {
        return {
          resolvedFileName: "commonfabric.d.ts",
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }
      return undefined;
    });

  const program = ts.createProgram(rootFiles, compilerOptions, host);
  const transformer = new SchemaInjectionTransformer({
    state: new CrossStageState(),
  });
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error("Missing source file for schema injection test");
  }

  const result = ts.transform(sourceFile, [transformer.toFactory(program)]);
  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });
  const output = printer.printFile(result.transformed[0]!);
  result.dispose?.();
  return output;
}

Deno.test("ts-transformers re-exports the canonical CFC alias set", () => {
  assertEquals(CFC_CANONICAL_ALIAS_NAMES, [
    "Cfc",
    "Confidential",
    "Integrity",
    "AddIntegrity",
    "RepresentsCurrentUser",
    "AuthoredByCurrentUser",
    "RequiresIntegrity",
    "MaxConfidentiality",
    "AnyOf",
    "PolicyOf",
    "WriteAuthorizedBy",
    "TrustedActionWriteWithIntegrity",
    "TrustedActionWrite",
    "TrustedActionUiContract",
    "ExactCopy",
    "ProjectionPath",
    "ProjectionOf",
    "Projection",
  ]);
});

Deno.test("static exchange-rule declarations emit a deterministic side-channel manifest", async () => {
  const source = `/// <cts-enable />
    import {
      cfcPattern,
      exchangeRule,
      exchangeRules,
      THIS_POLICY,
      v,
    } from "commonfabric/cfc";

    export const releaseToReviewer = exchangeRule({
      appliesTo: THIS_POLICY,
      pre: {
        integrity: [cfcPattern.hasRole(
          v("reviewer"),
          THIS_POLICY.subject,
          "reader",
        )],
      },
      post: {
        addAlternatives: [cfcPattern.user(v("reviewer"))],
      },
    });

    export const releaseRules = exchangeRules([releaseToReviewer]);
  `;
  const manifests: unknown[] = [];
  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
    policyManifests: manifests,
  });
  const artifact = manifests[0] as CfcPolicyCompilerManifestV1;

  assertEquals(manifests.length, 1);
  assertEquals(artifact.manifest, {
    formatVersion: 1,
    moduleIdentity: "sha256:module",
    symbol: "releaseRules",
    template: {
      templateVersion: 1,
      exchangeRules: [{
        name: "releaseToReviewer",
        preCondition: {
          confidentiality: [{ thisPolicy: true }],
          integrity: [{
            type: "https://commonfabric.org/cfc/atom/HasRole",
            principal: { var: "reviewer" },
            space: { thisPolicyField: "subject" },
            role: "reader",
          }],
        },
        postCondition: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/User",
            subject: { var: "reviewer" },
          }],
          integrity: [],
        },
      }],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });
  assertEquals(typeof artifact.policyDigest, "string");
  assertEquals(output.includes("policyDigest"), false);

  const repeated: unknown[] = [];
  await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
    policyManifests: repeated,
  });
  assertEquals(repeated, manifests);
});

Deno.test("exchange-rule declarations survive every transparent wrapper spelling", () => {
  // The authoring grammar reads through wrappers that do not change the value a
  // declaration denotes. A spelling left out of that set does not fail as a
  // wrapper problem — the rule binding simply stops resolving, and
  // `exchangeRules()` reports the rule as invalid, which points the author at
  // the wrong thing entirely.
  const ruleSource = (wrap: (rule: string) => string) => `
    export const releaseToReviewer = ${
    wrap(`exchangeRule({
      appliesTo: THIS_POLICY,
      pre: {
        integrity: [cfcPattern.hasRole(
          v("reviewer"),
          THIS_POLICY.subject,
          "reader",
        )],
      },
      post: {
        addAlternatives: [cfcPattern.user(v("reviewer"))],
      },
    })`)
  };

    export const releaseRules = exchangeRules([releaseToReviewer]);
  `;

  // Policy sources compile as .ts, so the angle-bracket assertion is available
  // here alongside the spellings a .tsx pattern can use.
  const spellings: Record<string, (rule: string) => string> = {
    bare: (rule) => rule,
    parenthesized: (rule) => `(${rule})`,
    "as-cast": (rule) => `(${rule}) as never`,
    satisfies: (rule) => `(${rule}) satisfies unknown`,
    "non-null": (rule) => `(${rule})!`,
    "angle-bracket": (rule) => `<never>(${rule})`,
    nested: (rule) => `((${rule}) satisfies unknown)!`,
  };

  for (const [name, wrap] of Object.entries(spellings)) {
    const manifests = compilePolicySource(ruleSource(wrap));
    assertEquals(
      manifests.length,
      1,
      `expected one manifest for the ${name} spelling`,
    );
    assertEquals(manifests[0]!.manifest.symbol, "releaseRules");
  }
});

Deno.test("exchange-rule authoring rejects dynamic and unguarded declarations", async () => {
  const { diagnostics } = await validateSource(
    `/// <cts-enable />
    import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
    const dynamic = Math.random() > 0.5 ? [] : [];
    export const release = exchangeRule({
      appliesTo: THIS_POLICY,
      pre: { integrity: dynamic },
      post: { dropClause: true },
    });
    export const rules = exchangeRules([release]);
  `,
    {
      types: COMMONFABRIC_TYPES,
      moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
    },
  );

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-policy-authoring" &&
      diagnostic.message.includes("static")
    ),
    true,
  );
});

Deno.test("exchange-rule declarations fail closed on invalid export and binding forms", async () => {
  const cases = [
    {
      source: `
        const release = exchangeRule({
          appliesTo: THIS_POLICY,
          pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
          post: { dropClause: true },
        });
        export const rules = exchangeRules([release]);
      `,
      message: "must be exported",
    },
    {
      source: `
        export const release = exchangeRule({
          appliesTo: THIS_POLICY,
          pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
          post: { dropClause: true },
        });
        export const first = exchangeRules([release]);
        export const second = exchangeRules([release]);
      `,
      message: "cannot be reused",
    },
    {
      source: `
        export const release = exchangeRule({
          ...BASE,
          post: { addAlternatives: [cfcPattern.user(v("unbound"))] },
        });
        export const rules = exchangeRules([release]);
      `,
      message: "static",
    },
    {
      source: `
        export const release = exchangeRule({
          appliesTo: THIS_POLICY,
          pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
          post: { addAlternatives: [cfcPattern.user(v("unbound"))] },
        });
        export const rules = exchangeRules([release]);
      `,
      message: "not bound",
    },
    {
      source: `
        export const release = exchangeRule({ ...BASE, mystery: true });
        export const rules = exchangeRules([release]);
      `,
      message: "static",
    },
  ];

  for (const testCase of cases) {
    const { diagnostics } = await validateSource(
      `/// <cts-enable />
      import {
        cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
      } from "commonfabric/cfc";
      const BASE = {
        appliesTo: THIS_POLICY,
        pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
        post: { dropClause: true },
      };
      ${testCase.source}
    `,
      {
        types: COMMONFABRIC_TYPES,
        moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
      },
    );
    assertEquals(
      diagnostics.some((diagnostic) =>
        diagnostic.type === "cfc-policy-authoring" &&
        diagnostic.message.includes(testCase.message)
      ),
      true,
      testCase.message,
    );
  }
});

Deno.test("order-independent policy extraction enforces the authoring invariants", () => {
  const rule = `
    export const release = exchangeRule({
      appliesTo: THIS_POLICY,
      pre: { integrity: [] },
      post: { dropClause: true },
    });
  `;
  const cases = [
    `${rule} export const rules = exchangeRules([release], []);`,
    `${rule} export const rules = exchangeRules([release, release]);`,
    `${rule}
      export const first = exchangeRules([release]);
      export const second = exchangeRules([release]);
    `,
  ];

  for (const source of cases) {
    const sourceFile = ts.createSourceFile(
      "/policy.ts",
      `
        import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
        ${source}
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    assertThrows(() =>
      compileCfcPolicyManifestsForSource(sourceFile, "sha256:policy")
    );
  }
});

Deno.test("order-independent policy extraction covers the full static authoring grammar", () => {
  const [artifact] = compilePolicySource(`
    export const release = exchangeRule(({
      appliesTo: THIS_POLICY,
      pre: {
        confidentiality: [{
          kind: \`classification\`,
          rank: 2,
          active: false,
          note: null,
        }],
        integrity: [cfcPattern.hasRole(
          v("reviewer"), THIS_POLICY.subject, "reader",
        )],
      },
      preConfScope: "anywhere",
      guard: { policyState: [{ kind: "approved", by: v("reviewer") }] },
      post: { addAlternatives: [cfcPattern.user(v("reviewer"))] },
    } as const));
    export const rules = exchangeRules(([release] as const));
  `);

  const authoredRule = artifact.manifest.template.exchangeRules[0] as {
    preConfScope?: unknown;
    guard?: unknown;
  };
  assertEquals(authoredRule.preConfScope, "anywhere");
  assertEquals(authoredRule.guard, {
    policyState: [{ kind: "approved", by: { var: "reviewer" } }],
  });

  const rule = (fields: string) => `
    export const release = exchangeRule({
      ${/\bappliesTo\s*:/.test(fields) ? "" : "appliesTo: THIS_POLICY,"}
      ${
    /\bpre\s*:/.test(fields)
      ? ""
      : 'pre: { integrity: [{ kind: "evidence" }] },'
  }
      ${/\bpost\s*:/.test(fields) ? "" : "post: { dropClause: true },"}
      ${fields}
    });
    export const rules = exchangeRules([release]);
  `;
  const invalidCases: Array<[string, string]> = [
    [rule("mystery: true,"), "unknown rule field"],
    [
      `export const release = exchangeRule([]); export const rules = exchangeRules([release]);`,
      "requires an object",
    ],
    [
      rule("appliesTo: { thisPolicy: true, extra: true },"),
      "apply to THIS_POLICY",
    ],
    [rule("pre: 1,"), "rule pre must be"],
    [rule("pre: { integrity: true },"), "must be static arrays"],
    [rule("pre: { integrity: [THIS_POLICY] },"), "only valid in the appliesTo"],
    [rule("guard: 1,"), "rule guard must be"],
    [rule("guard: { policyState: [], extra: true },"), "unknown guard field"],
    [rule("guard: { policyState: [] },"), "non-empty static array"],
    [rule("guard: { policyState: [1] },"), "concrete non-empty kind"],
    [
      rule('guard: { policyState: [{ kind: "" }] },'),
      "concrete non-empty kind",
    ],
    [rule("pre: { integrity: [] },"), "integrity or policyState evidence"],
    [rule('preConfScope: "invalid",'), "invalid preConfScope"],
    [rule("post: 1,"), "rule post must be"],
    [rule("post: { dropClause: true, extra: true },"), "unknown post field"],
    [rule("post: {},"), "exactly one"],
    [rule("post: { dropClause: true, addAlternatives: [] },"), "exactly one"],
    [rule("post: { addAlternatives: true },"), "non-empty static array"],
    [rule("post: { addAlternatives: [] },"), "non-empty static array"],
    [
      rule("post: { addAlternatives: [THIS_POLICY] },"),
      "only valid in the appliesTo",
    ],
    [
      rule('post: { addAlternatives: [cfcPattern.user(v("unbound"))] },'),
      "not bound",
    ],
    [rule('pre: { integrity: [v("")] },'), "non-empty name"],
    [rule("pre: { integrity: [v(1)] },"), "non-empty static string"],
    [
      rule("pre: { integrity: [cfcPattern.unknown()] },"),
      "unsupported cfcPattern",
    ],
    [rule("pre: { integrity: [Math.random()] },"), "static literal content"],
    [rule("pre: { integrity: [[...[]]] },"), "dense static arrays"],
    [rule("pre: { integrity: [[,]] },"), "dense static arrays"],
    [rule("pre: { integrity: [{ ...{} }] },"), "explicit static object fields"],
    [rule('pre: { integrity: [{ ["kind"]: "x" }] },'), "computed"],
    [
      rule('pre: { integrity: [{ kind: "x", kind: "y" }] },'),
      "duplicate field",
    ],
    [
      `const release = exchangeRule({ appliesTo: THIS_POLICY, pre: { integrity: [{ kind: "x" }] }, post: { dropClause: true } }); export const rules = exchangeRules([release]);`,
      "must be exported",
    ],
    [
      `export const release = exchangeRule({ appliesTo: THIS_POLICY, pre: { integrity: [{ kind: "x" }] }, post: { dropClause: true } }); const rules = exchangeRules([release]);`,
      "must be exported",
    ],
    [
      `export const release = exchangeRule({ appliesTo: THIS_POLICY, pre: { integrity: [{ kind: "x" }] }, post: { dropClause: true } }); export const rules = exchangeRules([release, {}]);`,
      "direct rule identifiers",
    ],
    [
      `export const release = exchangeRule({ appliesTo: THIS_POLICY, pre: { integrity: [{ kind: "x" }] }, post: { dropClause: true } }); export const rules = exchangeRules([missing]);`,
      "invalid rule",
    ],
    [
      `export const release = exchangeRule({ appliesTo: THIS_POLICY, pre: { integrity: [{ kind: "x" }] }, post: { dropClause: true } });`,
      "must belong to one",
    ],
  ];

  for (const [source, message] of invalidCases) {
    assertThrows(() => compilePolicySource(source), Error, message);
  }
});

Deno.test("authoring transformer diagnoses every invalid module binding form", async () => {
  const validRule = `exchangeRule({
    appliesTo: THIS_POLICY,
    pre: { integrity: [{ kind: "evidence" }] },
    post: { dropClause: true },
  })`;
  const cases = [
    `export const release = exchangeRule({}, {});`,
    `const release = ${validRule}; export { release as renamed };`,
    `export const release = ${validRule}; const rules = exchangeRules([release]); export { rules as renamed };`,
    `export const release = ${validRule}; const rules = exchangeRules([release]);`,
    `export const release = ${validRule}; export const rules = exchangeRules("dynamic");`,
    `export const release = ${validRule}; export const rules = exchangeRules([release, {}]);`,
    `export const release = ${validRule}; export const rules = exchangeRules([release, release]);`,
    `export const release = ${validRule}; export const rules = exchangeRules([missing]);`,
    `export function nested() { return exchangeRules([]); }`,
  ];

  for (const source of cases) {
    const { diagnostics } = await validateSource(
      `/// <cts-enable />
        import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
        ${source}
      `,
      {
        types: COMMONFABRIC_TYPES,
        moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
      },
    );
    assertEquals(
      diagnostics.some((diagnostic) =>
        diagnostic.type === "cfc-policy-authoring"
      ),
      true,
      source,
    );
  }

  const { diagnostics } = await validateSource(
    `/// <cts-enable />
      import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
      export const release = ${validRule};
      export const rules = exchangeRules([release]);
    `,
    { types: COMMONFABRIC_TYPES },
  );
  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-policy-authoring" &&
      diagnostic.message.includes("module identity")
    ),
    true,
  );
});

Deno.test("PolicyOf lowers a local exported ruleset to an exact schema marker", async () => {
  const manifests: unknown[] = [];
  const output = await transformSource(
    `/// <cts-enable />
    import { Confidential, toSchema } from "commonfabric";
    import type { PolicyOf } from "commonfabric/cfc";
    import {
      cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
    } from "commonfabric/cfc";
    export const release = exchangeRule({
      appliesTo: THIS_POLICY,
      pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
      post: { addAlternatives: [cfcPattern.user(v("user"))] },
    });
    export const rules = exchangeRules([release]);
    export const schema = toSchema<
      Confidential<string, [PolicyOf<typeof rules>]>
    >();
  `,
    {
      types: COMMONFABRIC_TYPES,
      moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
      policyManifests: manifests,
    },
  );
  const artifact = manifests[0] as CfcPolicyCompilerManifestV1;

  assertEquals(output.includes('policyRefKind: "module"'), true);
  assertEquals(output.includes('moduleIdentity: "sha256:module"'), true);
  assertEquals(output.includes('symbol: "rules"'), true);
  assertEquals(
    output.includes(`policyDigest: "${artifact.policyDigest}"`),
    true,
  );
  assertEquals(output.includes("__ctOwningSpace: true"), true);
  assertEquals(output.includes("__ctPolicyIdentityOf"), false);
});

Deno.test("PolicyOf resolves a ruleset binding through each .tsx wrapper spelling", async () => {
  // The recognizer looks through wrappers to the `exchangeRules()` call. A
  // spelling it does not strip surfaces as "PolicyOf binding must resolve to an
  // exchangeRules() declaration" — a diagnostic that names the binding rather
  // than the wrapper, and so points the author at the wrong thing.
  const spellings: Record<string, string> = {
    bare: "exchangeRules([release])",
    parenthesized: "(exchangeRules([release]))",
    "as-cast": "exchangeRules([release]) as never",
    satisfies: "exchangeRules([release]) satisfies unknown",
    "non-null": "exchangeRules([release])!",
  };

  for (const [name, ruleset] of Object.entries(spellings)) {
    const { diagnostics } = await validateSource(
      `/// <cts-enable />
      import { Confidential, toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import {
        cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
      } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
        post: { addAlternatives: [cfcPattern.user(v("user"))] },
      });
      export const rules = ${ruleset};
      export const schema = toSchema<
        Confidential<string, [PolicyOf<typeof rules>]>
      >();
    `,
      {
        types: COMMONFABRIC_TYPES,
        moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
      },
    );

    assertEquals(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("must resolve to an exchangeRules()")
      ).length,
      0,
      `the ${name} spelling should resolve as a ruleset binding`,
    );
  }
});

Deno.test("PolicyOf resolves a ruleset binding behind an angle-bracket assertion", async () => {
  // `<T>x` is JSX in a .tsx source, so the angle-bracket spelling is only
  // reachable from a .ts module — which is where a policy module usually is.
  const { diagnostics } = await validateFiles({
    "/policy.ts": `/// <cts-enable />
      import { Confidential, toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import {
        cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
      } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
        post: { addAlternatives: [cfcPattern.user(v("user"))] },
      });
      export const rules = <never>exchangeRules([release]);
      export const schema = toSchema<
        Confidential<string, [PolicyOf<typeof rules>]>
      >();
    `,
  }, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([["/policy.ts", "sha256:module"]]),
  });

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.message.includes("must resolve to an exchangeRules()")
    ).length,
    0,
  );
});

Deno.test("PolicyOf retains the defining identity of an imported ruleset", async () => {
  const outputs = await transformFiles({
    "/policy.ts": `/// <cts-enable />
      import {
        cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
      } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
        post: { addAlternatives: [cfcPattern.user(v("user"))] },
      });
      export const rules = exchangeRules([release]);
    `,
    "/main.tsx": `/// <cts-enable />
      import { Confidential, toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import { rules } from "./policy.ts";
      export const schema = toSchema<
        Confidential<string, [PolicyOf<typeof rules>]>
      >();
    `,
  }, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([
      ["/main.tsx", "sha256:importer"],
      ["/policy.ts", "sha256:defining-policy"],
    ]),
  });

  assertEquals(
    outputs["/main.tsx"]?.includes(
      'moduleIdentity: "sha256:defining-policy"',
    ),
    true,
  );
  assertEquals(
    outputs["/main.tsx"]?.includes('moduleIdentity: "sha256:importer"'),
    false,
  );
});

Deno.test("PolicyOf validation receives defining module identities", async () => {
  const { diagnostics } = await validateFiles({
    "/policy.ts": `/// <cts-enable />
      import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [{ kind: "evidence" }] },
        post: { dropClause: true },
      });
      export const rules = exchangeRules([release]);
    `,
    "/main.tsx": `/// <cts-enable />
      import { Confidential, toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import { rules } from "./policy.ts";
      export const schema = toSchema<
        Confidential<string, [PolicyOf<typeof rules>]>
      >();
    `,
  }, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([
      ["/policy.ts", "sha256:defining-policy"],
      ["/main.tsx", "sha256:importer"],
    ]),
  });

  assertEquals(
    diagnostics.some((diagnostic) => diagnostic.type === "cfc-policy-of"),
    false,
  );
});

Deno.test("PolicyOf fallback fails closed when the defining rules are invalid", async () => {
  const { diagnostics } = await validateFiles({
    "/main.tsx": `/// <cts-enable />
      import { Confidential, toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import { rules } from "./policy.ts";
      export const schema = toSchema<
        Confidential<string, [PolicyOf<typeof rules>]>
      >();
    `,
    "/policy.ts": `/// <cts-enable />
      import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [{ kind: "evidence" }] },
        post: { dropClause: true },
      });
      export const rules = exchangeRules([release, release]);
    `,
  }, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([
      ["/main.tsx", "sha256:importer"],
      ["/policy.ts", "sha256:defining-policy"],
    ]),
  });

  assertEquals(
    diagnostics.some((diagnostic) => diagnostic.type === "cfc-policy-of"),
    true,
    JSON.stringify(diagnostics),
  );
});

Deno.test("PolicyOf does not confuse defining files with the same normalized suffix", async () => {
  const policySource = (role: string) =>
    `/// <cts-enable />
    import {
      cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
    } from "commonfabric/cfc";
    export const release = exchangeRule({
      appliesTo: THIS_POLICY,
      pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "${role}")] },
      post: { addAlternatives: [cfcPattern.user(v("user"))] },
    });
    export const rules = exchangeRules([release]);
  `;
  const outputs = await transformFiles({
    "/a/policy.ts": policySource("reader-a"),
    "/b/policy.ts": policySource("reader-b"),
    "/main.tsx": `/// <cts-enable />
      import { Confidential, toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import { rules } from "./b/policy.ts";
      export const schema = toSchema<
        Confidential<string, [PolicyOf<typeof rules>]>
      >();
    `,
  }, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([
      ["/a/policy.ts", "sha256:policy-a"],
      ["/b/policy.ts", "sha256:policy-b"],
      ["/main.tsx", "sha256:importer"],
    ]),
  });

  assertEquals(
    outputs["/main.tsx"]?.includes('moduleIdentity: "sha256:policy-b"'),
    true,
  );
  assertEquals(
    outputs["/main.tsx"]?.includes('moduleIdentity: "sha256:policy-a"'),
    false,
  );
});

Deno.test("exchangeRules rejects renamed export specifiers", async () => {
  const { diagnostics } = await validateSource(
    `/// <cts-enable />
    import {
      cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
    } from "commonfabric/cfc";
    const release = exchangeRule({
      appliesTo: THIS_POLICY,
      pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
      post: { addAlternatives: [cfcPattern.user(v("user"))] },
    });
    const rules = exchangeRules([release]);
    export { release, rules as publicRules };
  `,
    {
      types: COMMONFABRIC_TYPES,
      moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
    },
  );

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-policy-authoring" &&
      diagnostic.message.includes("renamed export specifiers")
    ),
    true,
  );
});

Deno.test("PolicyOf rejects non-ruleset and non-typeof bindings", async () => {
  for (const binding of ["{ forged: true }", "typeof plain"]) {
    const { diagnostics } = await validateSource(
      `/// <cts-enable />
      import { toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      const plain = { forged: true };
      export const schema = toSchema<PolicyOf<${binding}>>();
    `,
      {
        types: COMMONFABRIC_TYPES,
        moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
      },
    );
    assertEquals(
      diagnostics.some((diagnostic) => diagnostic.type === "cfc-policy-of"),
      true,
    );
  }
});

Deno.test("PolicyOf validation ignores unrelated local aliases", async () => {
  const { diagnostics } = await validateSource(
    `/// <cts-enable />
      import { toSchema } from "commonfabric";
      type PolicyOf<T> = T;
      export const schema = toSchema<PolicyOf<string>>();
    `,
    { types: COMMONFABRIC_TYPES },
  );

  assertEquals(
    diagnostics.some((diagnostic) => diagnostic.type === "cfc-policy-of"),
    false,
  );
});

Deno.test("PolicyOf requires the rules binding to be exported", async () => {
  const { diagnostics } = await validateSource(
    `/// <cts-enable />
      import { toSchema } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [{ kind: "evidence" }] },
        post: { dropClause: true },
      });
      const rules = (exchangeRules([release]) as ReturnType<typeof exchangeRules>);
      export const schema = toSchema<PolicyOf<typeof rules>>();
    `,
    {
      types: COMMONFABRIC_TYPES,
      moduleIdentities: new Map([["/test.tsx", "sha256:module"]]),
    },
  );

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-policy-of" &&
      diagnostic.message.includes("must be exported")
    ),
    true,
  );
});

Deno.test("WriteAuthorizedBy accepts a local function binding", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    function localFunction() {}

    const functionSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof localFunction>
    >();

    export { functionSchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ),
    false,
  );
});

Deno.test(
  "a direct-root WriteAuthorizedBy claim names an imported writer's declaring module",
  async () => {
    // Renamed, and reached through a re-export. The direct-root path once
    // stamped the importing file and the import's spelling, so the claim
    // named a writer that did not exist and the intended one could not
    // satisfy it; the nested path had resolved the declaration all along.
    const diagnostics: TransformationDiagnostic[] = [];
    const outputs = await transformFiles(
      {
        "/main.tsx": `/// <cts-enable />
          import { toSchema, WriteAuthorizedBy } from "commonfabric";
          import { writer as save } from "./barrel.ts";

          const schema = toSchema<WriteAuthorizedBy<string, typeof save>>();

          export { schema };
        `,
        "/barrel.ts": `export * from "./writer.ts";`,
        "/writer.ts": `import { handler, Writable } from "commonfabric";
          export const writer = handler<void, { name: Writable<string> }>(
            (_event, { name }) => { name.set("updated"); },
          );`,
      },
      {
        types: COMMONFABRIC_TYPES,
        pipelineDiagnostics: diagnostics,
        moduleIdentities: new Map([
          ["/main.tsx", "identity:main"],
          ["/barrel.ts", "identity:barrel"],
          ["/writer.ts", "identity:writer"],
        ]),
      },
    );
    assertEquals(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    assertEquals(writerIdentityMarkers(parseModule(outputs["/main.tsx"]!)), [{
      file: "/writer.ts",
      path: ["writer"],
      moduleIdentity: "identity:writer",
    }]);
  },
);

Deno.test(
  "a direct-root claim on a declaration file's binding is refused, not minted",
  async () => {
    // The minter throws for a defining source with no module identity, and a
    // declaration file never has one. Resolving the binding must stop short
    // of it, so the validation pass's diagnostic is what the author sees.
    const diagnostics: TransformationDiagnostic[] = [];
    await transformFiles(
      {
        "/main.tsx": `/// <cts-enable />
          import { toSchema, WriteAuthorizedBy } from "commonfabric";
          import { ambient } from "./ambient.d.ts";

          const schema = toSchema<WriteAuthorizedBy<string, typeof ambient>>();

          export { schema };
        `,
        "/ambient.d.ts": "export declare function ambient(): void;",
      },
      {
        types: COMMONFABRIC_TYPES,
        pipelineDiagnostics: diagnostics,
        moduleIdentities: new Map([["/main.tsx", "identity:main"]]),
      },
    );
    assertEquals(
      diagnostics.map((diagnostic) => diagnostic.type),
      ["cfc-write-authorized-by"],
    );
  },
);

Deno.test(
  "WriteAuthorizedBy preserves the local binding identity through schema emission",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      function localFunction() {}

      const functionSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof localFunction>
      >();

      export { functionSchema };
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(output.includes("__ctWriterIdentityOf: {"), true);
    assertEquals(output.includes('file: "/test.tsx"'), true);
    assertEquals(output.includes('path: ["localFunction"]'), true);
  },
);

Deno.test(
  "WriteAuthorizedBy lowers trusted top-level builder bindings with statement-form identity annotation",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: WriteAuthorizedBy<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("const saveTitle = __cfBindVerifiedBinding("),
      false,
    );
    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      true,
    );
  },
);

Deno.test(
  "TrustedActionWrite lowers trusted top-level builder bindings",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, TrustedActionWrite } from "commonfabric";

      const TRUSTED_SAVE_ACTION = "TrustedSaveTitle";
      const TRUSTED_SAVE_SURFACE = "TrustedSaveSurface";

      const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: TrustedActionWrite<
          string,
          typeof saveTitle,
          typeof TRUSTED_SAVE_ACTION,
          typeof TRUSTED_SAVE_SURFACE
        >;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      true,
    );
    assertEquals(
      output.includes('action: "TrustedSaveTitle"'),
      true,
    );
    assertEquals(
      output.includes('trustedPattern: "TrustedSaveSurface"'),
      true,
    );
    assertEquals(
      output.includes('requiredEventIntegrity: ["TrustedSaveSurface"]'),
      true,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy lowers alias-referenced trusted builder bindings",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      type TrustedWrite<T, Binding> = WriteAuthorizedBy<T, Binding>;

      const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: TrustedWrite<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      true,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy lowers exported trusted builder bindings inline",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      export const saveTitle = handler<void, { title: { get(): string; set(value: string): void }; savedTitle: { set(value: string): void } }>(
        (_event, { title, savedTitle }) => {
          savedTitle.set(title.get());
        },
      );

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: WriteAuthorizedBy<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("export const saveTitle = __cfBindVerifiedBinding("),
      true,
    );
    assertEquals(
      output.includes("__cfBindVerifiedBinding(saveTitle, {"),
      false,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy accepts direct supported builder binding initializers",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      declare function module<T>(fn: T): T;
      declare function requireEventIntegrity<T>(fn: T): T;

      const moduleWriter = module(() => undefined);
      const eventWriter = requireEventIntegrity(() => undefined);

      const moduleSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof moduleWriter>
      >();
      const eventSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof eventWriter>
      >();

      export { moduleSchema, eventSchema };
    `;

    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      diagnostics.some((diagnostic) =>
        diagnostic.type === "cfc-write-authorized-by"
      ),
      false,
    );
  },
);

Deno.test(
  "WriteAuthorizedBy validates concrete pattern output schemas",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      interface InvalidQueryOutput {
        savedTitle: WriteAuthorizedBy<string, string>;
      }

      interface InvalidBindingOutput {
        savedTitle: WriteAuthorizedBy<string, typeof arbitrary>;
      }

      const invalidQuery = pattern<{ title: string }, InvalidQueryOutput>(
        (state) => ({ savedTitle: state.title }),
      );
      const invalidBinding = pattern<{ title: string }, InvalidBindingOutput>(
        (state) => ({ savedTitle: state.title }),
      );

      export { invalidQuery, invalidBinding };
    `;

    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const cfcDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    );

    assertEquals(cfcDiagnostics.length >= 2, true);
  },
);

Deno.test(
  "WriteAuthorizedBy validates concrete alias chains without rejecting unused generic aliases",
  async () => {
    const source = `/// <cts-enable />
      import { handler, pattern, WriteAuthorizedBy } from "commonfabric";

      type TrustedWrite<T, Binding> = WriteAuthorizedBy<T, Binding>;

      const saveTitle = handler<void, { title: { get(): string; savedTitle: { set(value: string): void } } }>(
        () => undefined,
      );

      interface Output {
        savedTitle: TrustedWrite<string, typeof saveTitle>;
      }

      const valid = pattern<{ title: string }, Output>(
        (state) => ({ savedTitle: state.title }),
      );

      export { valid };
    `;

    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      diagnostics.some((diagnostic) =>
        diagnostic.type === "cfc-write-authorized-by"
      ),
      false,
    );
  },
);

Deno.test(
  "Schema injection keeps explicit and inferred CFC-aware pattern schemas aligned",
  async () => {
    const source = `/// <cts-enable />
      import { pattern } from "commonfabric";
      import type { Cfc } from "commonfabric";

      type Model = Cfc<
        { title: string },
        { confidentiality: "public" }
      >;

      const explicit = pattern<Model, Model>((cell) => ({ title: cell.title }));
      const inferred = pattern((cell: Model) => ({ title: cell.title }));
    `;

    const output = await transformWithSchemaInjection(source);
    const pairs = extractPatternSchemaPairs(output);
    assertEquals(pairs.length, 2);
    assertEquals(pairs[0]![0], pairs[1]![0]);
  },
);

Deno.test(
  "Schema injection keeps inferred schemas, explicit toSchema<T>(), and explicit output bindings identical",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, toSchema } from "commonfabric";

      interface Model {
        title: string;
      }

      const directSchema = toSchema<Model>();
      const inferred = pattern((state: Model) => ({ title: state.title }));
      const explicit = pattern<Model, Model>((state) => ({ title: state.title }));

      export { directSchema, inferred, explicit };
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const directSchema = extractVariableInitializer(output, "directSchema");
    const pairs = extractPatternSchemaPairs(output);

    assertEquals(pairs.length, 2);
    assertEquals(pairs[0]![1], pairs[1]![1]);
    assertEquals(directSchema, pairs[0]![1]);
    assertEquals(directSchema, pairs[1]![1]);
  },
);

Deno.test("WriteAuthorizedBy rejects unsupported binding declarations", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    declare const missingInitializer: () => void;
    const arbitrary = 123;
    const invalidSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof missingInitializer>
    >();
    const invalidBindingSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof arbitrary>
    >();

    const invalidQuerySchema = toSchema<
      WriteAuthorizedBy<{ title: string }, string>
    >();

    export { invalidSchema, invalidBindingSchema, invalidQuerySchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ).length >= 3,
    true,
  );
});
