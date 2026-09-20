import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type AssertRawPart,
  type AssertRecord,
  JSONSchemaObj,
} from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type Frame,
  isModule,
  isPattern,
  isReactive,
  type JSONSchema,
  type Module,
  type Pattern,
  type Reactive as _Reactive,
  type Stream,
} from "../src/builder/types.ts";
import {
  action,
  assert,
  assertCapture,
  assertRenderParts,
  handler,
  lift,
} from "../src/builder/module.ts";
import { reactive } from "../src/builder/reactive.ts";
import { externalRefTo } from "./schema-ref-helpers.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { CellImpl } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { trustPattern } from "./support/trusted-builder.ts";

type MouseEvent = {
  clientX: number;
  clientY: number;
};

type TestNode = Pattern["nodes"][number];
type SourceTrackedImplementation = ((...args: any[]) => any) & {
  preview?: string;
  src?: string;
};

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("module", () => {
  // These pins were written against the flag-on writer (reference-form
  // link schemas); the flag's build default is off, so they opt in.
  beforeEach(() => {
    setContentAddressedSchemasConfig(true);
  });
  afterEach(() => {
    resetContentAddressedSchemasConfig();
  });

  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
  });

  describe("lift function", () => {
    it("creates a node factory", () => {
      const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
      expect(typeof add).toBe("function");
      expect(isModule(add)).toBe(true);
    });

    it("creates a opaque ref when called", () => {
      const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
      const result = add({ a: reactive(1), b: reactive(2) });
      expect(isReactive(result)).toBe(true);
    });

    it("supports JSON Schema validation", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      } as const satisfies JSONSchema;

      const greet = lift(
        ({ name, age }: { name: string; age?: number }) =>
          `Hello ${name}${age ? `, age ${age}` : ""}!`,
        schema,
        { type: "string" } as const satisfies JSONSchema,
      );

      expect(isModule(greet)).toBe(true);
      const module = greet as unknown as Module;
      expect(module.argumentSchema).toEqual(schema);
    });

    it("supports schema validation with description", () => {
      const inputSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
        description: "Person information",
      } as const satisfies JSONSchema;

      const outputSchema = {
        type: "string",
        description: "Greeting message",
      } as const satisfies JSONSchema;

      const greet = lift(
        ({ name, age }: { name: string; age?: number }) =>
          `Hello ${name}${age ? `, age ${age}` : ""}!`,
        inputSchema,
        outputSchema,
      );

      expect(isModule(greet)).toBe(true);
      const module = greet as unknown as Module;
      expect(module.argumentSchema).toBeDefined();
      expect(module.resultSchema).toBeDefined();
      expect((module.argumentSchema as JSONSchemaObj).description).toBe(
        "Person information",
      );
      expect((module.resultSchema as JSONSchemaObj).description).toBe(
        "Greeting message",
      );
    });
  });

  describe("assert function", () => {
    it("creates a node factory", () => {
      const holds = assert(() => true);
      expect(isReactive(holds)).toBe(true);
    });

    it("produces the record it declares, carrying the result in `ok`", async () => {
      // The assert-diagnostics transformer normally rewrites an `assert` body
      // and lowers the call to a lift, so this implementation is what runs when
      // a source opts out of the transform. It still has to produce the record
      // `assert` declares it returns — a body handing back a bare boolean would
      // have the declared type and the value disagree. It records no operands,
      // having no rewritten body to record them from.

      const testPattern = trustPattern(
        runtime,
        pattern(() => {
          const holds = assert(() => true);
          const fails = assert(() => 1 + 2 <= 2);
          return { holds, fails };
        }),
      );

      const resultCell = runtime.getCell(space, "assert-runtime-instance");
      runtime.setup(undefined, testPattern, {}, resultCell);
      runtime.start(resultCell);

      const result = await resultCell.pull() as {
        holds: AssertRecord;
        fails: AssertRecord;
      };
      expect(result.holds).toEqual({ ok: true, source: "", parts: [] });
      expect(result.fails).toEqual({ ok: false, source: "", parts: [] });
    });
  });

  describe("assertCapture function", () => {
    // What the rewritten body calls for each operand. It has to hand the value
    // back untouched, or wrapping an operand would change what the assertion
    // computes.

    it("returns the value it was given", () => {
      const parts: AssertRawPart[] = [];
      expect(assertCapture(parts, "a + b", 3)).toBe(3);

      const object = { name: "Coffee" };
      expect(assertCapture(parts, "item", object)).toBe(object);
    });

    it("records the source text and the raw value, without rendering it", () => {
      // Rendering is deferred to `assertRenderParts`, so the value is stashed
      // as-is here — a passing assertion never renders it.
      const parts: AssertRawPart[] = [];
      const object = { name: "Coffee" };
      assertCapture(parts, "a + b", 3);
      assertCapture(parts, "item", object);

      expect(parts).toEqual([
        { src: "a + b", value: 3 },
        { src: "item", value: object },
      ]);
      // The recorded value is the object itself, not a copy or a rendering.
      expect(parts[1]!.value).toBe(object);
    });

    it("appends in the order it is called", () => {
      const parts: AssertRawPart[] = [];
      assertCapture(parts, "first", 1);
      assertCapture(parts, "second", 2);
      expect(parts.map((part) => part.src)).toEqual(["first", "second"]);
    });
  });

  describe("assertRenderParts function", () => {
    // The record's `parts` runs through this. On the passing path it renders
    // nothing — that is what keeps a passing assertion from paying to render
    // operands it will never report.

    it("renders nothing for a passing assertion", () => {
      const parts: AssertRawPart[] = [
        { src: "a + b", value: 3 },
        { src: "items", value: [1, -2] },
      ];
      expect(assertRenderParts(true, parts)).toEqual([]);
    });

    it("renders each captured value for a failing assertion", () => {
      const parts: AssertRawPart[] = [
        { src: "a + b", value: 3 },
        { src: "items", value: [1, -2] },
      ];
      expect(assertRenderParts(false, parts)).toEqual([
        { src: "a + b", rendered: "3" },
        { src: "items", rendered: "[1,-2]" },
      ]);
    });

    it("renders a deeply nested operand down to its leaf", () => {
      // A view tree nests two levels per node, so a diagnostic for one soon
      // runs past the renderer's default depth; the leaf here sits well past
      // it.

      let value: unknown = "leaf";
      for (let i = 0; i < 30; i++) value = { children: [value] };
      const [part] = assertRenderParts(false, [{ src: "tree", value }]);
      expect(part.rendered).toContain('"leaf"');
      expect(part.rendered).not.toContain("...");
    });

    it("renders a long list operand out to its last element", () => {
      // The renderer's default length elides a list after a hundred elements;
      // the last element here sits past that.

      const value = Array.from({ length: 150 }, (_, i) => i);
      const [part] = assertRenderParts(false, [{ src: "items", value }]);
      expect(part.rendered).toContain(",149]");
      expect(part.rendered).not.toContain("...");
    });

    it("renders a long string operand out to its last character", () => {
      // The renderer's default length carries a string whole to two hundred
      // characters; the last one here sits past that.

      const value = `${"x".repeat(299)}END`;
      const [part] = assertRenderParts(false, [{ src: "text", value }]);
      expect(part.rendered).toContain('END"');
      expect(part.rendered).not.toContain("...");
    });
  });

  describe("handler function", () => {
    it("creates a node factory for event handlers", () => {
      const clickHandler = handler<
        MouseEvent,
        { x: Cell<number>; y: Cell<number> }
      >(
        true,
        {
          type: "object",
          properties: {
            x: { type: "number", asCell: ["cell"] },
            y: { type: "number", asCell: ["cell"] },
          },
        },
        (event, props) => {
          props.x.set(event.clientX);
          props.y.set(event.clientY);
        },
      );
      expect(typeof clickHandler).toBe("function");
      expect(isModule(clickHandler)).toBe(true);
    });

    it("creates a opaque ref with stream when called", () => {
      const clickHandler = handler<
        MouseEvent,
        { x: Cell<number>; y: Cell<number> }
      >(
        true,
        {
          type: "object",
          properties: {
            x: { type: "number", asCell: ["cell"] },
            y: { type: "number", asCell: ["cell"] },
          },
        },
        (event, props) => {
          props.x.set(event.clientX);
          props.y.set(event.clientY);
        },
      );
      const stream = clickHandler({ x: reactive(10), y: reactive(20) });
      expect(isReactive(stream)).toBe(true);
      const { kind, nodes } = (stream as any).export();
      expect(kind).toBe("stream");
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });

    it("serializes stream causes with the stream declared in their schemas", () => {
      const clickHandler = handler(
        false,
        false,
        (_event: unknown, _state: unknown) => {},
      );

      const clickPattern = pattern(() => {
        const click = clickHandler({} as never).for(
          { stream: "click" },
          true,
        );
        return { click };
      });

      expect(clickPattern.result).toEqual({
        click: {
          $alias: {
            partialCause: { stream: "click" },
            path: [],
            schema: externalRefTo({ asCell: ["stream"] }),
            scope: "space",
          },
        },
      });
      expect(clickPattern.derivedInternalCells).toEqual([{
        partialCause: { stream: "click" },
        schema: { asCell: ["stream"] },
      }]);
      const handlerInputs = clickPattern.nodes[0].inputs as {
        $event: unknown;
      };
      expect(handlerInputs.$event).toEqual({
        $alias: {
          partialCause: { stream: "click" },
          path: [],
          schema: externalRefTo({ asCell: ["stream"] }),
          scope: "space",
        },
      });
    });

    it("serializes anonymous stream roots with partial causes", () => {
      const clickHandler = handler(
        false,
        false,
        (_event: unknown, _state: unknown) => {},
      );

      const clickPattern = pattern(() => clickHandler({} as never));

      const generatedStreamCause = { $generated: 0, $kind: "stream" };
      expect(clickPattern.result).toEqual({
        $alias: {
          partialCause: generatedStreamCause,
          path: [],
          schema: externalRefTo({ asCell: ["stream"] }),
          scope: "space",
        },
      });
      expect(clickPattern.derivedInternalCells).toEqual([{
        partialCause: generatedStreamCause,
        schema: { asCell: ["stream"] },
      }]);
      const handlerInputs = clickPattern.nodes[0].inputs as {
        $event: unknown;
      };
      expect(handlerInputs.$event).toEqual({
        $alias: {
          partialCause: generatedStreamCause,
          path: [],
          schema: externalRefTo({ asCell: ["stream"] }),
          scope: "space",
        },
      });
    });

    it("serializes array causes as stable internal path segments", () => {
      const arrayCausePattern = pattern(() => {
        const value = new CellImpl<number>(
          runtime,
          undefined,
          { path: [], space, schema: { default: 1 } },
          false,
        );
        return {
          value: value.for(["a", "b"], true),
        };
      });

      expect(arrayCausePattern.result).toEqual({
        value: {
          $alias: {
            partialCause: ["a", "b"],
            path: [],
            schema: externalRefTo({ default: 1 }),
            scope: "space",
          },
        },
      });
    });

    it("supports event and state schema validation", () => {
      const eventSchema = {
        type: "object",
        properties: {
          type: { type: "string", enum: ["click", "hover"] },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["type", "x", "y"],
      } as const satisfies JSONSchema;

      const stateSchema = {
        type: "object",
        properties: {
          lastX: { type: "number" },
          lastY: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const mouseHandler = handler(
        eventSchema,
        stateSchema,
        (event: any, state: any) => {
          state.lastX = event.x;
          state.lastY = event.y;
        },
      );

      expect(isModule(mouseHandler)).toBe(true);
      const module = mouseHandler as unknown as Module;
      expect(module.argumentSchema).toBeDefined();
      expect((module.argumentSchema as JSONSchemaObj).properties?.$event)
        .toEqual(eventSchema);
    });

    it("supports schema validation for events and state with enums", () => {
      const eventSchema = {
        type: "object",
        properties: {
          type: { type: "string", enum: ["click", "hover"] },
          target: { type: "string" },
        },
        required: ["type", "target"],
      } as const satisfies JSONSchema;

      const stateSchema = {
        type: "object",
        properties: {
          elements: {
            type: "object",
            additionalProperties: { type: "boolean" },
          },
        },
      } as const satisfies JSONSchema;

      const toggleHandler = handler(
        eventSchema,
        stateSchema,
        (event: any, state: any) => {
          state.elements[event.target] = !state.elements[event.target];
        },
      );

      const elements = reactive({ button1: true, button2: false });
      const result = toggleHandler({ elements } as any);

      expect(isReactive(result)).toBe(true);
      const { nodes } = result.export();
      expect(nodes.size).toBe(1);
      const handlerNode = [...nodes][0];
      expect((handlerNode.module as Module).wrapper).toBe("handler");
      expect(handlerNode.inputs.$ctx.elements).toBe(elements);
    });

    it("creates a opaque ref with stream when with is called", () => {
      const clickHandler = handler<
        MouseEvent,
        { x: Cell<number>; y: Cell<number> }
      >(
        true,
        {
          type: "object",
          properties: {
            x: { type: "number", asCell: ["cell"] },
            y: { type: "number", asCell: ["cell"] },
          },
        },
        (event, props) => {
          props.x.set(event.clientX);
          props.y.set(event.clientY);
        },
      );
      const stream = clickHandler.with({ x: reactive(10), y: reactive(20) });
      expect(isReactive(stream)).toBe(true);
      const { kind, nodes } = (stream as any).export();
      expect(kind).toBe("stream");
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });
  });

  describe("action function", () => {
    it("throws error when called directly without CTS transforms", () => {
      // action() is only valid once CTS transforms rewrite it to handler(), so
      // a direct runtime call fails and names the build process that does it.
      expect(() => {
        action<{ data: string }>(({ data }) => {
          void data;
        });
      }).toThrow(
        "action() must be used with CTS transforms enabled - it is rewritten" +
          " to handler() at compile time by the Common Fabric build process",
      );
    });

    it("infers Stream<void> for zero-parameter callbacks (type test)", () => {
      // This test verifies that TypeScript correctly infers Stream<void> for
      // zero-parameter action callbacks, rather than Stream<unknown>.
      //
      // The test passes if it compiles. Previously, action(() => {...}) would
      // infer Stream<unknown>, causing type errors when assigned to Stream<void>.
      //
      // action() throws at runtime (requires CTS transformer), so we wrap calls
      // in a never-executed block. TypeScript still type-checks dead code.

      // This function is never called - it exists only for type checking
      function _typeTest(): void {
        // These would throw at runtime, but this function is never called.
        // If the overloads are wrong, these lines fail to compile.

        // Zero-parameter callback should infer Stream<void>, not Stream<unknown>
        const _voidAction: Stream<void> = action(() => {
          console.log("side effect");
        });

        // Parameterized callback should infer Stream<string>
        const _stringAction: Stream<string> = action((_e: string) => {
          console.log("side effect");
        });

        // Complex type parameter
        const _complexAction: Stream<{ id: number; name: string }> = action(
          (_e: { id: number; name: string }) => {
            console.log("side effect");
          },
        );

        // Suppress unused variable warnings
        void _voidAction;
        void _stringAction;
        void _complexAction;
      }

      // Suppress unused function warning - the function exists only for type checking
      void _typeTest;

      // If we reach here, the types compiled correctly
      expect(true).toBe(true);
    });
  });

  describe("authored source locations through the CTS pipeline", () => {
    const compileMain = async (source: string) => {
      const program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };

      return await runtime.harness.compileAndEvaluateModules(program);
    };

    const findNodeByPreview = (
      patternFn: unknown,
      previewSubstring: string,
    ): TestNode | undefined => {
      if (!isPattern(patternFn)) return undefined;
      return patternFn.nodes.find((node) =>
        (() => {
          const trackedNode = hasTrackedImplementation(node) ? node : undefined;
          const impl = trackedNode?.module.implementation;
          return typeof impl?.preview === "string" &&
            impl.preview.includes(previewSubstring);
        })()
      );
    };

    const hasTrackedImplementation = (
      node: TestNode | undefined,
    ): node is TestNode & {
      module: TestNode["module"] & {
        implementation: SourceTrackedImplementation;
      };
    } =>
      !!node &&
      typeof node.module.implementation === "function";

    const expectTrackedNode = (
      node: TestNode | undefined,
      label?: string,
    ) => {
      expect(node, label).toBeDefined();
      if (!hasTrackedImplementation(node)) {
        throw new Error(
          `Expected tracked implementation${label ? ` for ${label}` : ""}`,
        );
      }
      expect(node.module.implementation.src, label).toBeDefined();
      return node;
    };

    it("maps computed callsites through the CTS pipeline", async () => {
      const source = [
        'import { computed, pattern } from "commonfabric";',
        "export default pattern<{ items: boolean[] }>(({ items }) => {",
        "  const visible = computed(() => items.filter(Boolean));",
        "  return { visible };",
        "});",
      ].join("\n");

      const { main } = await compileMain(source);
      const patternFn = main?.default;

      const computedNode = expectTrackedNode(
        findNodeByPreview(patternFn, ".filter(Boolean)"),
      );
      expect(computedNode.module.implementation.src).toMatch(
        /main\.tsx:3:\d+$/,
      );
    });

    it("maps action callsites through the CTS pipeline", async () => {
      const source = [
        'import { action, pattern } from "commonfabric";',
        "export default pattern<{ value: number }>(({ value }) => {",
        "  const inc = action(() => value + 1);",
        "  return { inc };",
        "});",
      ].join("\n");

      const { main } = await compileMain(source);
      const actionNode = expectTrackedNode(
        findNodeByPreview(main?.default, "value + 1"),
      );
      expect(actionNode.module.wrapper).toBe("handler");
      expect(actionNode.module.implementation.src).toMatch(/main\.tsx:3:\d+$/);
    });

    it("maps synthetic JSX compute callsites through the CTS pipeline", async () => {
      const source = [
        'import { pattern, UI } from "commonfabric";',
        "export default pattern<{ value: number }>(({ value }) => ({",
        "  [UI]: <div>{value + 1}</div>,",
        "}));",
      ].join("\n");

      const { main } = await compileMain(source);
      const jsxNode = expectTrackedNode(
        findNodeByPreview(main?.default, "value + 1"),
      );
      expect(jsxNode.module.implementation.src).toMatch(/main\.tsx:3:\d+$/);
    });

    it("preserves source locations for explicit lift, handler, and nested pattern calls", async () => {
      const cases = [
        {
          label: "lift",
          source: [
            'import { lift, pattern } from "commonfabric";',
            "const doubler = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ doubled: doubler(value) }));",
          ].join("\n"),
          exportName: "default",
          preview: "value * 2",
          line: 2,
        },
        {
          label: "handler",
          source: [
            'import { handler, pattern } from "commonfabric";',
            "const click = handler((event: { delta: number }, state: { value: number }) => state.value + event.delta);",
            "export default pattern<{ value: number }>(({ value }) => ({ click: click({ value }) }));",
          ].join("\n"),
          exportName: "default",
          preview: "state.value + event.delta",
          line: 2,
          wrapper: "handler",
        },
        {
          label: "pattern",
          source: [
            'import { computed, pattern } from "commonfabric";',
            "export const Child = pattern<{ value: number }>(({ value }) => ({ doubled: computed(() => value * 2) }));",
            "export default pattern<{ value: number }>(({ value }) => ({ child: Child({ value }) }));",
          ].join("\n"),
          exportName: "Child",
          preview: "value * 2",
          line: 2,
        },
      ];

      for (const testCase of cases) {
        const { main } = await compileMain(testCase.source);
        const node = expectTrackedNode(
          findNodeByPreview(main?.[testCase.exportName], testCase.preview),
          testCase.label,
        );
        if (testCase.wrapper) {
          expect(node.module.wrapper, testCase.label).toBe(testCase.wrapper);
        }
        expect(
          node.module.implementation.src,
          testCase.label,
        ).toMatch(new RegExp(`main\\.tsx:${testCase.line}:\\d+$`));
      }
    });
  });
});
