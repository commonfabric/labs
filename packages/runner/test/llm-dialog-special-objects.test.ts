/**
 * The two walks in `llm-dialog.ts` that carry a `FabricValue` give the two
 * special-object kinds opposite treatment, and neither is the object branch. A
 * `FabricPrimitive` is a leaf and stands whole, where a walk that rebuilt it
 * from its entries would hand the model a bare `{}`. A `FabricInstance` is a
 * container reached by its codec contents, which neither walk can do, so each
 * refuses rather than flattening one.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const { serializeForLLMObservation, traverseAndCellify } = llmDialogTestHelpers;

const signer = await Identity.fromPassphrase("llm dialog special objects");
const space = signer.did();

/** A runtime stand-in: neither walk should ask it for a cell here. */
const noCellRuntime = {
  getCellFromLink() {
    throw new Error("should not be called for a special object");
  },
};

describe("llm-dialog-special-objects", () => {
  describe("serializeForLLMObservation", () => {
    it("returns a `FabricBytes` whole rather than as an empty record", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      const result = serializeForLLMObservation({ value: { payload: bytes } });

      // `toBeInstanceOf` is the assertion that can fail here: a flattened `{}`
      // is `toEqual`-equal to a `FabricBytes`, which has no enumerable members,
      // so that matcher alone would pass against the very bug this pins.
      const { payload } = result.value as { payload: unknown };
      expect(payload).toBeInstanceOf(FabricBytes);
      expect((payload as FabricBytes).slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("returns a `FabricEpochNsec` whole from inside an array", () => {
      // The array branch reaches the same leaf, by a different route than the
      // record branch above.
      const when = new FabricEpochNsec(1_000_000_000n);
      const result = serializeForLLMObservation({ value: [when] });

      const [element] = result.value as unknown[];
      expect(element).toBeInstanceOf(FabricEpochNsec);
      expect((element as FabricEpochNsec).value).toBe(1_000_000_000n);
    });

    it("throws for a `FabricInstance` rather than flattening one", () => {
      const instance = FabricError.fromNativeError(new Error("boom"));

      expect(() => serializeForLLMObservation({ value: { failure: instance } }))
        .toThrow(
          "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
            "serializing a value for a language model.",
        );
    });
  });

  describe("reading back through a cell", () => {
    // The tests above hand the walk a value built in place. What this function
    // actually serializes is a value read back out of a cell, and the read path
    // does not hand back what was written: it wraps a plain container in a
    // view, and hands back a special object as itself. Only driving the walk
    // from a real cell shows what arrives.

    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
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

    function readBack(written: unknown): Record<string, unknown> {
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "llm-special-objects",
        undefined,
        tx,
      );
      cell.set(written as Record<string, unknown>);
      return serializeForLLMObservation({ value: cell.get() })
        .value as Record<string, unknown>;
    }

    it("returns a cell-resolved `FabricBytes` with its bytes intact", () => {
      // The leaf guard has to hold for the value as the READ PATH delivers it,
      // not only for one built in place -- this is the shape a model actually
      // observes.
      const value = readBack({
        bytes: new FabricBytes(new Uint8Array([1, 2, 3])),
      });

      expect(value.bytes).toBeInstanceOf(FabricBytes);
      expect((value.bytes as FabricBytes).slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("throws for a cell-resolved `FabricError` rather than flattening one", () => {
      // A read hands back the instance itself, so the refusal above sees it
      // arriving this way too.
      //
      // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at
      // which point this walk shows a model what the error holds and this
      // becomes a case about that rendering.
      expect(() =>
        readBack({ failure: FabricError.fromNativeError(new Error("boom")) })
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "serializing a value for a language model.",
      );
    });
  });

  describe("traverseAndCellify", () => {
    it("returns a `FabricBytes` whole rather than as an empty record", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      const result = traverseAndCellify(
        noCellRuntime as never,
        "did:test:cellify",
        { payload: bytes },
      ) as { payload: unknown };

      expect(result.payload).toBeInstanceOf(FabricBytes);
      expect((result.payload as FabricBytes).slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("throws for a `FabricInstance` rather than flattening one", () => {
      const instance = FabricError.fromNativeError(new Error("boom"));

      expect(() =>
        traverseAndCellify(
          noCellRuntime as never,
          "did:test:cellify",
          { failure: instance },
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "converting a language model's response to cells.",
      );
    });
  });
});
