import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  canonicalizeResultOfCaptures,
  guardOperandExposesAvailability,
  parseAvailabilityObservation,
  resolveAvailabilityObservation,
  resolveAvailabilityValueProvenance,
  resolveResultOfSource,
  rewriteResultOfAliasReferences,
  typeContainsAvailabilityVariant,
} from "../src/availability/analysis.ts";
import {
  type AvailabilityCaptureOverride,
  collectAvailabilityGuardCaptures,
  collectExplicitAvailabilityGuardCaptures,
  collectObservedAvailabilityCaptures,
  collectObservedAvailabilityInputPaths,
  mapGuardCapturesToCallbackInput,
  mergeAvailabilityCaptureOverrides,
  parseAvailabilityCaptureExpression,
  partitionGuardCapturesByCallbackInput,
  renameAvailabilityCapturePaths,
} from "../src/availability/captures.ts";
import { AvailabilityAnalysisTransformer } from "../src/availability/transformer.ts";
import { getStableConstAliasInitializer } from "../src/ast/stable-const-alias.ts";
import { getLiftAppliedInputAndCallback } from "../src/ast/call-kind.ts";
import { TransformationContext } from "../src/core/context.ts";
import { CrossStageState } from "../src/core/cross-stage-state.ts";
import {
  planCaptureBindings,
  registerCaptureBindingTypes,
} from "../src/utils/capture-bindings.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

interface TestContext {
  context: TransformationContext;
  sourceFile: ts.SourceFile;
  transformation: ts.TransformationContext;
}

Deno.test("opaque capture type registration preserves a same-named nested local", () => {
  withContext(
    `
    import { type OpaqueCell } from "commonfabric";
    interface Repo { name: string; }
    declare const captured: OpaqueCell<Repo>;
    const callback = () => {
      const outer = captured;
      const nested = () => { const captured = "local"; return captured; };
      return { outer, nested: nested() };
    };
  `,
    ({ context, sourceFile }) => {
      const callback = initializer(sourceFile, "callback");
      if (!ts.isArrowFunction(callback)) {
        throw new Error("Expected the callback");
      }
      const outer = initializer(sourceFile, "outer");
      const bindings = planCaptureBindings(
        [outer],
        callback.body,
        new Map(),
        context,
      );
      const binding = bindings.get("captured");
      expect(binding?.opaque).toBe(true);
      expect(binding?.bindingName).not.toBe("captured");
      expect(binding?.type?.getProperties().map(({ name }) => name)).toEqual([
        "name",
      ]);
      registerCaptureBindingTypes(callback.body, bindings, context);
      expect(context.state.typeRegistry.get(outer)).toBe(binding!.type);
      const nested = initializer(sourceFile, "nested");
      if (!ts.isArrowFunction(nested)) {
        throw new Error(
          "Expected the nested callback",
        );
      }
      const identifiers: ts.Identifier[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === "captured") {
          identifiers
            .push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(nested.body);
      expect(identifiers).toHaveLength(2);
      for (const identifier of identifiers) {
        expect(context.state.typeRegistry.get(identifier)).toBeUndefined();
        expect(
          context.checker.getTypeAtLocation(identifier).flags &
            ts.TypeFlags.StringLiteral,
        )
          .not.toBe(0);
      }
    },
  );
});

Deno.test("static element captures retain exact key-call paths and reject dynamic indices", () => {
  withContext(
    `
    import { type AsyncResult, type Cell, hasError } from "commonfabric";
    declare const input: Cell<{ requests: AsyncResult<{ name: string }>[] }>;
    declare const index: number;
    const first = input.key("requests")[0];
    const named = input.key("requests")["01"];
    const dynamic = input.key("requests")[index];
    const guards = () => hasError(input.key("requests")[0]);
  `,
    ({ context, sourceFile }) => {
      expect(
        parseAvailabilityCaptureExpression(initializer(sourceFile, "first")),
      )
        .toMatchObject({ root: "input", path: ["requests", "0"] });
      expect(
        parseAvailabilityCaptureExpression(initializer(sourceFile, "named")),
      )
        .toMatchObject({ root: "input", path: ["requests", "01"] });
      expect(
        parseAvailabilityCaptureExpression(initializer(sourceFile, "dynamic")),
      )
        .toBeUndefined();
      const guards = initializer(sourceFile, "guards");
      if (!ts.isArrowFunction(guards) || !ts.isExpression(guards.body)) {
        throw new Error(
          "Expected the guard callback",
        );
      }
      expect(collectAvailabilityGuardCaptures(guards.body, context))
        .toMatchObject([{
          path: ["input", "requests", "0"],
          reasons: ["error"],
        }]);
    },
  );
});

Deno.test("generic result fallbacks respect the successful type's nullability", () => {
  for (
    const { constraint, dead } of [
      { constraint: "", dead: false },
      { constraint: " extends Repo", dead: true },
      { constraint: " extends Repo | null", dead: false },
    ]
  ) {
    withContext(
      `
      import { AsyncResult, resultOf } from "commonfabric";
      interface Repo { name: string; }
      function fallback<T${constraint}>(request: AsyncResult<T>) {
        return resultOf(request) ?? null;
      }
    `,
      ({ context }) => {
        new AvailabilityAnalysisTransformer({ state: context.options.state })
          .transform(context);
        expect(
          context.diagnostics.filter((diagnostic) =>
            diagnostic.type === "availability:dead-result-fallback"
          ),
        ).toHaveLength(dead ? 1 : 0);
      },
    );
  }
});

function withContext(source: string, run: (test: TestContext) => void): void {
  const files: Record<string, string> = {
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"],
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(name, files[name]!, languageVersion, true)
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) =>
        name === "commonfabric"
          ? {
            resolvedFileName: "/commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined
      ),
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  const sourceFile = program.getSourceFile("/test.ts")!;
  const state = new CrossStageState();
  let transformation!: ts.TransformationContext;
  const transformed = ts.transform(sourceFile, [
    (context) => {
      transformation = context;
      return (node) => node;
    },
  ]);
  try {
    run({
      context: new TransformationContext({
        program,
        sourceFile,
        tsContext: transformation,
        options: { state },
      }),
      sourceFile,
      transformation,
    });
  } finally {
    transformed.dispose();
  }
}

function variable(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let result: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!result) throw new Error(`Missing variable ${name}`);
  return result;
}

