/**
 * The transparent wrapper set — `(x)`, `x as T`, `<T>x`, `x satisfies T`, `x!`,
 * and the partially emitted node — is defined once in `src/utils/expression.ts`
 * and read by every stage that looks through a wrapper to the expression it
 * wraps.
 *
 * These tests pin the property that makes that worth doing: a stage's answer
 * does not depend on which spelling the author reached for. They span several
 * source files on purpose, because the failure they guard against is one
 * consumer drifting away from the others rather than any single stage being
 * wrong on its own.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { transformFiles, transformSource, validateSource } from "./utils.ts";
import {
  callSchemas,
  callsMatching,
  callsNamed,
  hasKeyPathRead,
  parseModule,
} from "./transformed-ast.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { normalizeDataFlows } from "../src/ast/normalize.ts";
import type { DataFlowGraph, DataFlowNode } from "../src/ast/dataflow.ts";

/** Every spelling available in a `.tsx` source. `<T>x` is JSX there, so it is
 * exercised separately against a `.ts` module. */
const TSX_SPELLINGS: Readonly<Record<string, (inner: string) => string>> = {
  bare: (inner) => inner,
  parenthesized: (inner) => `(${inner})`,
  "as-cast": (inner) => `(${inner}) as never`,
  satisfies: (inner) => `(${inner}) satisfies unknown`,
  "non-null": (inner) => `(${inner})!`,
};

