/**
 * The shapes of schema and value the two argument walks in `runner.ts` skip:
 * a position with no schema object, a schema reached twice at one position,
 * a plain link, an undeclared key beside declared ones, and a reference that
 * resolves to a boolean schema.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { Frame, JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cov-b argument walks");
const space = signer.did();

describe("runner argument walks", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let resultCell: Cell<unknown>;
  let redirect: unknown;
  let plainLink: unknown;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    const target = runtime.getCell<{ value: number }>(
      space,
      "walk-target",
      undefined,
      tx,
    );
    target.set({ value: 1 });
    redirect = target.key("value").getAsWriteRedirectLink();
    plainLink = target.key("value").getAsLink();
    resultCell = runtime.getCell<unknown>(space, "walk-result", undefined, tx);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A record whose `field` getter counts its reads, so a case can tell how
   * many times a walk visited the position holding it.
   */
  function countingRecord(field: unknown) {
    const reads = { count: 0 };
    const record = {
      get field() {
        reads.count++;
        return field;
      },
    };
    return { record, reads };
  }

  describe("collectWritableCellArgumentLinks", () => {
    it("returns no links for an argument with no schema", () => {
      const walks = runtime.runner.accessForTestingOnly;

      expect(
        walks.collectWritableCellArgumentLinks(undefined, redirect, resultCell),
      ).toEqual([]);
      expect(
        walks.collectWritableCellArgumentLinks(
          { type: "object", asCell: ["cell"] },
          redirect,
          resultCell,
        ).length,
      ).toBe(1);
    });

    it("returns no links from a position whose subschema is a boolean", () => {
      const walks = runtime.runner.accessForTestingOnly;

      expect(
        walks.collectWritableCellArgumentLinks(
          { type: "object", properties: { field: true } },
          { field: redirect },
          resultCell,
        ),
      ).toEqual([]);
      expect(
        walks.collectWritableCellArgumentLinks(
          {
            type: "object",
            properties: { field: { type: "number", asCell: ["cell"] } },
          },
          { field: redirect },
          resultCell,
        ).length,
      ).toBe(1);
    });

    it("visits a subschema that two branches share once at the same path", () => {
      const walks = runtime.runner.accessForTestingOnly;
      const shared: JSONSchema = {
        type: "object",
        properties: { field: { type: "number", asCell: ["cell"] } },
      };
      const once = countingRecord(redirect);

      const links = walks.collectWritableCellArgumentLinks(
        { anyOf: [shared, shared] },
        once.record,
        resultCell,
      );

      expect(links.length).toBe(1);
      expect(once.reads.count).toBe(1);

      // The same subschema at two different paths is visited at each.
      const left = countingRecord(redirect);
      const right = countingRecord(redirect);
      walks.collectWritableCellArgumentLinks(
        {
          type: "object",
          properties: { left: shared, right: shared },
        },
        { left: left.record, right: right.record },
        resultCell,
      );
      expect([left.reads.count, right.reads.count]).toEqual([1, 1]);
    });
  });

  describe("collectArgumentSchedulerReadLinks", () => {
    it("returns no links for a plain link, and one for a write redirect", () => {
      const walks = runtime.runner.accessForTestingOnly;
      const schema: JSONSchema = {
        type: "object",
        properties: { field: { type: "number" } },
      };

      expect(
        walks.collectArgumentSchedulerReadLinks(
          schema,
          { field: plainLink },
          resultCell,
        ),
      ).toEqual([]);
      expect(
        walks.collectArgumentSchedulerReadLinks(
          schema,
          { field: redirect },
          resultCell,
        ).length,
      ).toBe(1);
    });

    it("visits only the undeclared keys under `additionalProperties`", () => {
      const walks = runtime.runner.accessForTestingOnly;
      const schema: JSONSchema = {
        type: "object",
        properties: { declared: { type: "number", asCell: ["opaque"] } },
        additionalProperties: { type: "number" },
      };

      // The declared key's own schema marks it opaque, so it is not read; the
      // `additionalProperties` schema, which would read it, is not applied.
      expect(
        walks.collectArgumentSchedulerReadLinks(
          schema,
          { declared: redirect },
          resultCell,
        ),
      ).toEqual([]);
      expect(
        walks.collectArgumentSchedulerReadLinks(
          schema,
          { undeclared: redirect },
          resultCell,
        ).length,
      ).toBe(1);
    });

    it("reads a link whose schema reference resolves to a boolean schema", () => {
      const walks = runtime.runner.accessForTestingOnly;

      expect(
        walks.collectArgumentSchedulerReadLinks(
          {
            type: "object",
            properties: { field: { $ref: "#/$defs/Anything" } },
            $defs: { Anything: true },
          },
          { field: redirect },
          resultCell,
        ).length,
      ).toBe(1);
      expect(
        walks.collectArgumentSchedulerReadLinks(
          {
            type: "object",
            properties: { field: { $ref: "#/$defs/Opaque" } },
            $defs: { Opaque: { type: "number", asCell: ["opaque"] } },
          },
          { field: redirect },
          resultCell,
        ),
      ).toEqual([]);
    });
  });

  describe("resolvePendingSpaceNamesAndRetry", () => {
    it("rejects for a frame outside any space", async () => {
      const resolve =
        runtime.runner.accessForTestingOnly.resolvePendingSpaceNamesAndRetry;
      const frame = (space?: Frame["space"]): Frame => ({
        generatedIdCounter: 0,
        reactives: new Set(),
        space,
        pendingSpaceNames: new Map(),
      });

      await expect(resolve(frame())).rejects.toThrow(
        "An inSpace target was named outside any space",
      );
      // In a space, with nothing pending, the run is retried.
      await expect(resolve(frame(space), tx)).rejects.toThrow(
        "Resolving in-space target spaces",
      );
    });
  });
});