function initializer(sourceFile: ts.SourceFile, name: string): ts.Expression {
  const result = variable(sourceFile, name).initializer;
  if (!result) throw new Error(`Missing initializer ${name}`);
  return result;
}

function functionDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  let result: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) && node.name?.text === name
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!result) throw new Error(`Missing function ${name}`);
  return result;
}

function identifierIn(
  node: ts.Node,
  name: string,
): ts.Identifier {
  let result: ts.Identifier | undefined;
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && current.text === name) {
      result = current;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  if (!result) throw new Error(`Missing identifier ${name}`);
  return result;
}

Deno.test("availability provenance and observations cover retained and invalid forms", () => {
  withContext(
    `
      import {
        AsyncResult,
        HasError,
        SqliteDb,
        compileAndRun,
        fetchJsonUnchecked,
        fetchText,
        generateObject,
        generateObjectStream,
        generateText,
        generateTextStream,
        llmDialog,
        observeAvailability,
        partialResultOf,
        resultOf,
        sqliteQuery,
        wish,
      } from "commonfabric";
      import * as cf from "commonfabric";

      type Repo = { name: string };
      declare function ordinary(value: unknown): { result: unknown };
      const fetched = fetchText({ url: "/repo" });
      const fetchedAny = fetchJsonUnchecked({ url: "/repo" });
      const textGenerated = generateText({ prompt: "repo" });
      const compiled = compileAndRun<unknown, Repo>({
        files: [{ name: "/main.tsx", contents: "export default 1" }],
        main: "/main.tsx",
      });
      const compileAlias = compileAndRun;
      const aliasedCompiled = compileAlias<unknown, Repo>({
        files: [{ name: "/main.tsx", contents: "export default 1" }],
        main: "/main.tsx",
      });
      const namespaceCompiled = cf.compileAndRun<unknown, Repo>({
        files: [{ name: "/main.tsx", contents: "export default 1" }],
        main: "/main.tsx",
      });
      declare const db: SqliteDb;
      const queried = sqliteQuery<Repo>({ db, sql: "SELECT name FROM repos" });
      const queryAlias = sqliteQuery;
      const aliasedQuery = queryAlias<Repo>({
        db,
        sql: "SELECT name FROM repos",
      });
      const namespaceQuery = cf.sqliteQuery<Repo>({
        db,
        sql: "SELECT name FROM repos",
      });
      const methodQuery = db.query<Repo>("SELECT name FROM repos");
      const objectGenerated = generateObject<Repo>({ prompt: "repo" });
      const objectStream = generateObjectStream<Repo>({ prompt: "repo" });
      const objectStreamAlias = objectStream;
      const objectStreamState = objectStream.result;
      const aliasedObjectStreamState = objectStreamAlias.result;
      const textStream = generateTextStream({ prompt: "repo" });
      const textStreamAlias = textStream;
      const textStreamState = textStreamAlias.result;
      const wishState = wish({ query: "#repo" });
      const wishStateAlias = wishState;
      const aliasedWishState = wishStateAlias.result;
      const dialogState = llmDialog<Repo>({ messages: [] });
      const dialogStateAlias = dialogState;
      const aliasedDialogState = dialogStateAlias.result;
      const objectStreamResult = partialResultOf(objectStreamAlias);
      const textStreamResult = partialResultOf(
        generateTextStream({ prompt: "repo" }),
      );
      const projected = resultOf(fetched);
      const nestedProjected = resultOf(projected);
      const projectedPlain = resultOf({ name: "plain" });
      const emptyProjection = resultOf();
      const ordinaryCall = ordinary(fetched);
      const ordinaryResultProperty = ordinary(fetched).result;
      const plainResultProperty = ({ result: fetched }).result;
      const cyclicStateA = cyclicStateB;
      const cyclicStateB = cyclicStateA;
      const cyclicStateResult = cyclicStateA.result;
      const allObserved = observeAvailability(fetched);
      const selective = observeAvailability(fetched, "error", "error", "pending");
      const invalid = observeAvailability(fetched, "not-a-reason");
      const missing = observeAvailability();
      const observedAlias = selective;
      declare const plainAny: any;
      declare const plainUnknown: unknown;
      declare const unavailable: HasError;
      declare const asyncString: AsyncResult<string>;
      function constrained<T extends Repo | HasError>(value: T) { return value; }
    `,
    ({ context, sourceFile }) => {
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "fetched"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "textGenerated"),
          context,
        )?.kind,
        "async-result",
      );
      for (const name of ["compiled", "aliasedCompiled", "namespaceCompiled"]) {
        assertEquals(
          resolveAvailabilityValueProvenance(
            initializer(sourceFile, name),
            context,
          )?.kind,
          "async-result",
        );
      }
      for (
        const name of [
          "queried",
          "aliasedQuery",
          "namespaceQuery",
          "methodQuery",
        ]
      ) {
        assertEquals(
          resolveAvailabilityValueProvenance(
            initializer(sourceFile, name),
            context,
          )?.kind,
          "async-result",
        );
      }
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "objectGenerated"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "objectStream"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "objectStreamResult"),
          context,
        )?.kind,
        "result-projection",
      );
      for (
        const name of [
          "objectStreamState",
          "aliasedObjectStreamState",
          "textStreamState",
          "aliasedWishState",
          "aliasedDialogState",
        ]
      ) {
        assertEquals(
          resolveAvailabilityValueProvenance(
            initializer(sourceFile, name),
            context,
          )?.kind,
          "async-result",
        );
      }
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "textStreamResult"),
          context,
        )?.kind,
        "result-projection",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "nestedProjected"),
          context,
        )?.kind,
        "result-projection",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "projectedPlain"),
          context,
        )?.source.getText(sourceFile),
        '{ name: "plain" }',
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "emptyProjection"),
          context,
        ),
        undefined,
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "ordinaryCall"),
          context,
        ),
        undefined,
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "ordinaryResultProperty"),
          context,
        ),
        undefined,
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "plainResultProperty"),
          context,
        ),
        undefined,
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "cyclicStateResult"),
          context,
        ),
        undefined,
      );

      const nestedSource = resolveResultOfSource(
        initializer(sourceFile, "nestedProjected"),
        context,
      );
      assertEquals(nestedSource?.getText(sourceFile), "fetched");
      assertEquals(
        resolveResultOfSource(initializer(sourceFile, "ordinaryCall"), context),
        undefined,
      );
      assertEquals(
        resolveResultOfSource(
          initializer(sourceFile, "emptyProjection"),
          context,
        ),
        undefined,
      );

      const all = parseAvailabilityObservation(
        initializer(sourceFile, "allObserved") as ts.CallExpression,
        context,
        true,
      );
      assertEquals(all?.reasons, [
        "pending",
        "error",
        "syncing",
        "schemaMismatch",
      ]);
      const selected = parseAvailabilityObservation(
        initializer(sourceFile, "selective") as ts.CallExpression,
        context,
        true,
      );
      assertEquals(selected?.reasons, ["error", "pending"]);
      assertEquals(
        parseAvailabilityObservation(
          initializer(sourceFile, "invalid") as ts.CallExpression,
          context,
          true,
        ),
        undefined,
      );
      assertEquals(
        parseAvailabilityObservation(
          initializer(sourceFile, "missing") as ts.CallExpression,
          context,
          true,
        ),
        undefined,
      );
      assertEquals(
        parseAvailabilityObservation(
          initializer(sourceFile, "ordinaryCall") as ts.CallExpression,
          context,
          true,
        ),
        undefined,
      );
      assertEquals(
        context.diagnostics.map((diagnostic) => diagnostic.type),
        [
          "availability:invalid-observation",
          "availability:invalid-observation",
        ],
      );

      const observedAlias = initializer(sourceFile, "observedAlias");
      assertEquals(
        resolveAvailabilityObservation(observedAlias, context)?.reasons,
        ["error", "pending"],
      );
      context.recordAvailabilityObservation(observedAlias, all!);
      assertEquals(
        resolveAvailabilityObservation(observedAlias, context)?.reasons,
        all?.reasons,
      );

      const checker = context.checker;
      const variant = checker.getTypeAtLocation(
        variable(sourceFile, "unavailable").name,
      );
      const asyncType = checker.getTypeAtLocation(
        variable(sourceFile, "asyncString").name,
      );
      const anyType = checker.getTypeAtLocation(
        variable(sourceFile, "plainAny").name,
      );
      const unknownType = checker.getTypeAtLocation(
        variable(sourceFile, "plainUnknown").name,
      );
      const constrained = functionDeclaration(sourceFile, "constrained");
      const constrainedSymbol = checker.getSymbolAtLocation(
        constrained.typeParameters![0]!.name,
      );
      assert(constrainedSymbol);
      const constrainedType = checker.getDeclaredTypeOfSymbol(
        constrainedSymbol,
      );
      assert(constrainedType.flags & ts.TypeFlags.TypeParameter);
      assert(typeContainsAvailabilityVariant(asyncType, variant, checker));
      assert(
        typeContainsAvailabilityVariant(constrainedType, variant, checker),
      );
      assertEquals(
        typeContainsAvailabilityVariant(anyType, variant, checker),
        false,
      );
      assertEquals(
        typeContainsAvailabilityVariant(unknownType, variant, checker),
        false,
      );
      assertEquals(
        typeContainsAvailabilityVariant(
          asyncType,
          variant,
          checker,
          new Set([asyncType]),
        ),
        false,
      );
      assert(
        guardOperandExposesAvailability(
          initializer(sourceFile, "fetchedAny"),
          variant,
          context,
        ),
      );
      assertEquals(
        guardOperandExposesAvailability(
          variable(sourceFile, "plainAny").name as ts.Identifier,
          variant,
          context,
        ),
        false,
      );
    },
  );
});

