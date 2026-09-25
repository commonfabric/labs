import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { CFC_TRANSFORMER_STAGE_NAMES } from "../src/cf-pipeline.ts";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  collect,
  emittedSchemas,
  hasKeyPathRead,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";

/**
 * The hoisted `const __cfLift_N = __cfHelpers.lift(...)` call that ultimately
 * produces `const <resultName> = …`. Walks the `.for(...)` chain on the result
 * initializer down to the `__cfLift_N(...)` application, then finds the matching
 * declaration.
 */
function liftCallFor(
  root: ts.SourceFile,
  resultName: string,
): ts.CallExpression {
  const decl = collect(root, ts.isVariableDeclaration).find((d) =>
    ts.isIdentifier(d.name) && d.name.text === resultName
  );
  if (!decl?.initializer) {
    throw new Error(`No \`const ${resultName} = …\` declaration`);
  }
  let expr: ts.Expression = decl.initializer;
  while (
    ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
  ) {
    expr = expr.expression.expression;
  }
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) {
    throw new Error(`Expected ${resultName} to apply a hoisted lift`);
  }
  const liftId = expr.expression.text;
  const liftDecl = collect(root, ts.isVariableDeclaration).find((d) =>
    ts.isIdentifier(d.name) && d.name.text === liftId
  );
  if (!liftDecl?.initializer || !ts.isCallExpression(liftDecl.initializer)) {
    throw new Error(`No hoisted lift declaration for ${liftId}`);
  }
  return liftDecl.initializer;
}

/**
 * The `... satisfies …JSONSchema` argument literals of a hoisted lift call,
 * evaluated in argument order. The lift signature is `lift(cb, argSchema,
 * resSchema)`, so index 0 is the input schema and index 1 the result schema.
 */
function liftSchemaArgs(call: ts.CallExpression): Record<string, unknown>[] {
  return call.arguments
    .filter((arg): arg is ts.SatisfiesExpression =>
      ts.isSatisfiesExpression(arg)
    )
    .map((arg) => literalToValue(arg) as Record<string, unknown>);
}

/** The argument and result schemas of the hoisted lift driving `resultName`. */
function liftSchemasFor(
  root: ts.SourceFile,
  resultName: string,
): { argSchema: Record<string, unknown>; resSchema: Record<string, unknown> } {
  const schemas = liftSchemaArgs(liftCallFor(root, resultName));
  if (schemas.length < 2) {
    throw new Error(`Expected two schema arguments for ${resultName}`);
  }
  return { argSchema: schemas[0]!, resSchema: schemas[1]! };
}

