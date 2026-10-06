/**
 * What the CFC output-labeling walk does with values it cannot label.
 *
 * A `FabricSpecialObject` has zero enumerable own properties, so the walk's
 * `Object.entries()` descent ends at it. That costs a `FabricPrimitive`
 * nothing -- a leaf holds no cell to label -- but for a `FabricInstance` it
 * means a cell in its codec contents goes _unlabeled_, so the walk refuses
 * one instead.
 *
 * A cell carrying a cause or a link refuses the schema the walk writes, and
 * the walk lets that throw. The cause case below holds that contract. Every
 * production caller hands the walk a cell minted for the node being wired, so
 * the case reaches the throw through the helper directly, and what it pins is
 * that a label the walk cannot attach stops its caller.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { applyInputIfcToOutput } from "../src/builder/node-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test node utils");
const space = signer.did();

describe("node-utils", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createTrustedBuilder>["commonfabric"]["Cell"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric: { Cell } } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  function withinHandler<T>(fn: () => T): T {
    const pushed = pushFrame(
      {
        runtime,
        space,
        tx,
        cause: { test: "node-utils" },
        generatedIdCounter: 0,
        inHandler: true,
        unsafe_binding: { space, tx },
        // deno-lint-ignore no-explicit-any
      } as any,
    );
    try {
      return fn();
    } finally {
      popFrame(pushed);
    }
  }

  describe("applyInputIfcToOutput", () => {
    it("labels an output cell sitting beside a `FabricBytes`", () => {
      withinHandler(() => {
        // The discriminating shape. A special object alone would only show
        // that the walk does not crash; a labellable cell BESIDE one shows the
        // walk still reaches its siblings rather than ending at the special
        // object.
        const input = new Cell("classified", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });
        const target = new Cell("out", { type: "string" });
        const outputs = {
          bytes: new FabricBytes(new Uint8Array([1, 2, 3])),
          target,
        };

        applyInputIfcToOutput({ input }, outputs);

        // deno-lint-ignore no-explicit-any
        expect((target as any).schema?.ifc?.confidentiality).toContain(
          "secret",
        );
      });
    });

    it("throws for a `FabricError` holding a cell rather than skipping it", () => {
      withinHandler(() => {
        // The control is the point: the same cell _is_ labeled when it sits in
        // a plain record, so what changes the outcome is the wrapper.
        const input = new Cell("classified", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });
        const plain = new Cell("out", { type: "string" });

        applyInputIfcToOutput({ input }, { target: plain });
        // deno-lint-ignore no-explicit-any
        expect((plain as any).schema?.ifc?.confidentiality).toContain("secret");

        const held = new Cell("out", { type: "string" });
        const wrapper = new FabricError({
          type: "Error",
          message: "boom",
          stack: undefined,
          cause: undefined,
          extras: { held: held as unknown as FabricValue },
        });

        expect(() => applyInputIfcToOutput({ input }, { w: wrapper })).toThrow(
          "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
            "attaching CFC labels to outputs.",
        );
      });
    });

    it("throws for an output cell that already carries a cause", () => {
      withinHandler(() => {
        // The control is the same one the `FabricError` case uses: a causeless
        // cell in the same position takes the label, so what changes the
        // outcome is the cause.
        const input = new Cell("classified", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });
        const causeless = new Cell("out", { type: "string" });

        applyInputIfcToOutput({ input }, { target: causeless });
        // deno-lint-ignore no-explicit-any
        expect((causeless as any).schema?.ifc?.confidentiality).toContain(
          "secret",
        );

        const named = Cell.for<string>("named");

        expect(() => applyInputIfcToOutput({ input }, { target: named }))
          .toThrow("Cannot setSchema: cell already has a cause or link.");
      });
    });

    it("leaves a `FabricBytes` output as the same instance", () => {
      withinHandler(() => {
        const input = new Cell("classified", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });
        const bytes = new FabricBytes(new Uint8Array([4, 5]));
        const outputs = { bytes, target: new Cell("out", { type: "string" }) };

        applyInputIfcToOutput({ input }, outputs);

        // This walk labels in place and returns nothing, so the value it was
        // handed must come out untouched -- it is the caller's output tree.
        expect(outputs.bytes).toBe(bytes);
      });
    });
  });
});
