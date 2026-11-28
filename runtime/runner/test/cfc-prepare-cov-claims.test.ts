import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase("runner-cfc-prepare-cov-claims");
const space = signer.did();

type StoredEntry = {
  path: readonly string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
};

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const start = (): Runtime => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    return runtime;
  };

  // Writes `value` through a cell at `id` typed by `schema`, or at `key` of
  // it when one is given, and commits.
  const commitWrite = async (
    runtime: Runtime,
    id: string,
    schema: JSONSchema,
    value: unknown,
    key?: string,
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, id, schema, tx);
    if (key === undefined) cell.set(value as never);
    else cell.key(key as never).set(value as never);
    return await tx.commit().settled;
  };

  // The document a cell at `id` stores: its value and its label map.
  const stored = (runtime: Runtime, id: string) => {
    const tx = runtime.edit();
    const docId = parseLink(runtime.getCell(space, id).getAsLink()).id as URI;
    const read = (path: readonly string[]) =>
      tx.readOrThrow({ space, id: docId, scope: "space", path: [...path] });
    const value = read(["value"]);
    const entries = (read(["cfc", "labelMap", "entries"]) ??
      []) as readonly StoredEntry[];
    tx.abort();
    return { value, entries };
  };

  describe("`exactCopyOf`", () => {
    const SCHEMA = {
      type: "object",
      properties: {
        email: { type: "string", ifc: { confidentiality: ["secret"] } },
        confirmed: { type: "string", ifc: { exactCopyOf: ["email"] } },
      },
      required: ["email", "confirmed"],
    } as const satisfies JSONSchema;

    it("verifies no claim at a path the transaction leaves unwritten", async () => {
      // The claim compares the copy with its source only where a write
      // reaches the copy, so a write of the source alone commits.

      const runtime = start();
      expect(
        (await commitWrite(runtime, "copy", SCHEMA, {
          email: "a@example.com",
          confirmed: "a@example.com",
        })).error,
      ).toBeUndefined();

      expect(
        (await commitWrite(runtime, "copy", SCHEMA, "b@example.com", "email"))
          .error,
      ).toBeUndefined();
      expect(stored(runtime, "copy").value).toEqual({
        email: "b@example.com",
        confirmed: "a@example.com",
      });

      const refused = await commitWrite(
        runtime,
        "copy",
        SCHEMA,
        "c@example.com",
        "confirmed",
      );
      expect(isCfcEnforcementRejection(refused.error)).toBe(true);
      expect(String(refused.error?.message)).toContain(
        "exactCopyOf failed at /confirmed",
      );
    });
  });

  describe("`projection`", () => {
    const schemaProjecting = (integrity: readonly unknown[]) => ({
      type: "object",
      properties: {
        measurement: {
          type: "object",
          properties: { lat: { type: "number" } },
          ifc: { confidentiality: ["secret"], integrity: [...integrity] },
        },
        latitude: {
          type: "number",
          ifc: { projection: { from: "/measurement", path: "/lat" } },
        },
      },
      required: ["measurement", "latitude"],
    } as JSONSchema);

    const projectedLabel = async (
      id: string,
      integrity: readonly unknown[],
    ) => {
      const runtime = start();
      expect(
        (await commitWrite(runtime, id, schemaProjecting(integrity), {
          measurement: { lat: 37.77 },
          latitude: 37.77,
        })).error,
      ).toBeUndefined();
      return stored(runtime, id).entries.find((entry) =>
        entry.path.length === 1 && entry.path[0] === "latitude"
      )?.label;
    };

    it("carries the source's confidentiality and no integrity where no atom can be scoped", async () => {
      // A string atom cannot hold a projection scope, so a source whose
      // integrity is only that carries none onto the projected field.

      expect(await projectedLabel("projection-unscoped", ["gps-verified"]))
        .toEqual({ confidentiality: ["secret"] });
    });

    it("carries the source's integrity scoped to the projected path where an atom can hold the scope", async () => {
      expect(
        await projectedLabel("projection-scoped", [{ type: "GPSMeasurement" }]),
      ).toEqual({
        confidentiality: ["secret"],
        integrity: [{ type: "GPSMeasurement", scope: { projection: "/lat" } }],
      });
    });
  });
});