Deno.test("resultOf canonicalization rewrites stable property and element paths", () => {
  withContext(
    `
      import { AsyncResult, fetchJson, resultOf } from "commonfabric";
      type Repo = { name: string };
      declare const input: { requests: AsyncResult<Repo>[] };
      const projected = resultOf(input.requests[0]);
      const direct = resultOf(fetchJson<Repo>({ url: "/repo" }));
      const view = () => ({ projected, name: projected.name });
    `,
    ({ context, sourceFile, transformation }) => {
      const view = initializer(sourceFile, "view") as ts.ArrowFunction;
      const projectedUse = identifierIn(view.body, "projected");
      const canonical = canonicalizeResultOfCaptures(
        [projectedUse],
        context,
      );
      assertEquals(canonical.captures.size, 1);
      assertEquals(canonical.aliases.size, 1);

      const rewritten = rewriteResultOfAliasReferences(
        view.body,
        canonical.aliases,
        context,
        transformation,
      );
      const printed = ts.createPrinter().printNode(
        ts.EmitHint.Unspecified,
        rewritten,
        sourceFile,
      );
      assertStringIncludes(printed, "projected: input.requests[0]");
      assertStringIncludes(printed, "input.requests[0].name");

      const directSymbol = context.checker.getSymbolAtLocation(
        variable(sourceFile, "direct").name,
      )!;
      const directAliases = new Map([
        [
          directSymbol,
          (initializer(sourceFile, "direct") as ts.CallExpression)
            .arguments[0]!,
        ],
      ]);
      const directIdentifier = variable(sourceFile, "direct").name;
      const rewrittenDirect = rewriteResultOfAliasReferences(
        directIdentifier,
        directAliases,
        context,
        transformation,
      );
      assertStringIncludes(
        ts.createPrinter().printNode(
          ts.EmitHint.Expression,
          rewrittenDirect,
          sourceFile,
        ),
        "fetchJson",
      );
      assertEquals(
        rewriteResultOfAliasReferences(
          view.body,
          new Map(),
          context,
          transformation,
        ),
        view.body,
      );
    },
  );
});

