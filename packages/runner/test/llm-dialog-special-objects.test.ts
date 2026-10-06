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

import { FabricInstance } from "@commonfabric/data-model";
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
    // does not hand back what was written: `getAsQueryResult()` returns a
    // `FabricPrimitive` raw but wraps everything else in a proxy. So the two
    // arms arrive differently, and only driving them from a real cell shows it.

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
      await tx.commit().settled;
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

    it("flattens a cell-resolved `FabricError`, which the refusal misses", () => {
      // A _known blind spot_, pinned so it cannot widen unnoticed, and so that
      // closing it turns this red rather than passing silently.
      //
      // `getAsQueryResult()` hands back a `FabricPrimitive` raw but wraps a
      // `FabricInstance` in a proxy, and that proxy's prototype is
      // `Object.prototype` -- there is no `getPrototypeOf` trap. So
      // `instanceof FabricInstance` is false, the refusal above cannot fire,
      // and the record branch rebuilds the value as a bare `{}`.
      //
      // The refusal is not wrong, it is blind: it covers a value handed over
      // directly and cannot see one arriving this way. Every
      // `instanceof FabricInstance` tripwire in the runner shares that blind
      // spot.
      //
      // TODO(danfuzz): this test asserts the WRONG behavior on purpose, and
      // should be inverted -- to a refusal, matching the sibling test above --
      // once a proxied `FabricInstance` is perceived as one. The work is at the
      // matching `TODO` in `query-result-proxy.ts`, where a `FabricPrimitive`
      // already gets the exemption an instance does not.
      const value = readBack({
        failure: FabricError.fromNativeError(new Error("boom")),
      });

      // `FabricInstance` is abstract, so `toBeInstanceOf` will not take it;
      // the prototype check below is the same assertion, stated directly.
      expect(value.failure instanceof FabricInstance).toBe(false);
      expect(Object.getPrototypeOf(value.failure)).toBe(Object.prototype);
      expect(Object.keys(value.failure as object)).toEqual([]);
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