function schedulerOptionsFor(
  call: ts.CallExpression,
): Record<string, unknown> | undefined {
  for (const argument of [...call.arguments].reverse()) {
    if (
      !ts.isObjectLiteralExpression(argument) &&
      !ts.isSatisfiesExpression(argument)
    ) {
      continue;
    }
    const value = literalToValue(argument) as Record<string, unknown>;
    if (
      "completeSchedulerScopeSummary" in value ||
      "materializerWriteInputPaths" in value
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * The input (argument) schema of the first hoisted lift emitted in `root` — the
 * lift a lone `computed()` capture lowers to.
 */
function firstLiftArgSchema(root: ts.SourceFile): Record<string, unknown> {
  const liftCall = callsNamed(root, "lift").find((call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "__cfHelpers"
  );
  if (!liftCall) {
    throw new Error("expected an emitted __cfHelpers.lift(...) call");
  }
  const schemas = liftSchemaArgs(liftCall);
  if (schemas.length < 1) throw new Error("lift call had no schema arguments");
  return schemas[0]!;
}

/** Every `type` string that appears anywhere within an evaluated schema. */
function collectSchemaTypes(value: unknown, acc: string[] = []): string[] {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "type" && typeof child === "string") acc.push(child);
      collectSchemaTypes(child, acc);
    }
  }
  return acc;
}

/**
 * True when `node` sits inside a callback arrow that a reactive compute owns —
 * an arrow passed directly to `lift`/`derive`, or the callback of a hoisted
 * `const __cfLift_N = __cfHelpers.lift(cb, …)` declaration. This distinguishes a
 * call the pipeline extracted into a synthetic compute from one left structural.
 */
function isInsideExtractedComputeCallback(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const arrowParent = current.parent;
      if (arrowParent && ts.isCallExpression(arrowParent)) {
        const callee = arrowParent.expression;
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
        if (calleeName === "lift" || calleeName === "derive") return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * True when `node` has an ancestor call whose target name (bare or member) is
 * `name` — e.g. it is nested inside a `derive(...)` / `__cfHelpers.derive(...)`
 * call.
 */
function isInsideCallNamed(node: ts.Node, name: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
      if (calleeName === name) return true;
    }
    current = current.parent;
  }
  return false;
}

Deno.test(
  "Pipeline regression: manual mapWithPattern preserves fixed plain-capture key evaluation",
  async () => {
    const source = `import { pattern, UI } from "commonfabric";
const key = "small" as const;
const p = pattern<{ items: string[] }>((state) => ({
  [UI]: (
    <div>
      {state.items.mapWithPattern(
        pattern(({ params: { style: { [key]: fontSize } } }) => (
          <span>{fontSize}</span>
        )),
        { style: { small: 12, large: 16 }, key },
      )}
    </div>
  ),
}));
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);

    const root = parseModule(output);
    // `fontSize` binds to a dynamic element access `…style[key]`, keyed by the
    // `key` identifier, never resolved to the static `.small` member.
    const fontSizeDecl = collect(root, ts.isVariableDeclaration).find((decl) =>
      ts.isIdentifier(decl.name) && decl.name.text === "fontSize"
    );
    assert(fontSizeDecl?.initializer, "expected a fontSize declaration");
    const access = fontSizeDecl.initializer;
    assert(
      ts.isElementAccessExpression(access) &&
        ts.isIdentifier(access.argumentExpression) &&
        access.argumentExpression.text === "key",
      "expected fontSize to bind a `[key]` element access",
    );
    const style = access.expression;
    assert(
      ts.isPropertyAccessExpression(style) && style.name.text === "style",
      "expected the element access base to be `…style`",
    );
    assert(
      !collect(root, ts.isPropertyAccessExpression).some((pa) =>
        pa.name.text === "small" &&
        ts.isPropertyAccessExpression(pa.expression) &&
        pa.expression.name.text === "style"
      ),
      "expected no static `style.small` resolution",
    );
  },
);

Deno.test(
  "Pipeline regression: CFC transformer stages stay in the fixed order",
  () => {
    assertEquals(CFC_TRANSFORMER_STAGE_NAMES, [
      "CastValidationTransformer",
      "EmptyArrayOfValidationTransformer",
      "OpaqueGetValidationTransformer",
      "PatternContextValidationTransformer",
      "MergeablePushValidationTransformer",
      "VerbReturnValidationTransformer",
      "IndirectBuilderCallbackValidationTransformer",
      "CfcPolicyAuthoringTransformer",
      "CfcPolicyOfValidationTransformer",
      "JsxExpressionSiteRouterTransformer",
      "AssertDiagnosticsTransformer",
      "LiftLoweringTransformer",
      "ClosureTransformer",
      "PatternOwnedExpressionSiteLoweringTransformer",
      "HelperOwnedExpressionSiteLoweringTransformer",
      "WriteAuthorizedByValidationTransformer",
      "PatternCallbackLoweringTransformer",
      "SchemaInjectionTransformer",
      "BuilderCallHoistingTransformer",
      "SchemaGeneratorTransformer",
      "VerbTierMarkTransformer",
      "ReactiveVariableForTransformer",
      "ModuleScopeShadowingTransformer",
      "ModuleScopeCfDataTransformer",
      "PatternCoverageTransformer",
      "ModuleScopeFunctionHardeningTransformer",
    ]);
  },
);

Deno.test(
  "Pipeline regression: opaque key lowering preserves literal-typed key evaluation",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commonfabric";
declare function getKey(): "title";
const p = pattern<{ item: { title: string } }>((state) => {
  const { [getKey()]: title } = state.item;
  return {
    [UI]: <div>{title}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // `state.key("item")` reactive read survives, and `title` binds to a
    // `.key(getKey())` dynamic read — the key argument stays the `getKey()`
    // call, never resolved to the literal `"title"`.
    assert(hasKeyPathRead(root, "item", "state"));
    const titleDecl = collect(root, ts.isVariableDeclaration).find((decl) =>
      ts.isIdentifier(decl.name) && decl.name.text === "title"
    );
    assert(titleDecl?.initializer, "expected a title declaration");
    const keyCall = titleDecl.initializer;
    assert(
      ts.isCallExpression(keyCall) &&
        ts.isPropertyAccessExpression(keyCall.expression) &&
        keyCall.expression.name.text === "key",
      "expected title to bind a `.key(...)` call",
    );
    const keyArg = keyCall.arguments[0];
    assert(
      keyArg && ts.isCallExpression(keyArg) &&
        ts.isIdentifier(keyArg.expression) &&
        keyArg.expression.text === "getKey",
      "expected the key argument to stay the getKey() call, not the literal",
    );
    assert(
      !(keyArg && ts.isStringLiteralLike(keyArg)),
      "expected the dynamic key not to resolve to a string literal",
    );
  },
);

Deno.test(
  "Pipeline regression: imported Common Fabric keys stay helper-backed in rewrites",
  async () => {
    const source = `/// <cts-enable />
import { NAME, UI, pattern } from "commonfabric";

type MentionablePiece = { [NAME]?: string };

const p = pattern<{ mentionable: MentionablePiece[] }, { [UI]: any }>((
  { mentionable },
) => ({
  [UI]: <div>{mentionable.map((c) => c[NAME]!)}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    // Test intent: imported well-known CF keys (NAME/UI/SELF/FS) must never
    // appear as bare identifiers in the lowered output — they must always be
    // helper-backed (__cfHelpers.NAME etc.). After CT-1586, well-known CF
    // keys on tracked-opaque roots lower to `expr.key(__cfHelpers.NAME)`
    // in-place rather than being wrapped in `derive(..., ({c}) =>
    // c[__cfHelpers.NAME])`. The surface form must include the helper
    // expression on the `c` root specifically — generic substring
    // checks could pass even if `c` got renamed by an unrelated bug.
    const root = parseModule(output);
    const isHelperName = (node: ts.Expression): boolean =>
      ts.isPropertyAccessExpression(node) && node.name.text === "NAME" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__cfHelpers";
    const keyOnC = callsNamed(root, "key").filter((call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "c"
    );
    assert(
      keyOnC.some((call) =>
        call.arguments[0] !== undefined && isHelperName(call.arguments[0])
      ),
      "expected c.key(__cfHelpers.NAME) helper-backed read",
    );
    // No `.key(NAME)` with a bare NAME identifier argument.
    assert(
      !callsNamed(root, "key").some((call) =>
        call.arguments[0] !== undefined &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === "NAME"
      ),
      "Bare NAME identifier must not appear as a .key() argument",
    );
    // No `c[NAME]` element access with a bare NAME identifier.
    assert(
      !collect(root, ts.isElementAccessExpression).some((el) =>
        ts.isIdentifier(el.argumentExpression) &&
        el.argumentExpression.text === "NAME"
      ),
      "Bare NAME identifier must not appear as an element access key",
    );
  },
);

Deno.test(
  "Pipeline regression: scheduler options preserve helper-backed keys in lift callbacks",
  async () => {
    const source = await Deno.readTextFile(
      new URL(
        "./fixtures/jsx-expressions/reactive-cell-map.input.tsx",
        import.meta.url,
      ),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    assert(
      callsNamed(root, "lift").some((call) =>
        schedulerOptionsFor(call)?.completeSchedulerScopeSummary === true
      ),
      "expected the transformed lift to carry a completeness marker",
    );
    const pieceNameReads = collect(root, ts.isElementAccessExpression).filter(
      (access) =>
        ts.isIdentifier(access.expression) &&
        access.expression.text === "piece",
    );
    assert(pieceNameReads.length > 0, "expected a piece name element read");
    assert(
      pieceNameReads.every((access) =>
        ts.isPropertyAccessExpression(access.argumentExpression) &&
        ts.isIdentifier(access.argumentExpression.expression) &&
        access.argumentExpression.expression.text === "__cfHelpers" &&
        access.argumentExpression.name.text === "NAME"
      ),
      "options-bearing lift callbacks must retain __cfHelpers.NAME",
    );
  },
);

Deno.test(
  "Pipeline regression: nested writable map callbacks keep direct key reads in shrunk schemas",
  async () => {
    const source = await Deno.readTextFile(
      new URL(
        "./fixtures/kitchensink/nested-writable-pattern-branches.input.tsx",
        import.meta.url,
      ),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    // Every property name that appears anywhere in an evaluated schema.
    const keysDeep = (value: unknown, acc = new Set<string>()): Set<string> => {
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          acc.add(key);
          keysDeep(child, acc);
        }
      }
      return acc;
    };

    const mapSchemas = emittedSchemas(root)
      .filter((schema) => {
        const required = schema.required;
        return Array.isArray(required) && required.includes("element") &&
          required.includes("params");
      })
      .map((schema) => ({ schema, keys: keysDeep(schema) }));

    const outerMap = mapSchemas.find(({ keys }) =>
      keys.has("globalAccent") && keys.has("selectedTaskId") &&
      keys.has("hoveredSectionId")
    );
    assert(outerMap, "expected outer sections map schema");
    for (const field of ["id", "title", "expanded", "accent", "tasks"]) {
      assert(outerMap.keys.has(field), `outer map schema missing ${field}`);
    }

    const innerMap = mapSchemas.find(({ keys }) =>
      keys.has("sectionIndex") && keys.has("selectedTaskId") &&
      keys.has("hoveredSectionId") && !keys.has("globalAccent")
    );
    assert(innerMap, "expected inner tasks map schema");
    for (const field of ["id", "label", "done", "tags", "note"]) {
      assert(innerMap.keys.has(field), `inner map schema missing ${field}`);
    }
  },
);

Deno.test(
  "Pipeline regression: nested authored ifElse predicate in helper-owned branch lowers to derive",
  async () => {
    const source =
      `import { computed, ifElse, pattern, UI } from "commonfabric";

interface ValidationIssue {
  message: string;
  severity: "error" | "warning";
}

interface ExtractedField {
  targetModule: string;
  fieldName: string;
  confidenceLevel?: "high" | "medium" | "low";
  validationIssue?: ValidationIssue;
  explanation?: string;
}

interface Preview {
  fields?: ExtractedField[];
}

export default pattern<{
  inputFields: ExtractedField[];
  fieldCheckStates: Record<string, boolean>;
  showPreview: boolean;
}>((state) => {
  const preview = computed((): Preview | null => ({ fields: state.inputFields }));

  return {
    [UI]: (
      <div>
        {ifElse(
          state.showPreview,
          <div>
            {preview?.fields?.map((f: ExtractedField, idx: number) => {
              const fieldKey = f.targetModule + "." + f.fieldName;
              const isChecked = state.fieldCheckStates[fieldKey] === true;
              const confidenceBg = f.confidenceLevel === "high"
                ? "#dcfce7"
                : f.confidenceLevel === "medium"
                ? "#fef9c3"
                : f.confidenceLevel === "low"
                ? "#fee2e2"
                : "transparent";
              const confidenceColor = f.confidenceLevel === "high"
                ? "#166534"
                : f.confidenceLevel === "medium"
                ? "#854d0e"
                : f.confidenceLevel === "low"
                ? "#991b1b"
                : "#6b7280";
              const confidenceIcon = f.confidenceLevel === "high"
                ? "✓"
                : f.confidenceLevel === "medium"
                ? "~"
                : f.confidenceLevel === "low"
                ? "!"
                : "";
              const confidenceLabel = f.confidenceLevel === "high"
                ? "High"
                : f.confidenceLevel === "medium"
                ? "Med"
                : f.confidenceLevel === "low"
                ? "Low"
                : "";
              const hasConfidence = f.confidenceLevel !== undefined;

              return (
                <div key={idx} style={{ opacity: isChecked ? 1 : 0.6 }}>
                  {ifElse(
                    hasConfidence,
                    <span style={{ background: confidenceBg, color: confidenceColor }}>
                      {confidenceIcon} {confidenceLabel}
                    </span>,
                    null,
                  )}
                  {ifElse(
                    f.validationIssue !== undefined,
                    <span
                      style={{
                        background: f.validationIssue?.severity === "error"
                          ? "#fee2e2"
                          : "#fef3c7",
                        color: f.validationIssue?.severity === "error"
                          ? "#991b1b"
                          : "#92400e",
                      }}
                    >
                      {f.validationIssue?.message}
                    </span>,
                    null,
                  )}
                  {ifElse(
                    f.explanation !== undefined && f.explanation !== "",
                    <div>{f.explanation}</div>,
                    null,
                  )}
                </div>
              );
            })}
          </div>,
          null,
        )}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    // After CT-1644 Phase 2, the synthesized predicate wrapper is hoisted to a
    // module-scope const and applied at the call site:
    //   const __cfLift_N = __cfHelpers.lift(
    //     argSchema, resSchema, ({ f }) => f.validationIssue !== undefined);
    //   ...__cfLift_N({ f: { validationIssue: f.key("validationIssue") } })
    // Find the lift decl whose callback is the validationIssue predicate, then
    // assert the same hoisted id is applied with the `f` validationIssue
    // capture as its input.
    const root = parseModule(output);

    // A `something !== undefined` test on a `.validationIssue` access.
    const isValidationPredicate = (node: ts.Node): boolean => {
      if (!ts.isBinaryExpression(node)) return false;
      if (
        node.operatorToken.kind !==
          ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) return false;
      const left = node.left;
      const right = node.right;
      const isValidationAccess = ts.isPropertyAccessExpression(left) &&
        left.name.text === "validationIssue";
      const isUndefined = ts.isIdentifier(right) && right.text === "undefined";
      return isValidationAccess && isUndefined;
    };

    const predicateLift = collect(root, ts.isVariableDeclaration).find(
      (decl) => {
        if (!ts.isIdentifier(decl.name)) return false;
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) {
          return false;
        }
        const callee = decl.initializer.expression;
        const isLift = ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "lift";
        if (!isLift) return false;
        return decl.initializer.arguments.some((arg) =>
          ts.isArrowFunction(arg) && !ts.isBlock(arg.body) &&
          isValidationPredicate(arg.body)
        );
      },
    );
    assert(
      predicateLift && ts.isIdentifier(predicateLift.name),
      "expected a hoisted lift decl owning the validationIssue predicate",
    );
    const validationLiftId = (predicateLift.name as ts.Identifier).text;

    // The hoisted lift is applied with `{ f: { validationIssue: <read> } }`.
    const applied = callsNamed(root, validationLiftId).find((call) => {
      const arg = call.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
      const fProp = arg.properties.find((p) =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) &&
        p.name.text === "f"
      );
      if (!fProp || !ts.isPropertyAssignment(fProp)) return false;
      const fValue = fProp.initializer;
      if (!ts.isObjectLiteralExpression(fValue)) return false;
      return fValue.properties.some((p) =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) &&
        p.name.text === "validationIssue"
      );
    });
    assert(
      applied,
      "expected the hoisted lift applied with the f validationIssue capture",
    );
  },
);

Deno.test(
  "Pipeline regression: dynamic key access in helper-owned map callback initializer lowers without computation diagnostics",
  async () => {
    const source =
      `import { computed, ifElse, pattern, UI } from "commonfabric";

interface Field {
  targetModule: string;
  fieldName: string;
}

export default pattern<{
  inputFields: Field[];
  showPreview: boolean;
}>((state) => {
  const preview = computed(() => ({ fields: state.inputFields }));
  const fieldCheckStates = computed((): Record<string, boolean> => ({
    "record-title.name": true,
  }));

  return {
    [UI]: ifElse(
      state.showPreview,
      <div>
        {preview?.fields?.map((f: Field) => {
          const fieldKey = f.targetModule + "." + f.fieldName;
          const isChecked = fieldCheckStates[fieldKey] === true;
          return <span>{isChecked}</span>;
        })}
      </div>,
      null,
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    const root = parseModule(output);

    assert(
      callsNamed(root, "mapWithPattern").length >= 1,
      "expected a mapWithPattern call",
    );

    // `fieldCheckStates[fieldKey] === true` — a strict-equality test whose left
    // side reads element `[fieldKey]` off `fieldCheckStates`.
    const isFieldCheckEquality = (node: ts.Node): boolean => {
      if (!ts.isBinaryExpression(node)) return false;
      if (
        node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      ) return false;
      const left = node.left;
      return ts.isElementAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "fieldCheckStates" &&
        ts.isIdentifier(left.argumentExpression) &&
        left.argumentExpression.text === "fieldKey" &&
        node.right.kind === ts.SyntaxKind.TrueKeyword;
    };

    // The equality survives as an extracted arrow body, not an eager local.
    assert(
      collect(root, ts.isArrowFunction).some((arrow) =>
        !ts.isBlock(arrow.body) && isFieldCheckEquality(arrow.body)
      ),
      "expected the fieldCheckStates equality to lower into an arrow body",
    );
    assert(
      !collect(root, ts.isVariableDeclaration).some((decl) =>
        ts.isIdentifier(decl.name) && decl.name.text === "isChecked" &&
        decl.initializer !== undefined &&
        isFieldCheckEquality(decl.initializer)
      ),
      "expected no eager `const isChecked = fieldCheckStates[fieldKey] === true`",
    );
  },
);

Deno.test(
  "Pipeline regression: self-improving classifier examples map keeps examples capture",
  async () => {
    const source = await Deno.readTextFile(
      new URL("../../patterns/self-improving-classifier.tsx", import.meta.url),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    assert(
      callsNamed(root, "mapWithPattern").some((call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "examples"
      ),
      "expected transformed examples.mapWithPattern call site",
    );

    // CT-1655: the whole `pattern(...)` call for this map is hoisted to a
    // module-scope `const __cfPattern_N = __cfHelpers.pattern(...)`, so the
    // callback (and its `__cf_pattern_input.key("params", …)` prologue) now
    // lives at module scope, ABOVE the `examples.mapWithPattern(__cfPattern_N,
    // …)` call site rather than inline at it. The property this test guards is
    // unchanged: the examples capture's params-keyed prologue survives the
    // pipeline.
    // `const <name> = __cf_pattern_input.key("params", "<seg>")`.
    const hasParamsPrologue = (name: string, seg: string): boolean =>
      collect(root, ts.isVariableDeclaration).some((decl) => {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name) {
          return false;
        }
        const init = decl.initializer;
        if (!init || !ts.isCallExpression(init)) return false;
        const callee = init.expression;
        if (
          !ts.isPropertyAccessExpression(callee) ||
          callee.name.text !== "key" ||
          !ts.isIdentifier(callee.expression) ||
          callee.expression.text !== "__cf_pattern_input"
        ) return false;
        const args = init.arguments.map((a) =>
          ts.isStringLiteralLike(a) ? a.text : undefined
        );
        return args[0] === "params" && args[1] === seg;
      });

    assert(
      hasParamsPrologue("selectedExampleId", "selectedExampleId"),
      "expected selectedExampleId params-keyed prologue",
    );
    assert(
      hasParamsPrologue("currentItem", "currentItem"),
      "expected currentItem params-keyed prologue",
    );
    assert(
      hasParamsPrologue("examples", "examples"),
      "expected examples params-keyed prologue",
    );
  },
);

Deno.test(
  "Pipeline regression: shopping-list sorted ifElse branch does not wrap mapped results in derive",
  async () => {
    const source = await Deno.readTextFile(
      new URL("../../patterns/shopping-list.tsx", import.meta.url),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    assert(
      callsNamed(root, "mapWithPattern").some((call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "itemsWithAisles"
      ),
      "expected itemsWithAisles.mapWithPattern call site",
    );
    // No emitted schema requires the whole branch's captures, which would mean
    // the branch got wrapped in a single derive rather than staying
    // pattern-lowered.
    const wholeBranchRequired = [
      "itemsWithAisles",
      "items",
      "correctionIndex",
      "correctionTitle",
      "hasConnectedStore",
    ];
    assert(
      !emittedSchemas(root).some((schema) =>
        Array.isArray(schema.required) &&
        JSON.stringify(schema.required) === JSON.stringify(wholeBranchRequired)
      ),
      "expected shopping-list sorted branch to stay pattern-lowered instead of wrapping the whole branch in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: imported pattern factory calls with local cells stay structural",
  async () => {
    const source =
      `import { Writable, pattern, type PatternFactory } from "commonfabric";

declare const Child: PatternFactory<{ value: number }, { value: number }>;

export default pattern(() => {
  const value = Writable.of<number>(1);
  const child = Child({ value });

  return {
    childValue: child.key("value"),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // `const child = Child({ value })` stays a plain structural call.
    const childCall = callsNamed(root, "Child").find((call) =>
      call.parent && ts.isVariableDeclaration(call.parent) &&
      ts.isIdentifier(call.parent.name) && call.parent.name.text === "child"
    );
    assert(childCall, "expected `const child = Child(...)`");
    // `childValue: child.key("value")` — a `.key("value")` read on `child`.
    assert(
      hasKeyPathRead(root, "value", "child"),
      'expected childValue to read child.key("value")',
    );
    // The Child call is not nested inside any derive call.
    assert(
      !callsNamed(root, "Child").some((call) =>
        isInsideCallNamed(call, "derive")
      ),
      "expected pattern factory invocation to stay structural instead of being wrapped in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: mapped pattern factory calls with element fields stay structural",
  async () => {
    const source = `import { UI, pattern, type VNode } from "commonfabric";

type Entry = {
  piece: any;
  name: string;
  backlinks: any[];
};

const EntryRow = pattern<Entry, { [UI]: VNode }>(({ piece, backlinks }) => ({
  [UI]: <div>{piece}{backlinks.length}</div>,
}));

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({
          piece: entry.piece,
          name: entry.name,
          backlinks: entry.backlinks,
        });
        return row[UI];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // `const row = EntryRow({...})` stays structural.
    assert(
      callsNamed(root, "EntryRow").some((call) =>
        call.parent && ts.isVariableDeclaration(call.parent) &&
        ts.isIdentifier(call.parent.name) && call.parent.name.text === "row"
      ),
      "expected `const row = EntryRow(...)`",
    );
    // Element fields lower to `entry.key("<field>")` reactive reads.
    assert(hasKeyPathRead(root, "piece", "entry"));
    assert(hasKeyPathRead(root, "name", "entry"));
    assert(hasKeyPathRead(root, "backlinks", "entry"));
    // CT-1586: row[UI] must lower to row.key(__cfHelpers.UI) in-place,
    // never to a derive wrapper around the [UI] element access. This is
    // the exact ticket repro — without the assertion below, the bug
    // (derive(..., ({row}) => row[__cfHelpers.UI])) would have passed the
    // outer "stays structural" check above unnoticed.
    assert(
      callsNamed(root, "key").some((call) => {
        const callee = call.expression;
        if (
          !ts.isPropertyAccessExpression(callee) ||
          !ts.isIdentifier(callee.expression) ||
          callee.expression.text !== "row"
        ) return false;
        const arg = call.arguments[0];
        return arg !== undefined && ts.isPropertyAccessExpression(arg) &&
          arg.name.text === "UI" && ts.isIdentifier(arg.expression) &&
          arg.expression.text === "__cfHelpers";
      }),
      "expected row.key(__cfHelpers.UI) in-place lowering",
    );
    // The EntryRow call is not nested inside any derive call.
    assert(
      !callsNamed(root, "EntryRow").some((call) =>
        isInsideCallNamed(call, "derive")
      ),
      "expected mapped pattern factory invocation to stay structural instead of being wrapped in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: plain callables that lack pattern-factory shape are not classified as opaque-origin calls (CT-1586 boundary)",
  async () => {
    // CT-1586 extended `isOpaqueOriginCall` to recognize structural pattern
    // factories via `isPatternFactoryCalleeExpression`, which requires the
    // callee type to expose both `argumentSchema` and `resultSchema`
    // properties (and NOT `with`). A plain user-authored helper that
    // returns a regular value should NOT trip the new gate.
    //
    // The call itself must therefore be wrapped in derive(...) when used
    // inside a reactive context — that's the pre-existing behavior for
    // non-opaque-origin calls. If `isPatternFactoryCalleeExpression`
    // started false-positively matching plain helpers (e.g. due to type
    // widening), we'd see the plainHelper call land structurally instead
    // of being derive-wrapped. This test locks in the boundary.
    const source = `import { pattern, UI, type VNode } from "commonfabric";

interface Entry { piece: string }

function plainHelper(input: { piece: string }): { rendered: string; [UI]: string } {
  return { rendered: input.piece, [UI]: input.piece };
}

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = plainHelper({ piece: entry.piece });
        return row[UI];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // The plain helper call is preserved.
    const plainHelperCalls = callsNamed(root, "plainHelper");
    assert(plainHelperCalls.length >= 1, "expected a plainHelper call");
    // Because plainHelper is NOT classified as opaque-origin, its result is
    // wrapped in a synthetic reactive compute — the call moves into an
    // extracted callback arrow whose enclosing context is a `lift`/`derive`
    // application, rather than staying at `const row = plainHelper(...)`. If
    // isPatternFactoryCalleeExpression matched it, the call would land
    // structurally as a direct `row` initializer with no surrounding compute.
    assert(
      plainHelperCalls.some((call) => isInsideExtractedComputeCallback(call)),
      "expected plainHelper call to be wrapped in a reactive compute — non-opaque-origin calls must NOT be treated as pattern factories",
    );
    assert(
      !plainHelperCalls.some((call) =>
        call.parent && ts.isVariableDeclaration(call.parent) &&
        ts.isIdentifier(call.parent.name) && call.parent.name.text === "row"
      ),
      "expected no structural `const row = plainHelper(...)`",
    );
  },
);

Deno.test(
  "Pipeline regression: dynamic key access on pattern-factory result still wraps in derive (CT-1586 boundary)",
  async () => {
    // After CT-1586, well-known CF computed keys (UI/NAME/SELF/FS) lower
    // to `.key()` in-place even when the access lives inside a JSX slot.
    // But genuinely-dynamic key access — where the argument resolves to a
    // value that isn't a static path segment — must STILL go through the
    // dynamic-wrap (derive) path. The reorder in pattern-body-reactive-
    // root-lowering is gated on `info?.root && !info.dynamic`; this test
    // exercises the `info.dynamic === true` branch to lock in that
    // boundary.
    const source = `import { pattern, UI, type VNode } from "commonfabric";

type Entry = { piece: string; fieldName: string };
type Row = Record<string, string> & { [UI]: VNode };

const EntryRow = pattern<Entry, Row>(({ piece }) => ({
  [UI]: <span>{piece}</span>,
  body: piece,
}));

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({ piece: entry.piece, fieldName: entry.fieldName });
        // Dynamic key — entry.fieldName is a reactive string, not a known
        // static path segment.
        return row[entry.fieldName.toString()];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // The pattern-factory call itself still stays structural.
    assert(
      callsNamed(root, "EntryRow").some((call) =>
        call.parent && ts.isVariableDeclaration(call.parent) &&
        ts.isIdentifier(call.parent.name) && call.parent.name.text === "row"
      ),
      "expected `const row = EntryRow(...)`",
    );
    // The dynamic access should NOT have lowered to `.key()` — `.key()` is
    // only valid for known-static path segments. The dynamic-wrap path
    // is responsible for this case. No `row.key(entry.…)`.
    assert(
      !callsNamed(root, "key").some((call) => {
        const callee = call.expression;
        if (
          !ts.isPropertyAccessExpression(callee) ||
          !ts.isIdentifier(callee.expression) ||
          callee.expression.text !== "row"
        ) return false;
        const arg = call.arguments[0];
        return arg !== undefined && ts.isPropertyAccessExpression(arg) &&
          ts.isIdentifier(arg.expression) && arg.expression.text === "entry";
      }),
      "expected dynamic key access not to lower to row.key(entry.…)",
    );
  },
);

Deno.test(
  "Pipeline regression: module-scope sub-pattern calls in maps stay structural",
  async () => {
    const source = `import { pattern, UI, type VNode } from "commonfabric";

type Entry = { value: number };

const EntryRow = pattern<Entry, { [UI]: VNode }>(({ value }) => ({
  [UI]: <span>{value}</span>,
}));

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({ value: entry.value });
        return row[UI];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    assert(
      callsNamed(root, "EntryRow").some((call) =>
        call.parent && ts.isVariableDeclaration(call.parent) &&
        ts.isIdentifier(call.parent.name) && call.parent.name.text === "row"
      ),
      "expected `const row = EntryRow(...)`",
    );
    // No `EntryRow: EntryRow` capture property — the module-scope factory must
    // stay in lexical scope, not be threaded through derive data.
    assert(
      !collect(root, ts.isPropertyAssignment).some((prop) =>
        ts.isIdentifier(prop.name) && prop.name.text === "EntryRow" &&
        ts.isIdentifier(prop.initializer) &&
        prop.initializer.text === "EntryRow"
      ),
      "expected module-scope pattern factory to stay in lexical scope instead of being captured as derive data",
    );
  },
);

Deno.test(
  "Pipeline regression: opaque-returning factory helpers with local cells stay structural",
  async () => {
    const source = `import { pattern, Writable } from "commonfabric";

function createAuthManager(input: { accountType: string }) {
  return pattern<{ accountType: string }, {
    auth: { email: string };
    fullUI: string;
  }>(({ accountType }) => ({
    auth: { email: accountType },
    fullUI: accountType,
  }))(input);
}

export default pattern(() => {
  const selectedAccountType = Writable.of<string>("default");
  const authManager = createAuthManager({
    accountType: selectedAccountType,
  });

  return {
    auth: authManager.key("auth"),
    ui: authManager.key("fullUI"),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // `const authManager = createAuthManager({ accountType: selectedAccountType })`.
    const factoryCall = callsNamed(root, "createAuthManager").find((call) =>
      call.parent && ts.isVariableDeclaration(call.parent) &&
      ts.isIdentifier(call.parent.name) &&
      call.parent.name.text === "authManager"
    );
    assert(
      factoryCall,
      "expected `const authManager = createAuthManager(...)`",
    );
    const arg = factoryCall.arguments[0];
    assert(
      arg && ts.isObjectLiteralExpression(arg) &&
        arg.properties.some((prop) =>
          ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
          prop.name.text === "accountType" &&
          ts.isIdentifier(prop.initializer) &&
          prop.initializer.text === "selectedAccountType"
        ),
      "expected accountType: selectedAccountType argument",
    );
    // The factory call is not nested inside any derive call.
    assert(
      !callsNamed(root, "createAuthManager").some((call) =>
        isInsideCallNamed(call, "derive")
      ),
      "expected opaque-returning factory helper to stay structural instead of being wrapped in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: computed callbacks that rely on contextual typing still receive injected schemas",
  async () => {
    const source = `import { computed, pattern } from "commonfabric";

const summarize = (values: string[]) => values.length;

export default pattern<{ values: string[] }>(({ values }) => {
  const result = computed(() => summarize(values.get()));
  return { result };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    // computed(() => summarize(values.get())) closure-extracts `values` and
    // lowers to a hoisted lift; after CT-1644 Phase 2 the call site applies
    // the hoisted const: const result = __cfLift_N({ values: values }).for(...)
    const resultDecl = collect(root, ts.isVariableDeclaration).find((decl) =>
      ts.isIdentifier(decl.name) && decl.name.text === "result"
    );
    assert(resultDecl?.initializer, "expected a result declaration");
    const forCall = resultDecl.initializer;
    assert(
      ts.isCallExpression(forCall) &&
        ts.isPropertyAccessExpression(forCall.expression) &&
        forCall.expression.name.text === "for",
      "expected result to bind a `.for(...)` call",
    );
    assertEquals(
      forCall.arguments.map((a) => literalToValue(a)),
      ["result", true],
    );
    // The `.for` receiver applies a hoisted lift with `{ values: values }`.
    const liftApply = forCall.expression.expression;
    assert(
      ts.isCallExpression(liftApply) && ts.isIdentifier(liftApply.expression) &&
        /^__cfLift_h[0-9a-f]+(?:_\d+)?$/.test(liftApply.expression.text),
      "expected the .for receiver to be a hoisted __cfLift_N application",
    );
    const liftArg = liftApply.arguments[0];
    assert(
      liftArg && ts.isObjectLiteralExpression(liftArg) &&
        liftArg.properties.some((prop) =>
          (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
            prop.name.text === "values" &&
            ts.isIdentifier(prop.initializer) &&
            prop.initializer.text === "values") ||
          (ts.isShorthandPropertyAssignment(prop) &&
            prop.name.text === "values")
        ),
      "expected the hoisted lift applied with the `values` capture",
    );
  },
);

Deno.test(
  "Pipeline regression: local concise ternary event handlers stay function-valued",
  async () => {
    const source =
      `import { computed, handler, pattern, UI, Writable } from "commonfabric";

interface Item {
  id: string;
}

interface Vote {
  itemId: string;
  vote: "yes" | "no";
}

const castVote = handler<{ itemId: string; vote: "yes" }, { votes: Writable<Vote[]> }>(
  (event, { votes }) => {
    votes.push(event);
  },
);

const clearVote = handler<{ itemId: string }, {}>(() => {});

export default pattern<{ items: Writable<Item[]>; votes: Writable<Vote[]> }>(
  ({ items, votes }) => {
    const boundCastVote = castVote({ votes });
    const boundClearVote = clearVote({});

    return {
      [UI]: (
        <div>
          {items.map((item) => {
            const iid = item.id;
            const myVote = computed(() =>
              votes.get().find((vote) => vote.itemId === iid)?.vote
            );

            const onVoteYes = () =>
              myVote === "yes"
                ? boundClearVote.send({ itemId: iid })
                : boundCastVote.send({ itemId: iid, vote: "yes" });

            return <cf-button onClick={onVoteYes}>yes</cf-button>;
          })}
        </div>
      ),
    };
  },
);
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    const onVoteYesDecl = collect(root, ts.isVariableDeclaration).find((decl) =>
      ts.isIdentifier(decl.name) && decl.name.text === "onVoteYes"
    );
    assert(onVoteYesDecl?.initializer, "expected an onVoteYes declaration");

    // The handler stays function-valued: a plain arrow whose body is the
    // imperative ternary `myVote === "yes" ? … : …`.
    const arrow = onVoteYesDecl.initializer;
    assert(
      ts.isArrowFunction(arrow),
      "local event handler variable must stay a plain arrow function",
    );
    const ternary = ts.isParenthesizedExpression(arrow.body)
      ? arrow.body.expression
      : arrow.body;
    assert(
      ts.isConditionalExpression(ternary) &&
        ts.isBinaryExpression(ternary.condition) &&
        ts.isIdentifier(ternary.condition.left) &&
        ternary.condition.left.text === "myVote" &&
        ternary.condition.operatorToken.kind ===
          ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isStringLiteralLike(ternary.condition.right) &&
        ternary.condition.right.text === "yes",
      'expected the handler body to be the `myVote === "yes"` ternary',
    );

    // Both branches keep their `.send({...})` calls. The `iid` argument is a
    // reactive identifier, so assert on the property shape rather than
    // evaluating the object literal.
    const sendCallOn = (receiver: string): ts.CallExpression | undefined =>
      callsNamed(root, "send").find((call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === receiver
      );
    const propNames = (call: ts.CallExpression): string[] => {
      const arg = call.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return [];
      return arg.properties.flatMap((prop) =>
        prop.name && ts.isIdentifier(prop.name) ? [prop.name.text] : []
      );
    };
    const itemIdReadsIid = (call: ts.CallExpression): boolean => {
      const arg = call.arguments[0] as ts.ObjectLiteralExpression;
      return arg.properties.some((prop) =>
        ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === "itemId" && ts.isIdentifier(prop.initializer) &&
        prop.initializer.text === "iid"
      );
    };
    const clearSend = sendCallOn("boundClearVote");
    assert(clearSend, "expected boundClearVote.send(...)");
    assertEquals(propNames(clearSend), ["itemId"]);
    assert(
      itemIdReadsIid(clearSend),
      "expected boundClearVote.send itemId: iid",
    );
    const castSend = sendCallOn("boundCastVote");
    assert(castSend, "expected boundCastVote.send(...)");
    assertEquals(propNames(castSend), ["itemId", "vote"]);
    assert(itemIdReadsIid(castSend), "expected boundCastVote.send itemId: iid");
    const castVoteProp = (castSend.arguments[0] as ts.ObjectLiteralExpression)
      .properties.find((prop) =>
        ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === "vote"
      );
    assert(
      castVoteProp && ts.isPropertyAssignment(castVoteProp) &&
        ts.isStringLiteralLike(castVoteProp.initializer) &&
        castVoteProp.initializer.text === "yes",
      'expected boundCastVote.send vote: "yes"',
    );

    // After CT-1644 Phase 2 a genuinely reactive computed lowers to a hoisted
    // lift whose call site is `const onVoteYes = __cfLift_N(...)`. The local
    // event handler must stay a plain arrow, so its initializer is not a
    // lift application.
    assert(
      !ts.isCallExpression(arrow),
      "local event handler variable must not become a reactive cell containing a function",
    );
    // The handler body contains no ifElse lowering.
    assert(
      callsNamed(root, "ifElse").length === 0,
      "local event handler body must keep imperative ternary semantics",
    );
  },
);

Deno.test(
  "Pipeline regression: helper-owned IIFE local cell reads lower before use",
  async () => {
    const source = `import { pattern, UI, Writable } from "commonfabric";

export default pattern<{ enabled: Writable<boolean> }>(({ enabled }) => ({
  [UI]: <div>{(() => {
    const raw = enabled.get();
    return typeof raw === "boolean" ? raw : true;
  })()}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);
    // The eager `const raw = enabled.get()` read must not survive.
    assert(
      !collect(root, ts.isVariableDeclaration).some((decl) => {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== "raw") {
          return false;
        }
        const init = decl.initializer;
        return init !== undefined && ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          init.expression.name.text === "get" &&
          ts.isIdentifier(init.expression.expression) &&
          init.expression.expression.text === "enabled";
      }),
      "expected the eager cell read to be lowered into a derive before the IIFE body uses it",
    );
    // A derive arrow `({ enabled }) => enabled.get()` takes over the read.
    assert(
      collect(root, ts.isArrowFunction).some((arrow) => {
        const param = arrow.parameters[0];
        const hasEnabledBinding = param !== undefined &&
          ts.isObjectBindingPattern(param.name) &&
          param.name.elements.some((el) =>
            ts.isIdentifier(el.name) && el.name.text === "enabled"
          );
        if (!hasEnabledBinding || ts.isBlock(arrow.body)) return false;
        const body = arrow.body;
        return ts.isCallExpression(body) &&
          ts.isPropertyAccessExpression(body.expression) &&
          body.expression.name.text === "get" &&
          ts.isIdentifier(body.expression.expression) &&
          body.expression.expression.text === "enabled";
      }),
      "expected a derive arrow `({ enabled }) => enabled.get()`",
    );
  },
);

Deno.test(
  "Pipeline regression: nullable computed capture keeps source array schema array-shaped",
  async () => {
    const source = `import { computed, pattern, UI } from "commonfabric";

interface Option {
  title: string;
  ignored: string;
}

export default pattern<{ options: Option[] }, { [UI]: any }>(({ options }) => {
  const minimalNullable = computed(() =>
    options.length > 0 ? options[0].title : null
  );

  return {
    [UI]: (
      <div>
        {computed(() => {
          const value = minimalNullable;
          return <span>{value ?? "null"}</span>;
        })}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // computed(() => options.length > 0 ? options[0].title : null) closure-
    // extracts `options` and lowers to a hoisted lift. After CT-1644 Phase 2
    // the schema-bearing decl is `const __cfLift_N = __cfHelpers.lift(cb,
    // argSchema, resSchema)` and the call site applies it to `{ options }`.
    const root = parseModule(output);
    const { argSchema, resSchema } = liftSchemasFor(root, "minimalNullable");

    // Input schema keeps `options` array-shaped with object items carrying
    // `title` — never shrunk to an object with numeric string keys.
    const options = (argSchema.properties as Record<string, unknown>)
      .options as Record<string, unknown>;
    assertEquals(options.type, "array");
    const items = options.items as Record<string, unknown>;
    assertEquals(items.type, "object");
    assertEquals(
      ((items.properties as Record<string, unknown>).title as Record<
        string,
        unknown
      >).type,
      "string",
    );
    assert(
      !("0" in (items.properties as Record<string, unknown>)),
      "expected array items schema not to shrink to numeric-key object",
    );
    assert(
      !Array.isArray(options.required) ||
        !(options.required as string[]).includes("0"),
      "expected the input schema not to require object-style array members",
    );

    // Result schema is the nullable `string | null` produced by the ternary.
    const resultTypes = collectSchemaTypes(resSchema);
    assert(
      resultTypes.includes("null"),
      "expected the nullable result schema to admit null",
    );
  },
);

Deno.test(
  "Pipeline regression: computed captures preserve destructured PerUser defaults",
  async () => {
    const source =
      `import { computed, Default, NAME, pattern, type PerSpace, type PerUser, UI, type VNode } from "commonfabric";

const trimmedName = (name: string | undefined) => (name ?? "").trim();

interface Input {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  myName?: PerUser<string | Default<"">>;
}

export default pattern<Input, { [NAME]: string; [UI]: VNode }>(({ question, ["myName"]: displayName }) => ({
  [NAME]: "ct-1606",
  [UI]: (
    <cf-screen>
      <div slot="header">
        <h2>{question}</h2>
        {computed(() => {
          const value = trimmedName(displayName);
          return <div>me is: "{value}"</div>;
        })}
      </div>
      <div>body renders</div>
    </cf-screen>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1644 Phase 2, computed() lowers to a hoisted lift carrying the
    // capture's input schema; it is the first __cfHelpers.lift( in the module.
    const root = parseModule(output);
    const argSchema = firstLiftArgSchema(root);

    // The destructured `displayName` capture keeps its PerUser string default.
    const displayName = (argSchema.properties as Record<string, unknown>)
      .displayName as Record<
        string,
        unknown
      >;
    assert(displayName, "expected displayName in the lift argument schema");
    assertEquals(displayName.type, "string");
    assertEquals(displayName["default"], "");
    assertEquals(displayName.scope, "user");
  },
);

Deno.test(
  "Pipeline regression: computed captures preserve destructured Writable defaults",
  async () => {
    const source =
      `import { computed, Default, NAME, pattern, UI, type VNode, type Writable } from "commonfabric";

interface Input {
  draftTitle: Writable<string | Default<"">>;
}

export default pattern<Input, { [NAME]: string; [UI]: VNode }>(({ draftTitle }) => ({
  [NAME]: "writable-default-capture",
  [UI]: <div>{computed(() => <span>{draftTitle}</span>)}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1644 Phase 2, computed() lowers to a hoisted lift whose decl is
    // the first __cfHelpers.lift( in the module.
    const root = parseModule(output);
    const argSchema = firstLiftArgSchema(root);

    const draftTitle = (argSchema.properties as Record<string, unknown>)
      .draftTitle as Record<
        string,
        unknown
      >;
    assert(draftTitle, "expected draftTitle in the lift argument schema");
    assertEquals(draftTitle.type, "string");
    assertEquals(draftTitle["default"], "");
    assert(
      Array.isArray(draftTitle.asCell),
      "expected the Writable capture to carry an asCell descriptor",
    );
  },
);

Deno.test(
  "Pipeline regression: computed captures preserve Writable Record defaults without orphan refs",
  async () => {
    const source =
      `import { computed, Default, NAME, pattern, UI, type VNode, type Writable } from "commonfabric";

interface Input {
  selections: Writable<Record<string, boolean> | Default<Record<string, never>>>;
}

export default pattern<Input, { [NAME]: string; [UI]: VNode }>(({ selections }) => ({
  [NAME]: "writable-record-default-capture",
  [UI]: <div>{computed(() => selections.foo ? "yes" : "no")}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1644 Phase 2, computed() lowers to a hoisted lift whose decl is
    // the first __cfHelpers.lift( in the module.
    const root = parseModule(output);
    const argSchema = firstLiftArgSchema(root);

    assert(
      "selections" in (argSchema.properties as Record<string, unknown>),
      "expected selections in the lift argument schema",
    );
    // No orphan anonymous-type ref anywhere in the evaluated schema.
    const hasAnonymousRef = (value: unknown): boolean => {
      if (typeof value === "string") return value.includes("AnonymousType_");
      if (Array.isArray(value)) return value.some(hasAnonymousRef);
      if (value && typeof value === "object") {
        return Object.values(value).some(hasAnonymousRef);
      }
      return false;
    };
    assert(
      !hasAnonymousRef(argSchema),
      "expected Writable<Record<...Default...>> capture not to emit orphan anonymous refs",
    );
  },
);

Deno.test(
  "Pipeline regression: side-writing computed marks writable inputs for materialization",
  async () => {
    const source =
      `import { computed, pattern, type Writable } from "commonfabric";

interface Input {
  departments: Writable<string[]>;
}

export default pattern<Input>(({ departments }) => {
  const init = computed(() => {
    if (departments.get().length === 0) departments.set(["Bakery"]);
    return true;
  });
  return { init };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1644 Phase 2 the materializer options live in the hoisted decl
    // `const __cfLift_N = __cfHelpers.lift(cb, argSchema, resSchema, options)`;
    // the call site is `const init = __cfLift_N(...)`. The options are the last
    // argument, a plain object literal (not a JSONSchema).
    const root = parseModule(output);
    const liftCall = liftCallFor(root, "init");
    const optionsArg = liftCall.arguments.at(-1)!;
    assert(
      ts.isObjectLiteralExpression(optionsArg),
      "expected a trailing materializer options object",
    );
    const options = literalToValue(optionsArg) as Record<string, unknown>;
    assertEquals(options.materializerWriteInputPaths, [["departments"]]);
  },
);

Deno.test(
  "Pipeline regression: complete source lifts emit scheduler scope proof including proven-empty",
  async () => {
    const source = `import { computed, pattern } from "commonfabric";

export default pattern<{ value: number }>(({ value }) => {
  const incremented = computed(() => value + 1);
  const constant = computed(() => 42);
  return { incremented, constant };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);
    assertEquals(
      schedulerOptionsFor(liftCallFor(root, "incremented"))
        ?.completeSchedulerScopeSummary,
      true,
    );
    assertEquals(
      schedulerOptionsFor(liftCallFor(root, "constant"))
        ?.completeSchedulerScopeSummary,
      true,
    );
  },
);

Deno.test(
  "Pipeline regression: uncertain source lifts do not emit scheduler scope proof",
  async () => {
    const source = `import { computed, pattern } from "commonfabric";

export default pattern<{ value: Record<string, string>; key: string }>(
  ({ value, key }) => {
    const dynamic = computed(() => value[key]);
    return { dynamic };
  },
);
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);
    assertEquals(
      schedulerOptionsFor(liftCallFor(root, "dynamic"))
        ?.completeSchedulerScopeSummary,
      undefined,
    );
  },
);

Deno.test(
  "Pipeline regression: uncertain writers keep materializer paths without scope proof",
  async () => {
    const source =
      `import { computed, pattern, type Writable } from "commonfabric";

interface Input {
  departments: Writable<string[]>;
  values: Record<string, string>;
  key: string;
}

export default pattern<Input>(({ departments, values, key }) => {
  const dynamicWriter = computed(() => {
    departments.set(["Bakery"]);
    return values[key];
  });
  return { dynamicWriter };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const options = schedulerOptionsFor(
      liftCallFor(parseModule(output), "dynamicWriter"),
    );
    assertEquals(options?.materializerWriteInputPaths, [["departments"]]);
    assertEquals(options?.completeSchedulerScopeSummary, undefined);
  },
);

Deno.test(
  "Pipeline regression: unreadable cell arguments do not emit scheduler scope proof",
  async () => {
    const source = `import { lift, pattern, type Writable } from "commonfabric";
import { sendMixed, type Auth } from "ambiguous-clients";

export default pattern<{ auth: Writable<Auth>; marker: boolean }>(
  ({ auth, marker }) => {
    const sent = lift((candidate: Writable<Auth>) => {
      sendMixed(candidate);
      return marker;
    })(auth);
    return { sent };
  },
);
`;

    const output = await transformSource(source, {
      types: {
        ...COMMONFABRIC_TYPES,
        "ambiguous-clients.d.ts": `declare module "ambiguous-clients" {
  import type { Writable } from "commonfabric";
  export type Auth = { token: string };
  export interface AuthCell {
    get(): Auth | undefined;
    update(values: { token?: string }): void;
  }
  export function sendMixed(auth: AuthCell | Writable<Auth>): void;
}`,
      },
    });
    assertEquals(
      schedulerOptionsFor(liftCallFor(parseModule(output), "sent"))
        ?.completeSchedulerScopeSummary,
      undefined,
    );
  },
);

Deno.test(
  "Pipeline regression: readonly computed does not mark writable-looking inputs for materialization",
  async () => {
    const source =
      `import { computed, pattern, type Writable } from "commonfabric";

interface Input {
  departments: Writable<string[]>;
}

export default pattern<Input>(({ departments }) => {
  const count = computed(() => departments.get().length);
  return { count };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1644 Phase 2 the schema/options live in the hoisted decl
    // `const __cfLift_N = __cfHelpers.lift(...)`; the call site is
    // `const count = __cfLift_N(...)`. A readonly computation carries no
    // materializer options, so no lift argument mentions
    // materializerWriteInputPaths.
    const root = parseModule(output);
    const liftCall = liftCallFor(root, "count");
    const hasMaterializerKey = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(hasMaterializerKey);
      if (value && typeof value === "object") {
        return Object.keys(value).includes("materializerWriteInputPaths") ||
          Object.values(value).some(hasMaterializerKey);
      }
      return false;
    };
    assert(
      !liftCall.arguments.some((arg) => {
        if (
          !ts.isObjectLiteralExpression(arg) && !ts.isSatisfiesExpression(arg)
        ) return false;
        try {
          return hasMaterializerKey(literalToValue(arg));
        } catch {
          return false;
        }
      }),
      "readonly computed() should remain a normal pull computation",
    );
  },
);

Deno.test(
  "Pipeline regression: capture-free computed lowers with a parameterless callback and no materializer options",
  async () => {
    // A computed with NO captures lowers to a lift whose callback has zero
    // parameters — the capability analysis has no first parameter to
    // summarize (lift-applied-strategy's `!parameter` early-out) and must
    // emit no materializer options rather than throwing or fabricating one.
    const source = `import { computed, pattern } from "commonfabric";

interface Input {
  label: string;
}

export default pattern<Input>(({ label }) => {
  const answer = computed(() => 42);
  return { label, answer };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);
    const liftCall = liftCallFor(root, "answer");
    const hasMaterializerKey = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(hasMaterializerKey);
      if (value && typeof value === "object") {
        return Object.keys(value).includes("materializerWriteInputPaths") ||
          Object.values(value).some(hasMaterializerKey);
      }
      return false;
    };
    assert(
      !liftCall.arguments.some((arg) => {
        if (
          !ts.isObjectLiteralExpression(arg) && !ts.isSatisfiesExpression(arg)
        ) return false;
        try {
          return hasMaterializerKey(literalToValue(arg));
        } catch {
          return false;
        }
      }),
      "capture-free computed() should carry no materializer options",
    );
  },
);

Deno.test(
  "Pipeline regression: send-only computed keeps stream paths in write metadata but never brands them collectible",
  async () => {
    const source =
      `import { computed, pattern, type Stream } from "commonfabric";

interface Input {
  items: string[];
  notify: Stream<{ id: string }>;
}

export default pattern<Input>(({ items, notify }) => {
  const banner = computed(() => {
    if (items.get().length > 0) notify.send({ id: "first" });
    return items.get().length;
  });
  return { banner };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);
    const liftCall = liftCallFor(root, "banner");

    // The send path STAYS in the emitted write metadata: the downstream
    // write-exhaustiveness consumer relies on a non-empty record to keep
    // event-firing computeds out of the pure-derivation class (replaying a
    // dropped commit would re-fire the event).
    const optionsArg = liftCall.arguments.at(-1)!;
    assert(
      ts.isObjectLiteralExpression(optionsArg),
      "expected a trailing materializer options object",
    );
    const options = literalToValue(optionsArg) as Record<string, unknown>;
    assertEquals(options.materializerWriteInputPaths, [["notify"]]);

    // ...but the capture keeps its stream brand, so the runner's envelope
    // collector (cell/writeonly only) never materializes an envelope at the
    // stream address: a stream send writes no address — the dispatched
    // handler's writes belong to the handler's own action.
    const argSchema = literalToValue(
      liftCall.arguments[1]!,
    ) as {
      properties?: Record<string, { asCell?: unknown[] }>;
    };
    const notifyBrand = argSchema.properties?.notify?.asCell ?? [];
    assert(
      notifyBrand.includes("stream"),
      `expected stream brand on the sent capture, got ${
        JSON.stringify(notifyBrand)
      }`,
    );
    assert(
      !notifyBrand.includes("cell") && !notifyBrand.includes("writeonly"),
      `stream send must not brand collectible, got ${
        JSON.stringify(notifyBrand)
      }`,
    );
  },
);
