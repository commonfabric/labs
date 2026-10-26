import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { isAliasBinding } from "../src/alias-binding.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { type Pattern } from "../src/builder/types.ts";
import {
  getDerivedInternalCell,
  isCellLink,
  isWriteRedirectLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("alias-binding", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("isAliasBinding()", () => {
    it("returns `true` for a named-cell binding naming the argument cell", () => {
      expect(isAliasBinding({ $alias: { cell: "argument", path: ["a"] } }))
        .toBe(true);
    });

    it("returns `true` for a named-cell binding naming the result cell", () => {
      expect(isAliasBinding({ $alias: { cell: "result", path: [] } }))
        .toBe(true);
    });

    it("returns `true` for a `partialCause` binding", () => {
      expect(
        isAliasBinding({
          $alias: { partialCause: { $generated: 0 }, path: [], scope: "user" },
        }),
      ).toBe(true);
    });

    it("returns `true` for a deferred binding", () => {
      expect(
        isAliasBinding({ $alias: { cell: "argument", path: [], defer: 2 } }),
      ).toBe(true);
    });

    it("returns `false` for a record naming neither a cell nor a cause", () => {
      expect(isAliasBinding({ $alias: { path: ["a"] } })).toBe(false);
    });

    it("returns `false` for a record whose `cell` is an entity id", () => {
      const cell = runtime.getCell(space, "alias binding with entity id");
      expect(isAliasBinding({ $alias: { cell: cell.entityId, path: [] } }))
        .toBe(false);
    });

    it("returns `false` for a record with no `path`", () => {
      expect(isAliasBinding({ $alias: { cell: "argument" } })).toBe(false);
    });

    it("returns `false` for values that are not `$alias` records at all", () => {
      expect(isAliasBinding({ notAlias: "value" })).toBe(false);
      expect(isAliasBinding({ $alias: "not a record" })).toBe(false);
      expect(isAliasBinding("string")).toBe(false);
      expect(isAliasBinding(undefined)).toBe(false);
    });
  });

  describe("the link model", () => {
    // Every shape the binding admits, so a link predicate that started
    // matching one of them is caught here rather than in whichever walk
    // followed it into the wrong document.
    const bindings = [
      { $alias: { cell: "argument", path: ["input"] } },
      { $alias: { cell: "result", path: [] } },
      { $alias: { partialCause: "output", path: [], scope: "user" } },
      { $alias: { cell: "argument", path: [], defer: 1 } },
    ];

    it("does not recognize any `$alias` binding as a link", () => {
      for (const binding of bindings) {
        expect(isCellLink(binding)).toBe(false);
        expect(isWriteRedirectLink(binding)).toBe(false);
      }
    });

    it("returns `undefined` when asked to parse an `$alias` binding as a link", () => {
      const base = runtime.getCell(space, "alias binding parse base");
      for (const binding of bindings) {
        expect(parseLink(binding, base)).toBeUndefined();
      }
    });
  });

  describe("saved pattern graphs", () => {
    // Saved graphs are durable data: stored pattern node graphs hold `$alias`
    // records, so the runner reads every shape of them for as long as those
    // graphs exist. These are hand-written graphs rather than compiler output
    // for that reason — they stand in for what is already stored.
    it("runs a stored graph whose bindings name the argument and result cells", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: {
            input: { type: "number" },
            output: { type: "number" },
          },
        },
        resultSchema: {},
        result: { output: { $alias: { cell: "argument", path: ["output"] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (value: number) => value * 2,
            },
            inputs: { $alias: { cell: "argument", path: ["input"] } },
            outputs: { $alias: { cell: "argument", path: ["output"] } },
          },
        ],
      };

      const tx = runtime.edit();
      const inputCell = runtime.getCell<{ input: number; output: number }>(
        space,
        "stored graph naming argument and result: input",
        undefined,
        tx,
      );
      inputCell.set({ input: 21, output: 0 });
      await tx.commit().settled;

      const resultCell = runtime.getCell(
        space,
        "stored graph naming argument and result",
      );
      const result = runtime.run(
        undefined,
        trustExecutable(runtime, pattern) as never,
        inputCell as never,
        resultCell as never,
      );

      expect(await result.pull()).toEqual({ output: 42 });
    });

    it("runs a stored graph whose binding derives an internal cell from a partial cause", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        derivedInternalCells: [{ partialCause: "output" }],
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (value: number) => value + 1,
            },
            inputs: { $alias: { cell: "argument", path: ["input"] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(
        space,
        "stored graph deriving an internal cell",
      );
      const result = runtime.run(
        undefined,
        trustExecutable(runtime, pattern) as never,
        { input: 41 } as never,
        resultCell as never,
      );

      expect(await result.pull()).toEqual({ output: 42 });
      // The binding named a document to mint, so the value landed in the
      // derived internal cell rather than anywhere addressable at save time.
      expect(
        getDerivedInternalCell(resultCell, { partialCause: "output" }).get(),
      ).toBe(42);
    });

    it("runs a stored graph whose nested pattern carries deferred bindings", async () => {
      const innerPattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { $alias: { partialCause: "output", path: [], defer: 1 } },
        nodes: [
          {
            module: { type: "passthrough" },
            inputs: {
              value: {
                $alias: { cell: "argument", path: ["input"], defer: 1 },
              },
            },
            outputs: {
              value: { $alias: { partialCause: "output", path: [], defer: 1 } },
            },
          },
        ],
      };

      const outerPattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
        },
        resultSchema: {},
        result: { result: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: { type: "pattern", implementation: innerPattern },
            inputs: {
              input: { $alias: { cell: "argument", path: ["value"] } },
            },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(
        space,
        "stored graph with deferred bindings",
      );
      const result = runtime.run(
        undefined,
        trustExecutable(runtime, outerPattern) as never,
        { value: 7 } as never,
        resultCell as never,
      );

      expect(await result.pull()).toEqual({ result: 7 });
    });

    it("carries an alias binding's own schema onto the link it is bound to", async () => {
      // What is under test is that the BINDING's schema reaches the link it
      // binds to, not how a link writer encodes a schema. Reference emission
      // is flag-gated (`contentAddressedSchemas`), so pin it off here and the
      // assertion holds whatever the build's default is.
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        derivedInternalCells: [{ partialCause: "output" }],
        result: {
          output: {
            $alias: {
              partialCause: "output",
              path: [],
              schema: { type: "number" },
            },
          },
        },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (value: number) => value * 3,
            },
            inputs: { $alias: { cell: "argument", path: ["input"] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      setContentAddressedSchemasConfig(false);
      try {
        const resultCell = runtime.getCell(
          space,
          "stored graph with a schema-bearing binding",
        );
        const result = runtime.run(
          undefined,
          trustExecutable(runtime, pattern) as never,
          { input: 5 } as never,
          resultCell as never,
        );

        await result.pull();
        const stored = (result.getRaw() as { output: unknown }).output;
        expect(isWriteRedirectLink(stored)).toBe(true);
        expect(parseLink(stored, result)!.schema).toEqual({ type: "number" });
      } finally {
        resetContentAddressedSchemasConfig();
      }
    });
  });
});
