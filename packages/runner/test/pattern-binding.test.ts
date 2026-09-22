import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { isAliasBinding } from "../src/alias-binding.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import {
  linkCfcLabelView,
  setLinkCfcLabelView,
} from "../src/cfc/link-label-view.ts";
import { createCell, isCell } from "../src/cell.ts";
import {
  areLinksSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCellLink,
  getMetaCell,
  parseLink,
} from "../src/link-utils.ts";
import { externalRefTo, resolvedSchema } from "./schema-ref-helpers.ts";
import {
  causalFormOfBinding,
  findAllWriteRedirectCells,
  opaqueArgumentKeys,
  sendValueToBinding,
  unwrapOneLevelAndBindToDoc,
} from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("pattern-binding", () => {
  // These pins were written against the flag-on writer (reference-form
  // link schemas); the flag's build default is off, so they opt in.
  beforeEach(() => {
    setContentAddressedSchemasConfig(true);
  });
  afterEach(() => {
    resetContentAddressedSchemasConfig();
  });

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("finds no opaque argument keys when a schema has no property map", () => {
    expect(opaqueArgumentKeys({ type: "array" })).toEqual(new Set());
  });

  describe("sendValueToBinding", () => {
    it("should send value to a simple binding", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "should send value to a simple binding 1",
        undefined,
        tx,
      );

      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();
      testCell.set({ value: 0 });
      sendValueToBinding(tx, testCell, argumentCellLink, {
        $alias: { cell: "result", path: ["value"] },
      }, 42);
      expect(testCell.getAsQueryResult()).toEqual({ value: 42 });
    });

    it("resolves the argument cell from the result cell's meta link when argumentCellLink is undefined", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "argument meta link fallback 1",
        undefined,
        tx,
      );
      testCell.set({ value: 0 });

      const argumentCell = getMetaCell(testCell, "argument", tx);
      argumentCell.set({ input: 0 });
      testCell.setMetaRaw(
        "argument",
        argumentCell.getAsWriteRedirectLink({ base: testCell }),
        rawMetaWriteAuthorization,
      );

      sendValueToBinding(tx, testCell, undefined, {
        $alias: { cell: "argument", path: ["input"] },
      }, 42);

      expect(argumentCell.getAsQueryResult()).toEqual({ input: 42 });
    });

    it("should handle array bindings", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "should handle array bindings 1",
        undefined,
        tx,
      );
      testCell.set({ arr: [0, 0, 0] });
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();
      sendValueToBinding(
        tx,
        testCell,
        argumentCellLink,
        [{ $alias: { cell: "result", path: ["arr", "0"] } }, {
          $alias: { cell: "result", path: ["arr", "2"] },
        }],
        [1, 3],
      );
      expect(testCell.getAsQueryResult()).toEqual({ arr: [1, 0, 3] });
    });

    it("should handle bindings with multiple levels", () => {
      const testCell = runtime.getCell<{
        user: {
          name: {
            first: string;
            last: string;
          };
          age: number;
        };
      }>(
        space,
        "should handle bindings with multiple levels 1",
        undefined,
        tx,
      );
      testCell.set({
        user: {
          name: {
            first: "John",
            last: "Doe",
          },
          age: 30,
        },
      });
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();

      const binding = {
        person: {
          fullName: {
            firstName: {
              $alias: { cell: "result", path: ["user", "name", "first"] },
            },
            lastName: {
              $alias: { cell: "result", path: ["user", "name", "last"] },
            },
          },
          currentAge: { $alias: { cell: "result", path: ["user", "age"] } },
        },
      };

      const value = {
        person: {
          fullName: {
            firstName: "Jane",
            lastName: "Smith",
          },
          currentAge: 25,
        },
      };

      sendValueToBinding(
        tx,
        testCell,
        argumentCellLink,
        binding,
        value,
      );

      expect(testCell.getAsQueryResult()).toEqual({
        user: {
          name: {
            first: "Jane",
            last: "Smith",
          },
          age: 25,
        },
      });
    });

    it("accepts a matching static primitive binding, including NaN", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "static primitive binding leaf 1",
        undefined,
        tx,
      );
      testCell.set({ value: 0 });
      const argumentCellLink = getMetaCell(testCell, "argument", tx)
        .getAsNormalizedFullLink();

      // A static primitive binding matches an identical produced value...
      sendValueToBinding(tx, testCell, argumentCellLink, 42, 42);
      // ...including `NaN` (`Object.is` semantics; a `!==` check would
      // spuriously throw here, reporting `NaN` instead of `NaN`).
      sendValueToBinding(tx, testCell, argumentCellLink, NaN, NaN);
      // A genuine mismatch throws.
      expect(() => sendValueToBinding(tx, testCell, argumentCellLink, 42, 43))
        .toThrow("Got `43` instead of `42`");
      // A produced object is rendered, not stringified as `[object Object]`.
      expect(() =>
        sendValueToBinding(tx, testCell, argumentCellLink, 42, { a: 1 })
      ).toThrow("Got `{a:1}` instead of `42`");
    });

    it("normalizes cell values before writing a narrower scoped binding", () => {
      const output = runtime.getCell<{ value: unknown }>(
        space,
        "narrow scoped binding cell value output",
        undefined,
        tx,
      );
      output.set({ value: null });
      const argumentCellLink = getMetaCell(output, "argument", tx)
        .getAsNormalizedFullLink();

      const source = runtime.getCell<string>(
        space,
        "narrow scoped binding cell value source",
        undefined,
        tx,
      );
      source.set("secret");

      sendValueToBinding(
        tx,
        output,
        argumentCellLink,
        output.key("value").getAsWriteRedirectLink(),
        source,
        { narrowestReadScope: "user" },
      );

      const scopedValue = runtime.getCellFromLink(
        { ...output.key("value").getAsNormalizedFullLink(), scope: "user" },
        undefined,
        tx,
      );
      const scopedRaw = scopedValue.getRaw();
      expect(isCell(scopedRaw)).toBe(false);
      expect(
        areNormalizedLinksSame(parseLink(scopedRaw as any, scopedValue)!, {
          ...source.getAsNormalizedFullLink(),
          path: [],
        }),
      ).toBe(true);

      const broadRaw = output.key("value").getRaw();
      expect(
        areNormalizedLinksSame(
          parseLink(broadRaw as any, output.key("value"))!,
          scopedValue.getAsNormalizedFullLink(),
        ),
      ).toBe(true);
    });

    it("normalizes nested cell values before writing a narrower scoped binding", () => {
      const output = runtime.getCell<{ value: unknown }>(
        space,
        "narrow scoped binding nested cell output",
        undefined,
        tx,
      );
      output.set({ value: null });
      const argumentCellLink = getMetaCell(output, "argument", tx)
        .getAsNormalizedFullLink();

      const source = runtime.getCell<string>(
        space,
        "narrow scoped binding nested cell source",
        undefined,
        tx,
      );
      source.set("secret");

      sendValueToBinding(
        tx,
        output,
        argumentCellLink,
        output.key("value").getAsWriteRedirectLink(),
        { nested: source },
        { narrowestReadScope: "user" },
      );

      const scopedValue = runtime.getCellFromLink(
        { ...output.key("value").getAsNormalizedFullLink(), scope: "user" },
        undefined,
        tx,
      );
      const scopedRaw = scopedValue.getRaw() as { nested?: unknown };
      expect(isCell(scopedRaw.nested)).toBe(false);
      expect(
        areNormalizedLinksSame(
          parseLink(scopedRaw.nested as any, scopedValue)!,
          {
            ...source.getAsNormalizedFullLink(),
            path: [],
          },
        ),
      ).toBe(true);
    });

    it("RAGGED redirect (fan-out stage B): a SESSION discovery below an EXISTING user redirect re-points the run's own USER slot, never the SHARED space slot — a sibling principal's next read still resolves the user instance, not a session instance of a node that is user-scoped for them", () => {
      // The independent review's F3 asked for a deterministic unit pin
      // here: the E2E (c)/(f-walk) shapes are timing-sensitive, and the
      // revert-to-shared-slot mutation (M9) survived 3/4 there. This
      // exercises exactly the flag-gated branch.
      setServerExecutionConfig(true);
      try {
        const output = runtime.getCell<{ value: unknown }>(
          space,
          "ragged redirect output",
          undefined,
          tx,
        );
        output.set({ value: null });
        const argumentCellLink = getMetaCell(output, "argument", tx)
          .getAsNormalizedFullLink();
        const source = runtime.getCell<string>(
          space,
          "ragged redirect source",
          undefined,
          tx,
        );
        source.set("secret");

        const spaceSlot = output.key("value");
        const userSlot = runtime.getCellFromLink(
          { ...spaceSlot.getAsNormalizedFullLink(), scope: "user" },
          undefined,
          tx,
        );
        const sessionSlot = runtime.getCellFromLink(
          { ...spaceSlot.getAsNormalizedFullLink(), scope: "session" },
          undefined,
          tx,
        );

        // Hop 1: a USER-scope discovery — the shared space slot narrows
        // to user (structural top hop). Every principal follows it.
        sendValueToBinding(
          tx,
          output,
          argumentCellLink,
          spaceSlot.getAsWriteRedirectLink(),
          source,
          { narrowestReadScope: "user" },
        );
        // The space slot points at the USER instance.
        expect(
          areNormalizedLinksSame(
            parseLink(spaceSlot.getRaw() as never, spaceSlot)!,
            userSlot.getAsNormalizedFullLink(),
          ),
        ).toBe(true);

        // Hop 2: a SESSION discovery for THIS run. The ragged fix points
        // the run's own USER slot at the session instance — NOT the
        // shared space slot (which M9 reverts to, re-pointing the slot
        // every other principal follows at a session instance of a node
        // that is user-scoped for them).
        sendValueToBinding(
          tx,
          output,
          argumentCellLink,
          spaceSlot.getAsWriteRedirectLink(),
          source,
          { narrowestReadScope: "session" },
        );

        // The SHARED space slot is UNCHANGED — still → user.
        expect(
          areNormalizedLinksSame(
            parseLink(spaceSlot.getRaw() as never, spaceSlot)!,
            userSlot.getAsNormalizedFullLink(),
          ),
        ).toBe(true);
        // The run's own USER slot now → session.
        expect(
          areNormalizedLinksSame(
            parseLink(userSlot.getRaw() as never, userSlot)!,
            sessionSlot.getAsNormalizedFullLink(),
          ),
        ).toBe(true);
        // The value lands at the SESSION instance.
        expect(
          areNormalizedLinksSame(
            parseLink(sessionSlot.getRaw() as never, sessionSlot)!,
            { ...source.getAsNormalizedFullLink(), path: [] },
          ),
        ).toBe(true);
      } finally {
        resetServerExecutionConfig();
      }
    });

    it("does not stamp scoped asCell alias schemas onto write redirect links", () => {
      const output = runtime.getCell<{ value: unknown }>(
        space,
        "scoped asCell alias write redirect output",
        undefined,
        tx,
      );
      output.set({ value: null });
      const argumentCellLink = getMetaCell(output, "argument", tx)
        .getAsNormalizedFullLink();

      const userScopedValue = runtime.getCellFromLink(
        { ...output.key("value").getAsNormalizedFullLink(), scope: "user" },
        undefined,
        tx,
      );

      sendValueToBinding(
        tx,
        output,
        argumentCellLink,
        {
          $alias: {
            cell: "result",
            path: ["value"],
            schema: {
              type: "string",
              asCell: [{ kind: "cell", scope: "user" }],
            },
          },
        },
        "secret",
      );

      expect(output.key("value").getRaw()).toBe("secret");
      expect(userScopedValue.getRaw()).toBeUndefined();
    });
  });

  describe("mapBindingToCell", () => {
    it("should map bindings to cell aliases", () => {
      // Bindings are pseudo-links; the initial "internal" or "argument" determines how they are resolved
      const binding = {
        x: { $alias: { partialCause: "a", path: [] } },
        y: { $alias: { cell: "argument", path: ["b", "c"] } },
        z: 3,
      };
      const resultCell = runtime.getCell<{ a: number }>(
        space,
        "result cell",
        undefined,
        tx,
      );
      const argumentCell = runtime.getCell<{ b: { c: number } }>(
        space,
        "argument cell",
        undefined,
        tx,
      );
      argumentCell.set({ b: { c: 2 } });
      const result = unwrapOneLevelAndBindToDoc(
        binding,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
        { derivedInternalCells: [{ partialCause: "a" }] },
      );
      expect(
        areNormalizedLinksSame(
          parseLink(result.x, resultCell)!,
          getDerivedInternalCellLink(resultCell, {
            partialCause: "a",
          }),
        ),
      ).toBe(true);
      expect(
        areLinksSame(
          result.y,
          argumentCell.key("b").key("c").getAsWriteRedirectLink(),
        ),
      ).toBe(true);
    });

    it("binds result aliases without an argument link", () => {
      // collectResumeOwnedCells passes an undefined argument link when the
      // argument meta is not yet written (fresh run) or not yet synced (cold
      // resume); bindings that never touch the argument must still unwrap.
      const binding = {
        y: { $alias: { cell: "result", path: ["b"] } },
        z: 3,
      };
      const resultCell = runtime.getCell<{ b: number }>(
        space,
        "no argument link result cell",
        undefined,
        tx,
      );
      const result = unwrapOneLevelAndBindToDoc(
        binding,
        undefined,
        resultCell,
      );
      expect(
        areLinksSame(result.y, resultCell.key("b").getAsWriteRedirectLink()),
      ).toBe(true);
      expect(result.z).toBe(3);
    });

    it("throws when an argument alias binds without an argument link", () => {
      const binding = {
        y: { $alias: { cell: "argument", path: ["b"] } },
      };
      const resultCell = runtime.getCell<{ b: number }>(
        space,
        "missing argument link result cell",
        undefined,
        tx,
      );
      expect(() =>
        unwrapOneLevelAndBindToDoc(
          binding,
          undefined,
          resultCell,
        )
      ).toThrow("Cannot bind argument alias: no argument cell link available");
    });

    it("uses the argument link schema when converting aliases", () => {
      const profileSchema = {
        type: "object",
        scope: "user",
        default: { name: "Ada" },
        ifc: { confidentiality: ["profile"] },
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      } as const;
      const argumentSchema = {
        type: "object",
        properties: {
          profile: profileSchema,
        },
        required: ["profile"],
      } as const;
      const binding = {
        profile: { $alias: { cell: "argument", path: ["profile"] } },
      };
      const resultCell = runtime.getCell(
        space,
        "schema fallback result cell",
        undefined,
        tx,
      );
      const argumentCell = runtime.getCell(
        space,
        "schema fallback argument cell",
        argumentSchema,
        tx,
      );
      const result = unwrapOneLevelAndBindToDoc(
        binding,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      ) as { profile: unknown };

      const parsed = parseLink(result.profile, resultCell)!;
      expect({ ...parsed, schema: resolvedSchema(parsed.schema) }).toEqual({
        ...argumentCell.getAsNormalizedFullLink(),
        path: ["profile"],
        // The link keeps the argument cell's scope; the declared scope stays
        // in the schema, realized when the link is read or written.
        schema: profileSchema,
        overwrite: "redirect",
        // parseLink of a sigil stamps the read-side data-derived mark (OW51).
        viaLinkHop: true,
      });
    });

    it("carries a handle cap an argument path passes through onto a nested binding", () => {
      const binding = {
        name: { $alias: { cell: "argument", path: ["profile", "name"] } },
      };
      const resultCell = runtime.getCell(
        space,
        "nested handle cap result cell",
        undefined,
        tx,
      );
      // A link schema drops cell wrappers, so the argument link does not show
      // the handle's cap; the authored argument schema does.
      const argumentCell = runtime.getCell(
        space,
        "nested handle cap argument cell",
        {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
        tx,
      );
      const result = unwrapOneLevelAndBindToDoc(
        binding,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
        {
          argumentCapSchema: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: { name: { type: "string" } },
                asCell: [{ kind: "cell", scope: "user" }],
              },
            },
          },
        },
      ) as { name: unknown };

      const parsed = parseLink(result.name, resultCell)!;
      expect(parsed.scope).toBe("space");
      expect(resolvedSchema(parsed.schema)).toEqual({
        type: "string",
        scope: "user",
      });
    });

    it("binds aliases from a caller-owned circular schema", () => {
      const circularSchema: JSONSchema & {
        properties: Record<string, JSONSchema>;
      } = {
        type: "object",
        properties: {},
      };
      circularSchema.properties.self = circularSchema;
      const resultCell = runtime.getCell(
        space,
        "circular schema result cell",
        undefined,
        tx,
      );
      const argumentCell = runtime.getCell(
        space,
        "circular schema argument cell",
        undefined,
        tx,
      );
      const argumentLink = {
        ...argumentCell.getAsNormalizedFullLink(),
        schema: circularSchema,
      };

      const result = unwrapOneLevelAndBindToDoc(
        { self: { $alias: { cell: "argument", path: ["self"] } } },
        argumentLink,
        resultCell,
      );

      const parsed = parseLink(result.self, resultCell)!;
      expect(Object.isFrozen(circularSchema)).toBe(false);
      expect(parsed.path).toEqual(["self"]);
      expect(resolvedSchema(parsed.schema)).toEqual({
        $ref: "#/$defs/CircularSchema_0",
        $defs: {
          CircularSchema_0: {
            type: "object",
            properties: {
              self: { $ref: "#/$defs/CircularSchema_0" },
            },
          },
        },
      });
    });

    it("serializes returned local pattern cells as aliases", () => {
      const frame = pushFrame({
        runtime,
        tx,
        space,
        cause: { test: "returned local pattern cells are aliases" },
      });
      try {
        const { pattern, Writable } = createTrustedBuilder(runtime)
          .commonfabric;
        const Root = pattern(() => {
          const name = Writable.of("Ada").for("name", true);
          return { name };
        });

        const nameBinding = (Root.result as { name: unknown }).name;
        expect(isAliasBinding(nameBinding)).toBe(true);
        expect(nameBinding).toEqual({
          $alias: {
            partialCause: "name",
            path: [],
            scope: "space",
            schema: externalRefTo({ default: "Ada" }),
          },
        });
      } finally {
        popFrame(frame);
      }
    });

    it("decrements deferred legacy aliases inside pattern values", () => {
      const resultCell = runtime.getCell(
        space,
        "deferred legacy aliases inside unbound pattern values",
        undefined,
        tx,
      );
      const argumentCell = getMetaCell(resultCell, "argument", tx);
      const nestedPattern = {
        argumentSchema: {},
        resultSchema: {},
        result: {
          $alias: { partialCause: "result", path: [], defer: 1 },
        },
        nodes: [
          {
            module: { type: "javascript", implementation: () => undefined },
            inputs: {
              value: {
                $alias: { cell: "argument", path: ["value"], defer: 1 },
              },
              later: {
                $alias: { partialCause: "later", path: [], defer: 2 },
              },
              nested: {
                argumentSchema: {},
                resultSchema: {},
                result: {
                  $alias: {
                    partialCause: "nested-result",
                    path: [],
                    defer: 2,
                  },
                },
                nodes: [],
              },
            },
            outputs: {
              $alias: { partialCause: "output", path: [], defer: 1 },
            },
          },
        ],
      };

      const result = unwrapOneLevelAndBindToDoc(
        { op: nestedPattern },
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
      ) as { op: typeof nestedPattern };

      expect(result.op.result).toEqual({
        $alias: { partialCause: "result", path: [] },
      });
      expect(result.op.nodes[0].inputs.value).toEqual({
        $alias: { cell: "argument", path: ["value"] },
      });
      expect(result.op.nodes[0].inputs.later).toEqual({
        $alias: { partialCause: "later", path: [], defer: 1 },
      });
      expect(result.op.nodes[0].inputs.nested.result).toEqual({
        $alias: { partialCause: "nested-result", path: [], defer: 1 },
      });
      expect(result.op.nodes[0].outputs).toEqual({
        $alias: { partialCause: "output", path: [] },
      });
    });
  });

  describe("unwrapOneLevelAndBindToDoc structure sharing", () => {
    /** Binds `binding`, with one derived internal cell named `"a"` available. */
    const bind = <T>(binding: T): T => {
      const resultCell = runtime.getCell(
        space,
        `share ${crypto.randomUUID()}`,
        undefined,
        tx,
      );
      const argumentCell = runtime.getCell(
        space,
        `share arg ${crypto.randomUUID()}`,
        undefined,
        tx,
      );
      return unwrapOneLevelAndBindToDoc(
        binding as never,
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
        { derivedInternalCells: [{ partialCause: "a" }] },
      ) as T;
    };

    const alias = () => ({ $alias: { partialCause: "a", path: [] } });

    it("returns a binding with nothing to rebind by identity", () => {
      const binding = { x: 1, deep: { y: ["a", "b"] } };
      const result = bind(binding);
      expect(result).toBe(binding);
      expect(result.deep).toBe(binding.deep);
      expect(result.deep.y).toBe(binding.deep.y);
    });

    it("copies only the path to a rebound alias, sharing its siblings", () => {
      const untouched = { deep: [1, 2, 3] };
      const binding = { changed: { inner: alias() }, untouched };
      const result = bind(binding);

      // The root and the branch containing the alias are copies...
      expect(result).not.toBe(binding);
      expect(result.changed).not.toBe(binding.changed);
      // ...while a sibling subtree with nothing to rebind is the same object.
      expect(result.untouched).toBe(untouched);
      expect(result.untouched.deep).toBe(untouched.deep);
    });

    it("shares an array whose elements all convert to themselves", () => {
      const inner = [1, 2];
      const binding = { list: [inner, "x"] };
      const result = bind(binding);
      expect(result).toBe(binding);
      expect(result.list[0]).toBe(inner);
    });

    it("preserves holes when a sibling element rebinds", () => {
      // deno-lint-ignore no-sparse-arrays
      const binding = [alias(), , "third"] as unknown[];
      const result = bind(binding);

      expect(result).not.toBe(binding);
      expect(result.length).toBe(3);
      expect(1 in result).toBe(false); // still a hole, not `undefined`
      expect(result[2]).toBe("third");
      expect(isAliasBinding(result[0])).toBe(false); // it did rebind
    });

    it("keeps the length of an array whose trailing elements are holes", () => {
      const binding = [alias()] as unknown[];
      binding.length = 4;
      const result = bind(binding);

      expect(result.length).toBe(4);
      for (const i of [1, 2, 3]) expect(i in result).toBe(false);
    });

    it("keeps a FabricPrimitive whole instead of flattening it", () => {
      // A `FabricPrimitive` keeps its state in private fields, so
      // `Object.entries()` reports none of it. A name-driven rebuild of the
      // enclosing record therefore used to replace it with a bare `{}`.
      const stamp = new FabricEpochNsec(123n);
      const shared = bind({ stamp, n: 1 });
      expect(shared.stamp).toBeInstanceOf(FabricEpochNsec);
      expect(shared.stamp).toBe(stamp);

      // ...and it survives the COPY path too, where a sibling rebinds.
      const copied = bind({ stamp, aliased: alias() });
      expect(copied).not.toBe(undefined);
      expect(copied.stamp).toBeInstanceOf(FabricEpochNsec);
      expect(copied.stamp).toBe(stamp);

      // Same at the root, and inside an array.
      expect(bind(stamp)).toBe(stamp);
      expect(bind([stamp, alias()])[0]).toBe(stamp);
    });

    it("throws on a FabricInstance rather than handing it back unbound", () => {
      // A `FabricInstance` is a CONTAINER of other `FabricValue`s, reached by
      // its codec contents rather than by property name. This walk cannot yet
      // descend one, and handing it back whole would read as success while
      // leaving a bound alias in its contents silently unbound.
      const err = FabricError.fromNativeError(new Error("boom"));

      expect(() => bind({ err })).toThrow("FabricError");
      // ...at the root, and inside an array, on both the shared and copy paths.
      expect(() => bind(err)).toThrow("FabricError");
      expect(() => bind([err])).toThrow("FabricError");
      expect(() => bind({ err, aliased: alias() })).toThrow("FabricError");
    });

    it("hands an Array subclass's species the same length `map()` would", () => {
      // Regression: an earlier lazy copy used `slice(0, i)`, which passes the
      // PREFIX length to `ArraySpeciesCreate`, where `map()` passes the full
      // length. Only a custom `Symbol.species` can observe the difference.
      const lengths: number[] = [];
      class Spy extends Array {
        constructor(...args: unknown[]) {
          lengths.push(args[0] as number);
          super(...(args as []));
        }
      }
      class Watched extends Array {
        /**
         * The species, cast: `ArrayConstructor` is what the base class declares
         * here, and `Spy` does not structurally satisfy it (no
         * callable-without-`new` form). The cast is the point of the fixture:
         * an exotic species is exactly what is under test.
         */
        static override get [Symbol.species](): ArrayConstructor {
          return Spy as unknown as ArrayConstructor;
        }
      }
      // A rebind at the LAST index, so a prefix-sized copy would differ most.
      const binding = Watched.from(["a", "b", alias()]) as unknown[];

      lengths.length = 0;
      binding.map((x) => x);
      const viaMap = [...lengths];

      lengths.length = 0;
      bind(binding);
      expect(lengths).toEqual(viaMap);
    });
  });

  describe("causalFormOfBinding", () => {
    /** Reduces `binding`, typed as the sibling `bind()` helper above is. */
    const reduce = <T>(binding: T): T =>
      causalFormOfBinding(binding as never) as T;

    /** A link carrying a schema, as a bound binding holds one. */
    const linkWithSchema = () =>
      runtime.getCell(space, `causal ${crypto.randomUUID()}`, undefined, tx)
        .asSchema({ type: "object", properties: { v: { type: "number" } } })
        .getAsLink({ includeSchema: true });

    it("returns a link naming the same cell with no schema on it", () => {
      const link = linkWithSchema();
      const before = parseLink(link)!;
      expect(before.schema).not.toBeUndefined();

      const after = parseLink(reduce({ x: link }).x)!;
      expect(after.schema).toBeUndefined();
      expect(areNormalizedLinksSame(after, before)).toBe(true);
    });

    it("reduces a link nested inside a binding", () => {
      const binding = { $ctx: { deep: [{ items: linkWithSchema() }] } };
      const reduced = reduce(binding);
      expect(parseLink(reduced.$ctx.deep[0].items)!.schema).toBeUndefined();
    });

    it("returns a binding with no link schema to drop by identity", () => {
      const binding = { x: 1, deep: { y: ["a", "b"] } };
      expect(reduce(binding)).toBe(binding);
    });

    it("copies only the path to a reduced link, sharing its siblings", () => {
      const untouched = { deep: [1, 2, 3] };
      const binding = { changed: { inner: linkWithSchema() }, untouched };
      const reduced = reduce(binding);

      expect(reduced).not.toBe(binding);
      expect(reduced.changed).not.toBe(binding.changed);
      expect(reduced.untouched).toBe(untouched);
      expect(reduced.untouched.deep).toBe(untouched.deep);
    });

    it("preserves holes when a sibling element reduces", () => {
      // deno-lint-ignore no-sparse-arrays
      const binding = [linkWithSchema(), , "third"] as unknown[];
      const reduced = reduce(binding);

      expect(reduced).not.toBe(binding);
      expect(reduced.length).toBe(3);
      expect(1 in reduced).toBe(false);
      expect(reduced[2]).toBe("third");
    });

    it("returns a link carrying only addressing members by identity", () => {
      const link = runtime
        .getCell(space, `bare ${crypto.randomUUID()}`, undefined, tx)
        .getAsLink();
      const binding = { x: link };
      expect(reduce(binding)).toBe(binding);
    });

    it("drops a cfc label view riding on a link", () => {
      // The label view is a flow-control side channel, and cfc's own module
      // calls it no part of a link's addressing identity -- so it is no part
      // of what names a node either.
      const link = runtime
        .getCell(space, `labeled ${crypto.randomUUID()}`, undefined, tx)
        .getAsLink();
      setLinkCfcLabelView(link, {} as never);
      expect(linkCfcLabelView(link)).not.toBeUndefined();

      const reduced = reduce({ x: link }).x;
      expect(linkCfcLabelView(reduced)).toBeUndefined();
      expect(areNormalizedLinksSame(parseLink(reduced)!, parseLink(link)!))
        .toBe(true);
    });

    it("returns a link envelope holding no payload record as it stands", () => {
      // `isSigilLink()` vets the envelope, not what sits inside it, so a
      // payload that is not a record reaches the reduction. It addresses
      // nothing and there is nothing to read off it.
      const binding = { x: { "/": { [LINK_V1_TAG]: null } } };
      expect(reduce(binding)).toBe(binding);
    });

    it("leaves a deferred `$alias` as it stands", () => {
      // An alias is a binding on its way to a nested pattern, not a link, and
      // its schema is that pattern's structure rather than this node's cause.
      const binding = {
        a: {
          $alias: { cell: "argument", defer: 1, path: ["v"], schema: true },
        },
      };
      const reduced = reduce(binding);
      expect(reduced).toBe(binding);
      expect(isAliasBinding(reduced.a)).toBe(true);
    });

    it("leaves the binding it was handed unchanged", () => {
      const binding = { x: linkWithSchema() };
      const before = JSON.stringify(binding);
      reduce(binding);
      expect(JSON.stringify(binding)).toBe(before);
    });
  });

  describe("findAllWriteRedirectCells", () => {
    it("should not find non-unwrapped alias binding", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "single legacy",
        undefined,
        tx,
      );
      testCell.set({ foo: 123 });
      const binding = { $alias: { cell: "result", path: ["foo"] } };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(0);

      const unwrappedBinding = unwrapOneLevelAndBindToDoc(
        binding,
        testCell.getAsNormalizedFullLink(),
        testCell,
      );
      const unwrappedLinks = findAllWriteRedirectCells(
        unwrappedBinding,
        testCell,
      );
      expect(unwrappedLinks.length).toBe(1);
      expect(unwrappedLinks[0].path).toEqual(["foo"]);
      expect(unwrappedLinks[0].id).toBeDefined();
      expect(unwrappedLinks[0].space).toBe(space);
    });

    it("should ignore deferred legacy aliases", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "deferred legacy aliases",
        undefined,
        tx,
      );
      testCell.set({ foo: 1 });
      const binding = {
        deferredArgument: {
          $alias: { cell: "argument", path: ["foo"], defer: 1 },
        },
        deferredInternal: {
          $alias: { partialCause: "local", path: [], defer: 1 },
        },
        immediate: { $alias: { cell: "result", path: ["foo"] } },
      };

      // Unwrapping converts the immediate alias to a sigil link; the deferred
      // aliases survive as aliases (defer crossed, next level's wiring) and
      // stay invisible to the walker.
      const unwrappedBinding = unwrapOneLevelAndBindToDoc(
        binding,
        testCell.getAsNormalizedFullLink(),
        testCell,
      );
      const links = findAllWriteRedirectCells(unwrappedBinding, testCell);
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
    });

    it("does not walk into embedded Pattern values", () => {
      // An embedded pattern's sigil links and aliases are its own binding
      // vocabulary, resolved when THAT pattern is instantiated — not reads of
      // the node carrying it.
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "embedded pattern",
        undefined,
        tx,
      );
      testCell.set({ foo: 123 });
      const embeddedPattern = {
        argumentSchema: true,
        resultSchema: {},
        result: {
          doubled: { $alias: { cell: "argument", path: ["x"] } },
        },
        nodes: [{
          module: { type: "javascript" },
          inputs: testCell.key("foo").getAsWriteRedirectLink({
            base: testCell,
          }),
          outputs: {},
        }],
      };
      const binding = {
        template: embeddedPattern,
        direct: testCell.key("foo").getAsWriteRedirectLink({ base: testCell }),
      };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["foo"]]);
    });

    it("follows a chain of write redirects (redirect -> redirect)", () => {
      const testCell = runtime.getCell<Record<string, unknown>>(
        space,
        "redirect chain",
        undefined,
        tx,
      );
      // Build p -> q -> r, where each of p and q HOLDS a write-redirect (a
      // redirect whose target value is itself a redirect), and r is a plain
      // value. A literal `$alias` in a set() value is resolved on write, so we
      // store real sigil write-redirects via getAsWriteRedirectLink.
      testCell.set({ r: 99 });
      testCell.key("q").set(
        testCell.key("r").getAsWriteRedirectLink({ base: testCell }),
      );
      testCell.key("p").set(
        testCell.key("q").getAsWriteRedirectLink({ base: testCell }),
      );
      // The binding redirects to p; the chain p -> q -> r is followed, stopping
      // at the non-redirect value 99.
      const binding = testCell.key("p").getAsWriteRedirectLink({
        base: testCell,
      });
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["p"], ["q"], ["r"]]);
    });

    it("does not dive into a non-redirect target to find nested redirects", () => {
      const testCell = runtime.getCell<Record<string, unknown>>(
        space,
        "nested non-redirect target",
        undefined,
        tx,
      );
      testCell.set({ x: 7 });
      // 'a' holds an OBJECT (a non-redirect) that CONTAINS a nested write
      // redirect. Following the `a` redirect stops at that object — we do NOT
      // walk into it, so the nested `inner` redirect is never discovered.
      testCell.key("a").set({
        inner: testCell.key("x").getAsWriteRedirectLink({ base: testCell }),
        plain: 1,
      });
      const binding = testCell.key("a").getAsWriteRedirectLink({
        base: testCell,
      });
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["a"]]);
    });

    it("resolves a chained redirect relative to its own document, not the base cell", () => {
      // Cross-document chain: the binding (resolved against cellA) redirects to
      // cellB's `mid`, whose value is a *relative* redirect to `x`. That nested
      // redirect must resolve against cellB (the doc it lives in), not cellA. If
      // the recursion re-based onto cellA, the second link would carry cellA's id.
      const cellA = runtime.getCell<Record<string, unknown>>(
        space,
        "xdoc chain A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<Record<string, unknown>>(
        space,
        "xdoc chain B",
        undefined,
        tx,
      );
      cellB.set({ x: 55 });
      cellB.key("mid").set(
        cellB.key("x").getAsWriteRedirectLink({ base: cellB }),
      );
      const binding = cellB.key("mid").getAsWriteRedirectLink({ base: cellA });
      const links = findAllWriteRedirectCells(binding, cellA);
      const bId = cellB.getAsNormalizedFullLink().id;
      expect(links.map((l) => ({ id: l.id, path: l.path }))).toEqual([
        { id: bId, path: ["mid"] },
        { id: bId, path: ["x"] },
      ]);
    });

    it("follows a chain whose redirect link carries a schema", () => {
      // A schema on the binding link leaves the chain the walk yields
      // unchanged. What the schema decides is which hops resolution may
      // follow on the way, which the case below measures.
      const testCell = runtime.getCell<Record<string, unknown>>(
        space,
        "schema-bearing chain",
        undefined,
        tx,
      );
      testCell.set({ x: 3 });
      testCell.key("mid").set(
        testCell.key("x").getAsWriteRedirectLink({ base: testCell }),
      );
      const binding = createSigilLinkFromParsedLink(
        {
          ...testCell.key("mid").getAsNormalizedFullLink(),
          schema: { type: "number" },
        },
        { includeSchema: true, overwrite: "redirect" },
      );
      expect(parseLink(binding, testCell).schema).toBeDefined();
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.map((l) => l.path)).toEqual([["mid"], ["x"]]);
    });

    it("stops at a hop the redirect link's schema caps out of reach", () => {
      // Resolution follows the links on the way to the redirect's position
      // under the schema the link carries, and that schema's scope cap decides
      // which of them it may follow. The chain runs through a session-scoped
      // document: a link capped at `space` cannot reach it, so the walk ends at
      // the redirect, and the same link capped at `any` walks on into it.
      const sessionCell = createCell<Record<string, unknown>>(
        runtime,
        {
          ...runtime.getCell(
            space,
            "capped chain session target",
            undefined,
            tx,
          ).getAsNormalizedFullLink(),
          scope: "session",
        },
        tx,
      );
      sessionCell.set({ z: 9 });
      sessionCell.key("y").set(
        sessionCell.key("z").getAsWriteRedirectLink({ base: sessionCell }),
      );
      const outer = runtime.getCell<Record<string, unknown>>(
        space,
        "capped chain outer",
        undefined,
        tx,
      );
      outer.set({ hop: sessionCell });

      const redirectThroughHop = (scope: "space" | "any") =>
        findAllWriteRedirectCells(
          createSigilLinkFromParsedLink(
            {
              ...outer.getAsNormalizedFullLink(),
              path: ["hop", "y"],
              schema: { type: "number", scope },
            },
            { includeSchema: true, overwrite: "redirect" },
          ),
          outer,
        );

      expect(redirectThroughHop("space").map((l) => l.path))
        .toEqual([["hop", "y"]]);
      expect(redirectThroughHop("any").map((l) => l.path))
        .toEqual([["hop", "y"], ["z"]]);
    });

    it("should find all write redirect links in an array", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "array legacy",
        undefined,
        tx,
      );
      testCell.set({ arr: [1, 2, 3] });
      const binding = [
        { $alias: { cell: "result", path: ["arr", "0"] } },
        { $alias: { cell: "result", path: ["arr", "1"] } },
        { $alias: { cell: "result", path: ["arr", "2"] } },
      ];
      const links = findAllWriteRedirectCells(
        unwrapOneLevelAndBindToDoc(
          binding,
          testCell.getAsNormalizedFullLink(),
          testCell,
        ),
        testCell,
      );
      expect(links.length).toBe(3);
      expect(links.map((l) => l.path)).toEqual([
        ["arr", "0"],
        ["arr", "1"],
        ["arr", "2"],
      ]);
    });

    it("should find write redirect links in an object with multiple links", () => {
      const testCell = runtime.getCell<{ x: number; y: number }>(
        space,
        "object legacy",
        undefined,
        tx,
      );
      testCell.set({ x: 1, y: 2 });
      const binding = {
        a: { $alias: { cell: "result", path: ["x"] } },
        b: { $alias: { cell: "result", path: ["y"] } },
        c: 3,
      };
      const links = findAllWriteRedirectCells(
        unwrapOneLevelAndBindToDoc(
          binding,
          testCell.getAsNormalizedFullLink(),
          testCell,
        ),
        testCell,
      );
      expect(links.length).toBe(2);
      expect(links.map((l) => l.path)).toEqual([["x"], ["y"]]);
    });

    it("should return empty array if there are no write redirect links", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "no links",
        undefined,
        tx,
      );
      testCell.set({ foo: 1 });
      const binding = { bar: 2 };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(0);
    });

    it("should find write redirect links using sigil format", () => {
      const testCell = runtime.getCell<{ foo: number }>(
        space,
        "sigil link",
        undefined,
        tx,
      );
      testCell.set({ foo: 99 });
      const links = findAllWriteRedirectCells(
        testCell.key("foo").getAsWriteRedirectLink({ base: testCell }),
        testCell,
      );
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
      expect(links[0].id).toBeDefined();
      expect(links[0].space).toBe(space);
    });
  });
});
