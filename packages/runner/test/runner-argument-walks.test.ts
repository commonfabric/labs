/**
 * What the two schema-guided argument walks in `runner.ts` do with a
 * `FabricSpecialObject`. Both collect links out of a live action argument, and
 * both are security-relevant: what they find becomes scheduler read tracking
 * and write-policy input.
 *
 * Neither walk rebuilds anything -- each INDEXES the value at the position its
 * schema names (`currentValue[key]`). So a `FabricPrimitive` standing where the
 * schema expects a container yields `undefined` per key and contributes
 * nothing, which is the right answer: a leaf holds no link to find.
 *
 * A `FabricInstance` is a different case. A link in its codec contents is
 * unreachable by property name, so passing one through would _miss_ that link
 * -- and over-collection is these walkers' safe direction, which makes a miss
 * the unsafe one -- so both walks refuse an instance that may hold one. One
 * that is deep-frozen and holds nothing but fabric data holds no link, and
 * contributes nothing, as a `FabricPrimitive` does.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { deepFreeze, type FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test runner argument walks");
const space = signer.did();

// The two walks are reached through `accessForTestingOnly`: driving them
// through a running action would drag in module setup that has nothing to do
// with what is pinned here.

describe("runner-argument-walks", () => {
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

  /**
   * A schema whose `payload` branch declares nested structure, so a walk
   * reaching a `FabricBytes` there tries to index INTO it -- the shape that
   * would expose a walk mistaking a special object for a container.
   */
  const argumentSchema: JSONSchema = {
    type: "object",
    properties: {
      payload: {
        type: "object",
        properties: { inner: { type: "object", asCell: ["cell"] } },
      },
      ref: { type: "object", asCell: ["cell"] },
    },
  };

  function fixture() {
    const target = runtime.getCell<unknown>(
      space,
      "walk-target",
      undefined,
      tx,
    );
    target.set({ value: 1 });
    const resultCell = runtime.getCell<unknown>(
      space,
      "walk-result",
      undefined,
      tx,
    );
    return {
      resultCell,
      value: {
        payload: new FabricBytes(new Uint8Array([1, 2, 3])),
        ref: target.key("value").getAsWriteRedirectLink(),
      },
    };
  }

  /** The same link, wrapped where a schema expects a container. */
  function wrapped(link: unknown) {
    return deepFreeze(
      new FabricError({
        type: "Error",
        message: "boom",
        stack: undefined,
        cause: undefined,
        extras: { inner: link as FabricValue },
      }),
    );
  }

  /** A deep-frozen `FabricError` holding nothing but fabric data. */
  const dataOnlyError = () =>
    deepFreeze(FabricError.fromNativeError(new Error("boom")));

  describe("collectArgumentSchedulerReadLinks", () => {
    it("throws for a `FabricError` rather than missing a link inside it", () => {
      // The control is the point: the same link _is_ collected at the same
      // schema position when it sits in a plain record, so what changes the
      // outcome is the wrapper.
      const { resultCell, value } = fixture();
      const walks = runtime.runner.accessForTestingOnly;
      const nested = { payload: { inner: value.ref } };

      expect(
        walks.collectArgumentSchedulerReadLinks(
          argumentSchema,
          nested,
          resultCell,
        ).length,
      ).toBe(1);

      expect(() =>
        walks.collectArgumentSchedulerReadLinks(
          argumentSchema,
          { payload: wrapped(value.ref) },
          resultCell,
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "collecting scheduler read links from an argument.",
      );
    });

    it("collects a sibling write-redirect link past a deep-frozen `FabricError` holding only data", () => {
      const { resultCell, value } = fixture();

      const links = runtime.runner.accessForTestingOnly
        .collectArgumentSchedulerReadLinks(
          argumentSchema,
          { ...value, payload: dataOnlyError() },
          resultCell,
        );

      expect(links.length).toBe(1);
    });

    it("collects a sibling write-redirect link past a `FabricBytes`", () => {
      // The discriminating shape: the schema tells the walk to descend into
      // `payload`, where a `FabricBytes` stands. The walk must index it, find
      // nothing, and carry on to `ref` -- rather than throwing, or stopping.
      const { resultCell, value } = fixture();

      const links = runtime.runner.accessForTestingOnly
        .collectArgumentSchedulerReadLinks(argumentSchema, value, resultCell);

      expect(links.length).toBe(1);
    });
  });

  describe("collectWritableCellArgumentLinks", () => {
    it("throws for a `FabricError` standing at an `asCell` node", () => {
      // The `asCell` branch collects and returns, so a guard placed after it
      // would never see a value standing there -- a link nested in an instance
      // would be missed while the walk reported success. This pins that the
      // guard runs first.
      const { resultCell, value } = fixture();
      const walks = runtime.runner.accessForTestingOnly;
      const asCellSchema: JSONSchema = {
        type: "object",
        properties: { payload: { type: "object", asCell: ["cell"] } },
      };

      expect(
        walks.collectWritableCellArgumentLinks(
          asCellSchema,
          { payload: value.ref },
          resultCell,
        ).length,
      ).toBe(1);

      expect(() =>
        walks.collectWritableCellArgumentLinks(
          asCellSchema,
          { payload: wrapped(value.ref) },
          resultCell,
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "collecting writable cell links from an argument.",
      );
    });

    it("throws for a `FabricError` rather than missing a link inside it", () => {
      const { resultCell, value } = fixture();
      const walks = runtime.runner.accessForTestingOnly;

      expect(
        walks.collectWritableCellArgumentLinks(
          argumentSchema,
          { payload: { inner: value.ref } },
          resultCell,
        ).length,
      ).toBe(1);

      expect(() =>
        walks.collectWritableCellArgumentLinks(
          argumentSchema,
          { payload: wrapped(value.ref) },
          resultCell,
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "collecting writable cell links from an argument.",
      );
    });

    it("collects a sibling write-redirect link past a `FabricBytes`", () => {
      const { resultCell, value } = fixture();

      const links = runtime.runner.accessForTestingOnly
        .collectWritableCellArgumentLinks(argumentSchema, value, resultCell);

      expect(links.length).toBe(1);
    });

    it("collects a sibling write-redirect link past a deep-frozen `FabricError` holding only data", () => {
      const { resultCell, value } = fixture();

      const links = runtime.runner.accessForTestingOnly
        .collectWritableCellArgumentLinks(
          argumentSchema,
          { ...value, payload: dataOnlyError() },
          resultCell,
        );

      expect(links.length).toBe(1);
    });
  });
});