Deno.test("resultOf capture rewrites preserve nullish source short-circuits", () => {
  for (
    const source of [
      "input.holder?.request",
      'input.holder?.["request"]',
      "input.holders?.[0].request",
    ]
  ) {
    withContext(
      `
        import { AsyncResult, resultOf } from "commonfabric";
        type Repo = { field: string };
        declare const input: {
          holder: { request: AsyncResult<Repo> } | null;
          holders: { request: AsyncResult<Repo> }[] | null;
        };
        const usable = resultOf(${source});
        const view = () => usable?.field ?? "absent";
      `,
      ({ context, sourceFile, transformation }) => {
        const view = initializer(sourceFile, "view") as ts.ArrowFunction;
        const canonical = canonicalizeResultOfCaptures(
          [identifierIn(view.body, "usable")],
          context,
        );
        expect(canonical.aliases.size).toBe(1);
        const rewritten = rewriteResultOfAliasReferences(
          view.body,
          canonical.aliases,
          context,
          transformation,
        );
        const expression = ts.createPrinter().printNode(
          ts.EmitHint.Expression,
          rewritten,
          sourceFile,
        );
        const evaluate = new Function("input", `return ${expression};`);
        expect(evaluate({ holder: null, holders: null })).toBe("absent");
        const request = { field: "ready" };
        expect(evaluate({ holder: { request }, holders: [{ request }] })).toBe(
          "ready",
        );
      },
    );
  }
});

