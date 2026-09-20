import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  REPLAYABLE_BUILTIN_REFS,
  SUBPATTERN_ARGUMENT_BUILTIN_REFS,
} from "../src/builder/builtin-replayability.ts";
import {
  byRef,
  createNodeFactory,
  handler,
  lift,
} from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import { type Frame, type JSONSchema } from "../src/builder/types.ts";
import { registerBuiltins } from "../src/builtins/index.ts";
import { createRef } from "../src/create-ref.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { toURI } from "../src/uri-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/** Finds the derived-internal-cell descriptor for a result-surface key. */
const descriptorFor = (
  factory: { derivedInternalCells?: { partialCause: unknown }[] },
  partialCause: unknown,
): { partialCause: unknown; kind?: string } | undefined =>
  factory.derivedInternalCells?.find((descriptor) =>
    descriptor.partialCause === partialCause
  );

describe("computed cell kinds", () => {
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
    // Disposal resets the ambient computed-cell-ids config to its default.
    await runtime?.dispose();
  });

  describe("createRef and the computed scheme", () => {
    it("keeps the hash preimage kind-free", () => {
      const cause = { the: "cause" };
      const hash = createRef({}, cause);
      expect(hash.tag).toBe("fid1");
      // The kind does NOT enter the preimage: the same cause yields the same
      // bytes, and the URI scheme applied by toURI is the ONLY thing
      // distinguishing a computed id from its state sibling.
      expect(toURI(hash, "computed")).toBe(`computed:${hash.toString()}`);
      expect(toURI(hash)).toBe(`of:${hash.toString()}`);
    });

    it("mints deterministically", () => {
      const cause = { the: "cause" };
      expect(createRef({}, cause).toString()).toBe(
        createRef({}, cause).toString(),
      );
    });
  });

  describe("builder classification", () => {
    it("tags a pure lift output as computed", () => {
      const double = lift((x: number) => x * 2);
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        doubled: double(x),
      }));
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: "doubled", kind: "computed" },
      ]);
    });

    it("tags intermediate lift outputs as computed", () => {
      const increment = lift((x: number) => x + 1);
      const double = lift((x: number) => x * 2);
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const intermediate = increment(x);
        return { doubled: double(intermediate) };
      });
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: { $generated: 0 }, kind: "computed" },
        { partialCause: "doubled", kind: "computed" },
      ]);
    });

    it("leaves state cells (no compute writer) untagged", () => {
      const double = lift(({ x }: { x: number }) => x * 2);
      const testPattern = pattern<{ x: number }>(() => {
        const x = reactive<number>(1);
        (x as any).for("x");
        return { double: double({ x }) };
      });
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: "double", kind: "computed" },
        // `x` is seeded state with no compute writer — never tagged.
        { partialCause: "x", schema: { default: 1 } },
      ]);
    });

    it("keeps cells captured read-only by a handler computed", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: { target: { type: "number" } },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bump({ target: doubled }) };
      });
      // The handler's $ctx schema grants no writable asCell handle anywhere,
      // so the capture cannot be written through — `doubled` stays computed.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
      // The handler's stream output is never tagged (streams are excluded).
      const stream = descriptorFor(testPattern, "onBump");
      expect(stream).toBeDefined();
      expect(stream!.kind).toBeUndefined();
    });

    it("disqualifies handler captures bound through a writable asCell handle", () => {
      const double = lift((x: number) => x * 2);
      const bumpWritable = handler(
        true as const,
        {
          type: "object",
          properties: { target: { type: "number", asCell: ["cell"] } },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bumpWritable({ target: doubled }) };
      });
      // A `"cell"` handle in the $ctx schema is write-capable: the handler
      // could write `doubled` non-replayably, so it must not be computed.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("collects no root from a primitive bound where the subschema could grant a handle deeper", () => {
      const double = lift((x: number) => x * 2);
      const bumpNested = handler(
        true as const,
        {
          type: "object",
          properties: {
            outer: {
              type: "object",
              properties: { inner: { type: "number", asCell: ["cell"] } },
            },
            other: { type: "number" },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bumpNested({ outer: 5, other: doubled }) };
      });
      // `outer`'s subschema grants a writable handle one level down, so the
      // walk does not stop at it, and the value bound there is a number. A
      // primitive holds no cell roots, so nothing under `outer` is collected
      // and the capture at `other` — covered by a subschema that grants
      // nothing — leaves `doubled` computed.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
    });

    it("tags a capture of a handler whose `$ctx` schema is `true` as computed", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true,
        true,
        (_event: unknown, _ctx: { target: number }) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, onBump: bump({ target: doubled }) };
      });
      // A `true` `$ctx` schema grants no `asCell` handle, so the binding
      // arrives as a read-only view the body cannot write through, and the
      // root it covers stays eligible.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
    });

    it("disqualifies outputs of unknown builtin refs", () => {
      const rawNode = byRef<number, number>("someRawTarget");
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: rawNode(x),
      }));
      // Builtin names fail STRICT: a name missing from
      // REPLAYABLE_BUILTIN_REFS is treated as non-replayable.
      expect(descriptorFor(testPattern, "out")).toBeDefined();
      expect(descriptorFor(testPattern, "out")!.kind).toBeUndefined();
    });

    it("tags sync-builtin (ifElse) outputs as computed", () => {
      const branch = byRef<unknown, number>("ifElse");
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: branch([x, 1, 2]),
      }));
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
    });

    it("disqualifies async-builtin (fetchJson) writers and their input roots", () => {
      const double = lift((x: number) => x * 2);
      const fetch = byRef<unknown, unknown>("fetchJson");
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const derived = double(x);
        return { derived, out: fetch({ url: derived }) };
      });
      // The fetch output is not a replayable derivation of its inputs.
      expect(descriptorFor(testPattern, "out")?.kind).toBeUndefined();
      // Non-replayable builtins may write THROUGH their inputs (llmDialog
      // pushes onto its `messages` input), so the bound root disqualifies
      // even though its own writer (the lift) qualifies.
      expect(descriptorFor(testPattern, "derived")).toBeDefined();
      expect(descriptorFor(testPattern, "derived")!.kind).toBeUndefined();
    });

    it("tags map outputs computed but disqualifies its input roots", () => {
      const toList = lift((x: number) => [x]);
      const mapNode = byRef<unknown, number[]>("map");
      const innerOp = pattern<{ element: number }>(({ element }) => ({
        e: element,
      }));
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const list = toList(x);
        return { list, mapped: mapNode({ list, op: innerOp, params: {} }) };
      });
      // The mapping itself replays deterministically...
      expect(descriptorFor(testPattern, "mapped")?.kind).toBe("computed");
      // ...but the op sub-pattern may contain handlers writing the source
      // elements (invisible at this layer), so the list input disqualifies.
      expect(descriptorFor(testPattern, "list")).toBeDefined();
      expect(descriptorFor(testPattern, "list")!.kind).toBeUndefined();
    });

    it("disqualifies roots handed into a sub-pattern; the sub-pattern output stays computed", () => {
      const double = lift((x: number) => x * 2);
      const inner = pattern<{ item: number }>(({ item }) => ({
        echoed: item,
      }));
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, sub: inner({ item: doubled }) };
      });
      // Sub-pattern arguments are writable-by-default aliases and handlers
      // inside the sub-pattern are invisible here — the input disqualifies.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
      // `pattern` WRITERS qualify (instantiation writes converge on replay) —
      // deliberate; flip to disqualifying if that fails in practice.
      expect(descriptorFor(testPattern, "sub")?.kind).toBe("computed");
    });

    it("keeps handle-bearing lifts computed without capture-write analysis", () => {
      const writeThrough = lift(
        (_input: unknown) => 0,
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["cell"] } },
        } as const,
        { type: "number" } as const,
      );
      const testPattern = pattern<{ x: number }>(() => {
        const st = reactive<number>(5);
        (st as any).for("st");
        return { out: writeThrough({ c: st }) };
      });
      // Even if the lift writes through the handle, a replayable compute's
      // writes are deterministically reproduced — the output qualifies.
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
      // The captured state cell has no compute writer — untagged, and a
      // qualifying javascript compute's inputs do not disqualify it.
      expect(descriptorFor(testPattern, "st")).toBeDefined();
      expect(descriptorFor(testPattern, "st")!.kind).toBeUndefined();
    });

    it("keeps handle-bearing lifts computed", () => {
      // A handle-bearing lift still classifies as computed: a replayable
      // compute's writes are deterministically reproduced from its inputs.
      const embedsHandle = lift(
        (_input: unknown) => 0,
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["cell"] } },
        } as const,
        { type: "number" } as const,
      );
      const testPattern = pattern<{ x: number }>(() => {
        const st = reactive<number>(5);
        (st as any).for("st");
        return { out: embedsHandle({ c: st }) };
      });
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
      expect(descriptorFor(testPattern, "st")?.kind).toBeUndefined();
    });

    it("keeps lifts with observed capture writes computed", () => {
      const writesThrough = lift(
        (_input: unknown) => 0,
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["cell"] } },
        } as const,
        { type: "number" } as const,
        {
          materializerWriteInputPaths: [["c"]],
        },
      );
      const testPattern = pattern<{ x: number }>(() => {
        const st = reactive<number>(5);
        (st as any).for("st");
        return { out: writesThrough({ c: st }) };
      });
      // Observed capture writes are still replayable derivations of the
      // inputs: dropping one loses nothing, so the output stays computed.
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
      expect(descriptorFor(testPattern, "st")?.kind).toBeUndefined();
    });

    it("keeps outputs exposed writable on the result surface computed", () => {
      // Exposure on the result surface does not disqualify. An embedder
      // writing through the exposed handle has that write ack-and-dropped on
      // conflict; the derivation re-establishes the value.
      const exposeHandle = lift(
        (x: number) => ({ h: x }),
        { type: "number" } as const,
        {
          type: "object",
          properties: { h: { type: "number", asCell: ["cell"] } },
        } as const,
      );
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: exposeHandle(x),
      }));
      expect(descriptorFor(testPattern, "out")?.kind).toBe("computed");
    });

    it("mints nothing when the flag is off", async () => {
      // Replace the default-on runtime from beforeEach with an explicit
      // rollback override.
      popFrame(frame);
      await runtime.dispose();
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { computedCellIds: false },
      });
      frame = pushFrame({
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
        runtime,
      });

      const double = lift((x: number) => x * 2);
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        doubled: double(x),
      }));
      expect(testPattern.derivedInternalCells).toEqual([
        { partialCause: "doubled" },
      ]);
    });

    it("reads the flag from the active runtime frame", async () => {
      const otherStorageManager = StorageManager.emulate({ as: signer });
      const otherRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: otherStorageManager,
        experimental: { computedCellIds: false },
      });
      const otherFrame = pushFrame({
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
        runtime: otherRuntime,
      });

      try {
        const double = lift((x: number) => x * 2);
        const flagOffPattern = pattern<{ x: number }>(({ x }) => ({
          doubled: double(x),
        }));
        expect(descriptorFor(flagOffPattern, "doubled")?.kind).toBeUndefined();
      } finally {
        popFrame(otherFrame);
        await otherRuntime.dispose();
        await otherStorageManager.close();
      }

      // The original default-on runtime remains the active frame. Constructing
      // and disposing the flag-off runtime above must not change its behavior.
      const double = lift((x: number) => x * 2);
      const flagOnPattern = pattern<{ x: number }>(({ x }) => ({
        doubled: double(x),
      }));
      expect(descriptorFor(flagOnPattern, "doubled")?.kind).toBe("computed");
    });

    it("a failed Runtime construction cannot change active classification", async () => {
      const failedStorageManager = StorageManager.emulate({ as: signer });
      try {
        expect(() =>
          new Runtime({
            apiUrl: "not a valid URL" as unknown as URL,
            storageManager: failedStorageManager,
            experimental: { computedCellIds: false },
          })
        ).toThrow();

        const double = lift((x: number) => x * 2);
        const testPattern = pattern<{ x: number }>(({ x }) => ({
          doubled: double(x),
        }));
        expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
      } finally {
        await failedStorageManager.close();
      }
    });
  });

  describe("fail-closed disqualifier battery", () => {
    // Negative battery for the fail-closed fallbacks: every branch here
    // exists because under-collection means silently dropped user writes, so
    // each one must provably disqualify (or, for the read-only-kind check,
    // provably spare) its roots. Hand-built modules via createNodeFactory
    // reach the writer/input shapes the trusted builders never emit.

    const mkModule = (spec: Record<string, unknown>) =>
      createNodeFactory(spec as never);

    it("raw modules disqualify as writers AND disqualify their input roots", () => {
      const double = lift((x: number) => x * 2);
      const rawNode = mkModule({ type: "raw", implementation: () => 0 });
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, out: rawNode({ v: doubled }) };
      });
      // Opaque module type: assume the worst on both sides.
      expect(descriptorFor(testPattern, "out")?.kind).toBeUndefined();
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("effect modules disqualify as writers AND disqualify their input roots", () => {
      const double = lift((x: number) => x * 2);
      const effectNode = mkModule({
        type: "javascript",
        implementation: () => 0,
        isEffect: true,
      });
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, out: effectNode({ v: doubled }) };
      });
      expect(descriptorFor(testPattern, "out")?.kind).toBeUndefined();
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("handler-wrapped modules disqualify as writers (hand-built shape)", () => {
      // Real handlers never list outputs; the writer-side check stays for
      // hand-built nodes exactly like this one.
      const handlerish = mkModule({
        type: "javascript",
        implementation: () => 0,
        wrapper: "handler",
        argumentSchema: {
          type: "object",
          properties: { $event: true, $ctx: { type: "object" } },
        },
      });
      const testPattern = pattern<{ x: number }>(({ x }) => ({
        out: handlerish({ $ctx: { v: x } }),
      }));
      expect(descriptorFor(testPattern, "out")?.kind).toBeUndefined();
    });

    it("a handler argumentSchema without properties disqualifies every capture", () => {
      const double = lift((x: number) => x * 2);
      // Schema-carrying but shapeless: no properties map exists to prove any
      // capture read-only, so the walk cannot run and everything bound
      // disqualifies. Zero outputs keeps it off the writer path.
      const shapeless = mkModule({
        type: "javascript",
        implementation: () => 0,
        wrapper: "handler",
        argumentSchema: { type: "object" },
      });
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: shapeless({ $ctx: { t: doubled } }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("a $ref in the covering subschema fails closed", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: { target: { $ref: "#/$defs/grant" } },
          $defs: { grant: { type: "number" } },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: doubled }) };
      });
      // The referenced schema is not inline — a writable grant could hide
      // behind it, so the capture disqualifies even though this $defs target
      // is harmless.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("composition keywords (anyOf) in the covering subschema fail closed", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              anyOf: [{ type: "number" }, { type: "number", asCell: ["cell"] }],
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: doubled }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("tuple-form items (schema arrays) fail closed", () => {
      const toList = lift((x: number) => [x]);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: { items: [{ type: "number", asCell: ["cell"] }] },
          },
        } as unknown as JSONSchema,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const list = toList(x);
        return { list, on: bump({ target: [list] }) };
      });
      // The walk models only single-schema items; a schema ARRAY is not a
      // plain object and fails safe at the element step.
      expect(descriptorFor(testPattern, "list")?.kind).toBeUndefined();
    });

    it("grant-free tuple (prefixItems) slots stay computed", () => {
      // Covered by the provably-handle-free gate (no grant anywhere in the
      // schema); pins that a tuple schema takes that shortcut.
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              prefixItems: [{ type: "number" }, { type: "string" }],
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: [doubled, "label"] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
    });

    it("a capture in a grant-free tuple slot stays computed beside a granting slot", () => {
      // The walk aligns each tuple slot with the element bound there, so the
      // grant in slot 0 does not reach the capture in slot 1.
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              prefixItems: [
                { type: "number", asCell: ["cell"] },
                { type: "number" },
              ],
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: [5, doubled] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
    });

    it("a writable grant in a tuple slot disqualifies the capture bound there", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              prefixItems: [
                { type: "number", asCell: ["cell"] },
                { type: "string" },
              ],
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: [doubled, "label"] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("a grant in the items rest schema disqualifies elements past the tuple slots", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              prefixItems: [{ type: "string" }],
              items: { type: "number", asCell: ["cell"] },
            },
          },
        } as unknown as JSONSchema,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: ["label", doubled] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("elements past the tuple slots with no items schema have no asCell position", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              // The grant sits in slot 0, where a plain string is bound; the
              // capture at index 1 is past the tuple arity with no `items`
              // schema, so no covering subschema exists for it.
              prefixItems: [{ type: "string", asCell: ["cell"] }],
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: ["label", doubled] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
    });

    it("malformed prefixItems (not a schema array) fails closed", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              prefixItems: { 0: { type: "number", asCell: ["cell"] } },
            },
          },
        } as unknown as JSONSchema,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: [doubled] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("unused-tier keywords (contains) stay in the derived unmodeled list", () => {
      // Pins that the derivation from schema-walk's vocabulary keeps the
      // never-emitted tier failing closed.
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "array",
              items: { type: "number" },
              contains: { type: "number", asCell: ["cell"] },
            },
          },
        } as unknown as JSONSchema,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: [doubled] }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("an array value under an object-shaped subschema fails closed", () => {
      const toList = lift((x: number) => [x]);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: { deep: { type: "number", asCell: ["cell"] } },
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const list = toList(x);
        return { list, on: bump({ target: [list] }) };
      });
      // Value/schema shape mismatch (array where the schema says object, no
      // items to align against) with a possible grant below: fail safe.
      expect(descriptorFor(testPattern, "list")?.kind).toBeUndefined();
    });

    it("a cell bound where a DEEPER grant may exist disqualifies that root", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: { deep: { type: "number", asCell: ["cell"] } },
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        // The cell itself sits at `target`; the grant is at `target.deep` —
        // a handle obtained deeper writes INTO this root.
        return { doubled, on: bump({ target: doubled }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("shared subtrees are walked once (seen guard) and still disqualify", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: {
                a: {
                  type: "object",
                  properties: { v: { type: "number", asCell: ["cell"] } },
                },
                b: {
                  type: "object",
                  properties: { v: { type: "number", asCell: ["cell"] } },
                },
              },
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        const shared = { v: doubled };
        return { doubled, on: bump({ target: { a: shared, b: shared } }) };
      });
      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("walks a shared subtree once per schema position", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: {
                // This path may grant a handle, but only through a property the
                // shared value does not contain. It visits the shared object
                // without collecting its `v` root.
                a: {
                  type: "object",
                  properties: {
                    absent: { type: "number", asCell: ["cell"] },
                  },
                },
                // The same shared object is writable at this schema position.
                b: {
                  type: "object",
                  properties: {
                    v: { type: "number", asCell: ["cell"] },
                  },
                },
              },
            },
          },
        } as const,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        const shared = { v: doubled };
        return { doubled, on: bump({ target: { a: shared, b: shared } }) };
      });

      expect(descriptorFor(testPattern, "doubled")?.kind).toBeUndefined();
    });

    it("read-only asCell kinds (opaque) are provably handle-free — capture stays computed", () => {
      const double = lift((x: number) => x * 2);
      const bump = handler(
        true as const,
        {
          type: "object",
          properties: { target: { type: "number", asCell: ["opaque"] } },
        } as unknown as JSONSchema,
        (_event, _ctx) => {},
      );
      const testPattern = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, on: bump({ target: doubled }) };
      });
      // Every asCell entry is a read-only kind: no write capability can flow
      // through this capture, so the derivation stays computed.
      expect(descriptorFor(testPattern, "doubled")?.kind).toBe("computed");
    });
  });

  describe("replayability registry cross-check", () => {
    it("covers every builtin name registered by registerBuiltins", () => {
      // registerBuiltins only touches runtime.moduleRegistry.addModuleByRef —
      // record the literal names it registers.
      const registered: string[] = [];
      registerBuiltins(
        {
          moduleRegistry: {
            addModuleByRef: (ref: string) => {
              registered.push(ref);
            },
          },
        } as unknown as Runtime,
      );
      expect(registered.length).toBeGreaterThan(0);

      // Mirror of the doc-listed non-replayables in
      // builder/builtin-replayability.ts (keep the two in sync).
      const documentedNonReplayable: ReadonlySet<string> = new Set([
        "fetchBinary",
        "fetchText",
        "fetchJson",
        "fetchJsonUnchecked",
        "fetchProgram",
        "streamData",
        "llm",
        "llmDialog",
        "compileAndRun",
        "generateObject",
        "generateText",
        "navigateTo",
        "wish",
        "sqliteQuery",
        "inspectConfLabel",
        "cellFromUrl",
      ]);

      // Every registered builtin must be recorded in the replayability
      // registry: either proven replayable or documented non-replayable.
      const unrecorded = registered.filter((name) =>
        !REPLAYABLE_BUILTIN_REFS.has(name) &&
        !documentedNonReplayable.has(name)
      );
      expect(unrecorded).toEqual([]);

      // No name may be both.
      const contradictory = [...REPLAYABLE_BUILTIN_REFS].filter((name) =>
        documentedNonReplayable.has(name)
      );
      expect(contradictory).toEqual([]);

      // Sub-pattern-argument builtins are a refinement of the replayable set.
      const strayed = [...SUBPATTERN_ARGUMENT_BUILTIN_REFS].filter((name) =>
        !REPLAYABLE_BUILTIN_REFS.has(name)
      );
      expect(strayed).toEqual([]);
    });
  });

  describe("derived internal cell links", () => {
    it("mints computed-scheme ids for computed descriptors", () => {
      const resultCell = runtime.getCell(space, "computed-kind-link-test");
      const kinded = getDerivedInternalCellLink(resultCell, {
        partialCause: "d",
        kind: "computed",
      });
      const untagged = getDerivedInternalCellLink(resultCell, {
        partialCause: "d",
      });
      expect(kinded.id.startsWith("computed:fid1:")).toBe(true);
      expect(untagged.id.startsWith("of:fid1:")).toBe(true);
      // The hash preimage is kind-free: same partialCause, same hash part —
      // the scheme is the whole difference, and the whole identity.
      expect(kinded.id.slice("computed:".length)).toBe(
        untagged.id.slice("of:".length),
      );
    });
  });
});