describe("transparent wrapper consistency", () => {
  describe("action() callback lowering", () => {
    // `action()` throws when it reaches the runtime — it exists only to be
    // rewritten to `handler()` at compile time. A spelling the callback
    // unwrapper does not strip therefore does not degrade the output, it
    // compiles a guaranteed runtime failure.
    const source = (callback: string) =>
      `      import { action, pattern } from "commonfabric";
      export default pattern<{ n: number }, { go: unknown }>(({ n }) => ({
        go: action(${callback}),
      }));
    `;

    for (const [name, wrap] of Object.entries(TSX_SPELLINGS)) {
      it(`rewrites the callback to a handler when it is ${name}`, async () => {
        const output = await transformSource(source(wrap("() => { n; }")), {
          types: COMMONFABRIC_TYPES,
        });

        expect(/\baction\(/.test(output)).toBe(false);
        expect(/handler\(|__cfHandler/.test(output)).toBe(true);
      });
    }

    it("rewrites the callback behind an angle-bracket assertion in a `.ts` module", async () => {
      const output = await transformFiles({
        "/m.ts": `      import { action, pattern } from "commonfabric";
      export default pattern<{ n: number }, { go: unknown }>(({ n }) => ({
        go: action(<() => void>(() => { n; })),
      }));
    `,
      }, { types: COMMONFABRIC_TYPES });

      expect(/\baction\(/.test(output["/m.ts"]!)).toBe(false);
    });
  });

  describe("verb tier marking", () => {
    const source = (verb: string) =>
      `      import { action, pattern, type PerSession, Stream, type Writable } from "commonfabric";
      interface Out {
        draft: PerSession<Writable<string>>;
        openComposer: Stream<void>;
      }
      export default pattern<Record<string, never>, Out>(() => {
        const draft = new Writable("");
        const openComposer = ${verb};
        return { draft, openComposer };
      });
    `;

    for (const [name, wrap] of Object.entries(TSX_SPELLINGS)) {
      it(`marks the verb wrapper-tier when the action is ${name}`, async () => {
        const output = await transformSource(
          source(wrap(`action(() => { draft.set(""); })`)),
          { types: COMMONFABRIC_TYPES },
        );
        const start = output.indexOf("openComposer: {");

        expect(start).toBeGreaterThanOrEqual(0);
        expect(output.slice(start, start + 400)).toContain('tier: "wrapper"');
      });
    }
  });

  describe("verb return validation", () => {
    const errorsIn = async (body: string) => {
      const { diagnostics } = await validateSource(
        `      import { action } from "commonfabric";
      const verb = action((id: string) => {
        return ${body};
      });
      export { verb };
    `,
        { types: COMMONFABRIC_TYPES },
      );
      return (diagnostics as readonly TransformationDiagnostic[]).filter((d) =>
        d.type === "verb-result:undeclared-return"
      );
    };

    for (const [name, wrap] of Object.entries(TSX_SPELLINGS)) {
      it(`reports an undeclared return when the value is ${name}`, async () => {
        expect((await errorsIn(wrap("{ picked: id }"))).length).toBe(1);
      });
    }

    it("stays opted out when the value is asserted to `any`", async () => {
      // The deliberate fail-open: an `any` assertion means the validator
      // cannot judge the shape, whichever assertion form carries it.
      expect((await errorsIn("{ picked: id } as any")).length).toBe(0);
      expect((await errorsIn("({ picked: id }) satisfies any")).length).toBe(0);
    });
  });

  describe("verb callback resolution", () => {
    // The matrix above varies the wrapper around the RETURNED value. This one
    // varies the wrapper around the CALLBACK, which is a separate lookup: an
    // unresolved wrapper hides the body from the validator entirely, so it
    // judges nothing rather than judging it differently.
    const undeclaredReturns = async (source: string) => {
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      return (diagnostics as readonly TransformationDiagnostic[]).filter((d) =>
        d.type === "verb-result:undeclared-return"
      );
    };

    for (const [name, wrap] of Object.entries(TSX_SPELLINGS)) {
      it(`reads an action body behind a ${name} callback`, async () => {
        const source = `      import { action } from "commonfabric";
      const verb = action(${
          wrap("(id: string) => { return { picked: id }; }")
        });
      export { verb };
    `;

        expect((await undeclaredReturns(source)).length).toBe(1);
      });

      it(`reads a handler body behind a ${name} callback`, async () => {
        const source = `      import { handler } from "commonfabric";
      const verb = handler<{ id: string }, Record<string, never>>(${
          wrap("(event) => { return { picked: event.id }; }")
        });
      export { verb };
    `;

        expect((await undeclaredReturns(source)).length).toBe(1);
      });
    }
  });

  describe("callback boundary classification", () => {
    // Extraction and boundary classification have to agree about where a
    // callback sits. When they disagree, an otherwise legal body is reported
    // against — a false positive on valid source, not a missed rewrite.
    const patternContextErrors = async (source: string) => {
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      return (diagnostics as readonly TransformationDiagnostic[]).filter((d) =>
        d.type.startsWith("pattern-context:")
      );
    };

    const body = "() => { const o = { run: () => { n; } }; o.run(); }";

    for (const [name, wrap] of Object.entries(TSX_SPELLINGS)) {
      it(`leaves a ${name} action callback free of pattern-context errors`, async () => {
        const source = `      import { action, pattern } from "commonfabric";
      export default pattern<{ n: number }, { go: unknown }>(({ n }) => ({
        go: action(${wrap(body)}),
      }));
    `;

        expect(await patternContextErrors(source)).toEqual([]);
      });

      it(`leaves a ${name} JSX event handler free of pattern-context errors`, async () => {
        const source = `      import { pattern } from "commonfabric";
      export default pattern<{ n: number }, { ui: unknown }>(({ n }) => ({
        ui: <button onClick={${wrap(body)}}>hi</button>,
      }));
    `;

        expect(await patternContextErrors(source)).toEqual([]);
      });
    }
  });

  describe("capture shrinking", () => {
    // A lift captures the fields its body actually reads. The dedup that
    // decides this asks each data flow for its root identifier, so a spelling
    // whose root goes unrecognized is not simply skipped — the free-identifier
    // pass adds that root as its own capture, and a whole-object capture
    // subsumes the narrower paths beside it. The lift then re-runs for any
    // field of the object rather than for the one field it reads.
    //
    // The assertion spellings parenthesize the whole wrapper and assert it to
    // the receiver's own type. `(obj) as S` would not do: appending `.b` to it
    // parses as the qualified type name `S.b`, not a read of the cast value.
    const RECEIVERS: Readonly<Record<string, string>> = {
      bare: "obj",
      parenthesized: "(obj)",
      "non-null": "obj!",
      "as-cast": "(obj as S)",
      satisfies: "(obj satisfies S)",
      stacked: "((obj satisfies S) as S)!",
    };

    const source = (receiver: string) =>
      `      import { pattern } from "commonfabric";
      interface S { a: number; b: number; }
      export default pattern<{ obj: S }, { x: number; y: number }>(({ obj }) => ({
        x: obj.a * 2,
        y: ${receiver}.b + 1,
      }));
    `;

    /** The value each emitted lift captures under `obj`, queried from the
     *  parsed output rather than matched against printed text, per this
     *  directory's "assert on structure, not printed text" convention. Both
     *  lifts in the source capture `obj` — the `a` projection for `x`, and
     *  the value under test for `y` — so two entries come back. */
    const objCaptureValues = (root: ts.SourceFile): ts.Expression[] => {
      const values: ts.Expression[] = [];
      for (const call of callsMatching(root, /^__cfLift_\d+$/)) {
        const captures = call.arguments[0];
        if (!captures || !ts.isObjectLiteralExpression(captures)) continue;
        for (const property of captures.properties) {
          if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === "obj"
          ) {
            values.push(property.name);
          }
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) && property.name.text === "obj"
          ) {
            values.push(property.initializer);
          }
        }
      }
      return values;
    };

    for (const [name, receiver] of Object.entries(RECEIVERS)) {
      it(`captures only the field read behind a ${name} receiver`, async () => {
        const root = parseModule(
          await transformSource(source(receiver), {
            types: COMMONFABRIC_TYPES,
          }),
        );
        const values = objCaptureValues(root);

        expect(values.length).toBeGreaterThan(0);
        // The bug shape: the whole object captured as a bare identifier.
        expect(values.some((value) => ts.isIdentifier(value))).toBe(false);
        // The shrunk shape: a capture projects `b` off `obj` with `.key("b")`.
        expect(hasKeyPathRead(root, "b", "obj")).toBe(true);
      });
    }

    it("captures only the field read behind an angle-bracket assertion", async () => {
      const output = await transformFiles({
        "/m.ts": source("(<S>obj)"),
      }, { types: COMMONFABRIC_TYPES });
      const root = parseModule(output["/m.ts"]!, ts.ScriptKind.TS);
      const values = objCaptureValues(root);

      expect(values.length).toBeGreaterThan(0);
      expect(values.some((value) => ts.isIdentifier(value))).toBe(false);
      expect(hasKeyPathRead(root, "b", "obj")).toBe(true);
    });
  });

  describe("normalizeDataFlows()", () => {
    // Built directly rather than through the pipeline: a partially emitted node
    // is synthetic, so a hand-built graph is the only way to put one in front
    // of the normalizer.
    const graphOf = (...expressions: ts.Expression[]): DataFlowGraph => ({
      nodes: expressions.map((expression, id): DataFlowNode => ({
        id,
        expression,
        canonicalKey: `k${id}`,
        parentId: null,
        scopeId: 0,
        isExplicit: true,
      })),
      scopes: [{ id: 0, parentId: null, parameters: [] }],
      rootScopeId: 0,
    });

    const parseInitializers = (code: string): ts.Expression[] => {
      const sourceFile = ts.createSourceFile(
        "/t.ts",
        code,
        ts.ScriptTarget.Latest,
        true,
      );
      const found: ts.Expression[] = [];
      const walk = (candidate: ts.Node) => {
        if (ts.isVariableDeclaration(candidate) && candidate.initializer) {
          found.push(candidate.initializer);
        }
        ts.forEachChild(candidate, walk);
      };
      walk(sourceFile);
      return found;
    };

    it("groups flows that differ only by a transparent wrapper", () => {
      const [bare, cast, satisfied, nonNull] = parseInitializers(
        `const a = obj.value;
         const b = (obj.value) as never;
         const c = (obj.value) satisfies unknown;
         const d = (obj.value)!;`,
      );

      const normalized = normalizeDataFlows(
        graphOf(bare!, cast!, satisfied!, nonNull!),
      );

      expect(normalized.length).toBe(1);
      expect(normalized[0]!.occurrences.length).toBe(4);
    });

    it("groups a partially emitted wrapper with the expression it wraps", () => {
      const [bare] = parseInitializers(`const a = obj.value;`);
      const wrapped = ts.factory.createPartiallyEmittedExpression(bare!);

      const normalized = normalizeDataFlows(graphOf(bare!, wrapped));

      expect(normalized.length).toBe(1);
    });

    it("keeps flows that differ by more than a wrapper apart", () => {
      const [a, b] = parseInitializers(
        `const a = obj.value;
         const b = (obj.other) as never;`,
      );

      expect(normalizeDataFlows(graphOf(a!, b!)).length).toBe(2);
    });
  });

  describe("conditional-helper operand tidying", () => {
    // The synthesized `ifElse`/`when`/`unless` operands read a deliberately
    // narrower set than the classifying stages: `unwrapParentheses` strips
    // only parentheses, because the schema stages read operand types at these
    // argument positions and every other transparent wrapper can carry a
    // type. These pin both halves — the tidying, and the wrapper that must
    // survive it.

    const source = (ui: string) =>
      `      import { pattern, UI } from "commonfabric";
      interface Input {
        flag: boolean;
        label: string;
        note?: string;
      }
      export default pattern<Input>((state) => ({
        [UI]: ${ui},
      }));
    `;

    const undefinedArmed = (schema: Record<string, unknown>): boolean =>
      Array.isArray(schema.type) && schema.type.includes("undefined");

    it("keeps the operand schema non-nullable for a non-null asserted branch", async () => {
      const output = await transformSource(
        source(`<p>{state.flag ? (state.note)! : "off"}</p>`),
        { types: COMMONFABRIC_TYPES },
      );
      const schemas = callSchemas(parseModule(output), "ifElse");

      expect(schemas.length).toBeGreaterThan(0);
      expect(schemas.some(undefinedArmed)).toBe(false);
    });

    it("emits the `undefined` arm for the same branch without the assertion", async () => {
      // The control: the `undefined` arm is present until the author asserts
      // it away, so its absence in the asserted case is the assertion's doing.

      const output = await transformSource(
        source(`<p>{state.flag ? state.note : "off"}</p>`),
        { types: COMMONFABRIC_TYPES },
      );
      const schemas = callSchemas(parseModule(output), "ifElse");

      expect(schemas.some(undefinedArmed)).toBe(true);
    });

    const TIDIED: readonly {
      helper: string;
      ui: string;
      operand: string;
    }[] = [
      {
        helper: "ifElse",
        ui: `<p>{state.flag ? ("on") : "off"}</p>`,
        operand: "on",
      },
      { helper: "when", ui: `<p>{state.flag && ("yes")}</p>`, operand: "yes" },
      {
        helper: "unless",
        ui: `<p>{state.label || ("fallback")}</p>`,
        operand: "fallback",
      },
    ];

    for (const { helper, ui, operand } of TIDIED) {
      it(`strips redundant parentheses from the synthesized \`${helper}\` operands`, async () => {
        const output = await transformSource(source(ui), {
          types: COMMONFABRIC_TYPES,
        });
        const call = callsNamed(parseModule(output), helper).at(-1);

        expect(call).toBeDefined();
        expect(call!.arguments.some(ts.isParenthesizedExpression)).toBe(false);
        expect(
          call!.arguments.some((argument) =>
            ts.isStringLiteral(argument) && argument.text === operand
          ),
        ).toBe(true);
      });
    }
  });
});