Deno.test("availability capture utilities cover composite and callback paths", () => {
  withContext(
    `
      import {
        AsyncResult,
        hasError,
        isPending,
        observeAvailability,
      } from "commonfabric";
      type Repo = { name: string };
      declare const input: { request: AsyncResult<Repo> };
      declare function make(): AsyncResult<Repo>;
      const observed = observeAvailability(input.request, "error");
      const wrapped = (((observed as typeof observed)!) satisfies AsyncResult<Repo>);
      const composite = {
        first: wrapped,
        observed,
        "literal-name": observed,
        [input.request.reason]: observed,
      };
      const wrappedComposite = (((<{
        first: AsyncResult<Repo>;
      }> ({ first: observed })) as {
        first: AsyncResult<Repo>;
      })! satisfies { first: AsyncResult<Repo> });
      const cyclicCompositeA = cyclicCompositeB;
      const cyclicCompositeB = cyclicCompositeA;
      const list = [observed, , wrapped];
      const guards = () =>
        hasError(input["request"]) || isPending(input.request) || hasError(make());
      const noArgGuard = () => hasError();
      const arrayCallback = ([head, ...rest]: [string, ...AsyncResult<Repo>[]]) =>
        hasError(rest[0]);
      const noParameter = () => true;
    `,
    ({ context, sourceFile }) => {
      const observedCaptures = collectObservedAvailabilityCaptures(
        [initializer(sourceFile, "wrapped")],
        context,
      );
      assertEquals(observedCaptures.length, 1);
      assertEquals(observedCaptures[0]?.path, ["observed"]);

      assertEquals(
        collectObservedAvailabilityInputPaths(
          initializer(sourceFile, "composite"),
          context,
        ).map((entry) => entry.path),
        [["first"], ["observed"], ["literal-name"]],
      );
      assertEquals(
        collectObservedAvailabilityInputPaths(
          initializer(sourceFile, "list"),
          context,
        ).map((entry) => entry.path),
        [["0"], ["2"]],
      );
      assertEquals(
        collectObservedAvailabilityInputPaths(
          initializer(sourceFile, "wrappedComposite"),
          context,
        ).map((entry) => entry.path),
        [["first"]],
      );
      assertEquals(
        collectObservedAvailabilityInputPaths(
          initializer(sourceFile, "cyclicCompositeA"),
          context,
        ),
        [],
      );

      const guards = initializer(sourceFile, "guards") as ts.ArrowFunction;
      assert(!ts.isBlock(guards.body));
      const direct = collectAvailabilityGuardCaptures(guards.body, context);
      assertEquals(direct[0]?.path, ["input", "request"]);
      assertEquals(direct[0]?.reasons, ["error", "pending"]);
      assert(
        context.diagnostics.some((diagnostic) =>
          diagnostic.type === "availability:unsupported-guard-operand"
        ),
      );
      const noArg = initializer(sourceFile, "noArgGuard") as ts.ArrowFunction;
      assert(!ts.isBlock(noArg.body));
      collectAvailabilityGuardCaptures(noArg.body, context);

      const explicit = collectExplicitAvailabilityGuardCaptures(
        guards.body,
        context,
      );
      assertEquals(explicit[0]?.path, ["input", "request"]);
      assertEquals(explicit[0]?.reasons, ["error", "pending"]);

      const variants = direct[0]!.variants;
      const entries: AvailabilityCaptureOverride[] = [
        { path: [], reasons: ["pending"], variants: [] },
        { path: ["rest", "0"], reasons: ["error"], variants },
        { path: ["rest", "bad"], reasons: ["syncing"], variants: [] },
        { path: ["outside"], reasons: ["schemaMismatch"], variants: [] },
      ];
      const arrayCallback = initializer(
        sourceFile,
        "arrayCallback",
      ) as ts.ArrowFunction;
      const partitioned = partitionGuardCapturesByCallbackInput(
        entries,
        arrayCallback,
      );
      assertEquals(
        partitioned.callbackInput.map((entry) => entry.path),
        [[], ["1"]],
      );
      assertEquals(
        partitioned.captures.map((entry) => entry.path),
        [["rest", "bad"], ["outside"]],
      );
      assertEquals(
        mapGuardCapturesToCallbackInput(entries, arrayCallback).map((entry) =>
          entry.path
        ),
        [[], ["1"], ["rest", "bad"], ["outside"]],
      );
      const noParameter = initializer(
        sourceFile,
        "noParameter",
      ) as ts.ArrowFunction;
      assertEquals(
        partitionGuardCapturesByCallbackInput(entries, noParameter).captures,
        entries,
      );

      const renamed = renameAvailabilityCapturePaths(
        entries,
        new Map([
          ["outside", "renamed"],
        ]),
      );
      assertEquals(renamed[0], entries[0]);
      assertEquals(renamed[3]?.path, ["renamed"]);
      const merged = mergeAvailabilityCaptureOverrides([
        { path: ["same"], reasons: ["pending"], variants: [] },
        {
          path: ["same"],
          source: initializer(sourceFile, "observed"),
          reasons: ["pending", "error"],
          variants,
        },
      ]);
      assertEquals(merged[0]?.reasons, ["pending", "error"]);
      assertEquals(merged[0]?.variants.length, variants.length);
      assert(merged[0]?.source);
    },
  );
});

Deno.test("explicit helper guards preserve stable caller paths", () => {
  withContext(
    `
      import { AsyncResult, hasError } from "commonfabric";
      type Repo = { name: string };
      interface Joined {
        repo: AsyncResult<Repo>;
      }
      interface RequestList {
        [index: number]: AsyncResult<Repo>;
      }
      declare const joined: Joined;
      declare const requests: RequestList;

      function objectHelper({ repo }: Joined) {
        return hasError(repo);
      }
      function indexedHelper(values: RequestList) {
        return hasError(values[0]);
      }
      function closureHelper() {
        return hasError(joined.repo);
      }
      function secondParameterHelper(
        _label: string,
        value: AsyncResult<Repo>,
      ) {
        return hasError(value);
      }
      function tupleHelper([, value]: [string, AsyncResult<Repo>]) {
        return hasError(value);
      }
      declare const dynamicKey: "ignored";
      function computedBindingHelper(
        { [dynamicKey]: _ignored, repo }: Joined & { ignored: string },
      ) {
        return hasError(repo);
      }
      function mismatchedShapeHelper(
        value: { nested: { repo: AsyncResult<Repo> } },
      ) {
        return hasError(value.nested.repo);
      }
      declare const untyped: any;

      const objectGuard = () => objectHelper(joined);
      const indexedGuard = () => indexedHelper(requests);
      const closureGuard = () => closureHelper();
      const secondParameterGuard = () => secondParameterHelper("repo", joined.repo);
      const tupleGuard = () => tupleHelper(["repo", joined.repo]);
      const computedBindingGuard = () => computedBindingHelper({
        ignored: "repo",
        repo: joined.repo,
      });
      const mismatchedShapeGuard = () => mismatchedShapeHelper(untyped);
    `,
    ({ context, sourceFile }) => {
      const capturePaths = (name: string): readonly (readonly string[])[] => {
        const callback = initializer(sourceFile, name) as ts.ArrowFunction;
        return collectExplicitAvailabilityGuardCaptures(
          callback.body,
          context,
        ).map((entry) => entry.path);
      };

      assertEquals(capturePaths("objectGuard"), [["joined", "repo"]]);
      assertEquals(capturePaths("indexedGuard"), [["requests", "0"]]);
      assertEquals(capturePaths("closureGuard"), [["joined", "repo"]]);
      assertEquals(capturePaths("secondParameterGuard"), [["joined", "repo"]]);
      assertEquals(capturePaths("tupleGuard"), []);
      assertEquals(capturePaths("computedBindingGuard"), []);
      assertEquals(capturePaths("mismatchedShapeGuard"), []);
      assertEquals(
        context.diagnostics.map((diagnostic) => diagnostic.type),
        [
          "availability:unobserved-compute-guard",
          "availability:unobserved-compute-guard",
          "availability:unobserved-compute-guard",
        ],
      );
    },
  );
});

Deno.test("explicit guard capture rejects mutable local aliases", () => {
  withContext(
    `
      import { AsyncResult, hasError } from "commonfabric";
      type Repo = { name: string };
      declare const input: {
        first: AsyncResult<Repo>;
        second: AsyncResult<Repo>;
      };
      const guard = () => {
        let selected = input.first;
        selected = input.second;
        return hasError(selected);
      };
    `,
    ({ context, sourceFile }) => {
      const guard = initializer(sourceFile, "guard") as ts.ArrowFunction;
      assert(ts.isBlock(guard.body));
      assertEquals(
        collectExplicitAvailabilityGuardCaptures(guard.body, context),
        [],
      );
      assertEquals(
        context.diagnostics.map((diagnostic) => diagnostic.type),
        ["availability:unsupported-guard-operand"],
      );
    },
  );
});

Deno.test("availability analysis propagates observations through composite lift bindings", () => {
  withContext(
    `
      import {
        AsyncResult,
        lift,
        observeAvailability,
      } from "commonfabric";
      type Repo = { name: string };
      declare const request: AsyncResult<Repo>;
      const observed = observeAvailability(request, "error");
      const shorthand = observed;
      const composite = {
        shorthand,
        assigned: observed,
        ignored: 1,
        method() {},
      };
      const wrappedComposite = (((composite as typeof composite)!) satisfies
        typeof composite);
      const objectLift = lift(({
        shorthand: fromShorthand,
        "assigned": fromAssignment,
        missing,
        ...rest
      }) => ({ fromShorthand, fromAssignment, missing, rest }))(wrappedComposite);

      declare const declaredComposite: {
        shorthand: AsyncResult<Repo>;
      };
      const declaredObjectLift = lift(({ shorthand: declared }) => declared)(
        declaredComposite,
      );

      const tuple = [observed, "separator", observed] as const;
      const arrayLift = lift(([first, , third]) => ({ first, third }))(tuple);
      declare const declaredTuple: readonly [AsyncResult<Repo>];
      const declaredArrayLift = lift(([declared]) => declared)(declaredTuple);
      const cyclicTupleA = cyclicTupleB;
      const cyclicTupleB = cyclicTupleA;
      const cyclicArrayLift = lift(([cyclic]) => cyclic)(cyclicTupleA);
    `,
    ({ context, sourceFile }) => {
      const objectLift = initializer(sourceFile, "objectLift");
      assert(ts.isCallExpression(objectLift));
      assert(getLiftAppliedInputAndCallback(objectLift, context.checker));
      new AvailabilityAnalysisTransformer({ state: context.options.state })
        .transform(context);

      const reasonsFor = (
        liftName: string,
        name: string,
      ): readonly string[] | undefined => {
        const liftCall = initializer(sourceFile, liftName);
        assert(ts.isCallExpression(liftCall));
        const callback = getLiftAppliedInputAndCallback(
          liftCall,
          context.checker,
        )?.callback;
        assert(callback);
        const symbol = context.checker.getSymbolAtLocation(
          identifierIn(callback.parameters[0]!.name, name),
        );
        return symbol
          ? context.lookupAvailabilityObservation(symbol)?.reasons
          : undefined;
      };

      assertEquals(reasonsFor("objectLift", "fromShorthand"), ["error"]);
      assertEquals(reasonsFor("objectLift", "fromAssignment"), ["error"]);
      assertEquals(reasonsFor("arrayLift", "first"), ["error"]);
      assertEquals(reasonsFor("arrayLift", "third"), ["error"]);
      assertEquals(reasonsFor("objectLift", "missing"), undefined);
      assertEquals(reasonsFor("declaredObjectLift", "declared"), undefined);
      assertEquals(reasonsFor("cyclicArrayLift", "cyclic"), undefined);
    },
  );
});

Deno.test("availability observation registry follows original nodes", () => {
  const state = new CrossStageState();
  const original = ts.factory.createIdentifier("request");
  const replacement = ts.setOriginalNode(
    ts.factory.createIdentifier("request"),
    original,
  );
  const observation = {
    source: original,
    reasons: ["pending"],
  } as const;

  state.recordAvailabilityObservation(replacement, observation);

  assertEquals(state.lookupAvailabilityObservation(original), observation);
  assertEquals(state.lookupAvailabilityObservation(replacement), observation);
});

Deno.test("stable const aliases reconstruct destructured static access paths", () => {
  withContext(
    `
      const source = {
        regular: 1,
        "dash-key": 2,
        0: 3,
        "01": 7,
        1: -1,
        nested: [4],
      };
      const {
        regular,
        "dash-key": dashed,
        0: numeric,
        "01": leadingZero,
        nested: [first],
      } = source;
      const defaulted = regular;
      let mutable = source;
    `,
    ({ context, sourceFile }) => {
      const printer = ts.createPrinter();
      const resolved = (name: string): string | undefined => {
        const symbol = context.checker.getSymbolAtLocation(
          identifierIn(sourceFile, name),
        );
        const expression = getStableConstAliasInitializer(symbol);
        return expression
          ? printer.printNode(ts.EmitHint.Expression, expression, sourceFile)
          : undefined;
      };
      assertEquals(resolved("regular"), "source.regular");
      assertEquals(resolved("dashed"), 'source["dash-key"]');
      assertEquals(resolved("numeric"), "source[0]");
      const leadingZero = resolved("leadingZero");
      assertEquals(leadingZero, 'source["01"]');
      assertEquals(
        new Function("source", `"use strict"; return ${leadingZero};`)({
          "01": 7,
          1: -1,
        }),
        7,
      );
      assertEquals(resolved("first"), "source.nested[0]");
      assertEquals(resolved("defaulted"), "regular");
      assertEquals(resolved("mutable"), undefined);
    },
  );
});
