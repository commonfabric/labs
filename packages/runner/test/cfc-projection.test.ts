import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-projection");

describe("CFC projection claims", () => {
  // §8.3 projection claims (spec cfc/08-03-projection-semantics.md): a field
  // copied out of a structured source inherits the source's confidentiality in
  // full (§8.3.1) and carries the source's integrity SCOPED to the projected
  // path (§8.3.2) — the projected value can never claim whole-object integrity,
  // and atoms that cannot express the scoping (string atoms, provenance-class
  // evidence) are dropped, fail-closed.

  const createRuntime = () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return { runtime, storageManager };
  };

  const readPersistedEntries = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    persistedId: string,
  ) => {
    const replica = storageManager.open(signer.did()).replica as unknown as {
      getDocument(id: string): {
        value?: unknown;
        cfc?: {
          labelMap?: {
            entries: Array<{
              path: string[];
              label: {
                confidentiality?: unknown[];
                integrity?: unknown[];
              };
            }>;
          };
        };
      } | undefined;
    };
    return replica.getDocument(persistedId)?.cfc?.labelMap?.entries;
  };

  const gpsSchema = {
    type: "object",
    properties: {
      measurement: {
        type: "object",
        properties: {
          lat: { type: "number" },
          long: { type: "number" },
        },
        ifc: {
          confidentiality: ["secret"],
          integrity: [
            { type: "GPSMeasurement", device: "test-device" },
            // String atoms cannot carry a `scope` binding, so a projection
            // must drop them rather than let the field claim whole-object
            // integrity.
            "gps-verified",
          ],
        },
      },
      latitude: {
        type: "number",
        ifc: { projection: { from: "/measurement", path: "/lat" } },
      },
    },
    required: ["measurement", "latitude"],
  } as const satisfies JSONSchema;

  it("carries confidentiality and scoped integrity when satisfied", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-satisfied",
        gpsSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77, long: -122.41 },
        latitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = readPersistedEntries(storageManager, persistedId);
      const entry = entries?.find((e) =>
        e.path.length === 1 && e.path[0] === "latitude"
      );
      expect(entry).toBeDefined();
      // §8.3.1: confidentiality inherited unchanged.
      expect(entry?.label.confidentiality).toEqual(["secret"]);
      // §8.3.2: integrity carried scoped to the projected path; the string
      // atom is dropped (no scoping representation).
      expect(entry?.label.integrity).toEqual([
        {
          type: "GPSMeasurement",
          device: "test-device",
          scope: { projection: "/lat" },
        },
      ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("carries a root-source projection: exact source-path entry unscoped, unscopeable scopes dropped", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-root-source",
        {
          type: "object",
          properties: {
            measurement: {
              type: "object",
              properties: {
                lat: {
                  type: "number",
                  // An entry AT the projected source location: the target is
                  // an exact copy of this value, so its atoms carry unscoped
                  // (§8.3.4's interop note: no `projection: "/"`), including
                  // string atoms.
                  ifc: {
                    confidentiality: ["lat-secret"],
                    integrity: ["lat-verified", { type: "LatReading" }],
                  },
                },
                long: { type: "number" },
              },
              ifc: {
                confidentiality: ["secret"],
                integrity: [
                  // An existing record scope is preserved and extended.
                  {
                    type: "GPSMeasurement",
                    scope: { valueRef: "measurement-1" },
                  },
                  // A non-record scope cannot be extended — dropped.
                  { type: "OddlyScoped", scope: "not-a-record" },
                ],
              },
            },
            latitude: {
              type: "number",
              // `from: "/"` — the ProjectionOf lowering: source is the doc
              // root, the pointer walks to the projected field.
              ifc: { projection: { from: "/", path: "/measurement/lat" } },
            },
          },
          required: ["measurement", "latitude"],
        } as const satisfies JSONSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77, long: -122.41 },
        latitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = readPersistedEntries(storageManager, persistedId);
      const entry = entries?.find((e) =>
        e.path.length === 1 && e.path[0] === "latitude"
      );
      expect(entry).toBeDefined();
      // Confidentiality inherited from every source-prefix entry.
      expect(entry?.label.confidentiality).toEqual(["secret", "lat-secret"]);
      expect(entry?.label.integrity).toEqual([
        {
          type: "GPSMeasurement",
          scope: { valueRef: "measurement-1", projection: "/lat" },
        },
        // OddlyScoped dropped (non-record scope); the source-path entry's
        // atoms carry unscoped.
        "lat-verified",
        { type: "LatReading" },
      ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("carries the items-level (*) label for a concrete array-element projection", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-array-element",
        {
          type: "object",
          properties: {
            // Primitive elements stay INLINE in the document (object elements
            // are normalized into child docs and fail the same-doc value
            // comparison — pinned below), so this is the shape where the
            // items-level label carry is reachable.
            latitudes: {
              type: "array",
              items: {
                type: "number",
                // Stored under the wildcard entry path latitudes/* — an
                // items-level label applies uniformly to every element, so a
                // concrete-element projection must still find and carry it
                // (review P1: the exact-path lookup silently lost it).
                ifc: {
                  confidentiality: ["secret"],
                  integrity: [{ type: "GPSMeasurement" }],
                },
              },
            },
            firstLatitude: {
              type: "number",
              ifc: { projection: { from: "/latitudes", path: "/0" } },
            },
          },
          required: ["latitudes", "firstLatitude"],
        } as const satisfies JSONSchema,
        tx,
      );

      cell.set({
        latitudes: [37.77, -12.3],
        firstLatitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = readPersistedEntries(storageManager, persistedId);
      const entry = entries?.find((e) =>
        e.path.length === 1 && e.path[0] === "firstLatitude"
      );
      expect(entry?.label.confidentiality).toEqual(["secret"]);
      // The items entry IS the element (relative pointer is the root), so its
      // atoms carry unscoped — the target is an exact copy of the element.
      expect(entry?.label.integrity).toEqual([
        { type: "GPSMeasurement" },
      ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("verifies a projection through a normalized object array element", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-object-element",
        {
          type: "object",
          properties: {
            measurements: {
              type: "array",
              items: {
                type: "object",
                properties: { lat: { type: "number" } },
                ifc: { confidentiality: ["secret"] },
              },
            },
            firstLatitude: {
              type: "number",
              ifc: { projection: { from: "/measurements", path: "/0/lat" } },
            },
          },
          required: ["measurements", "firstLatitude"],
        } as const satisfies JSONSchema,
        tx,
      );

      // The element is stored in a child document, so the claim resolves
      // the linked field in the transaction's authorization snapshot.
      cell.set({
        measurements: [{ lat: 37.77 }],
        firstLatitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
      const entries = readPersistedEntries(
        storageManager,
        parseLink(cell.getAsLink()).id!,
      );
      const entry = entries?.find((entry) =>
        entry.path.length === 1 && entry.path[0] === "firstLatitude"
      );
      expect(entry?.label.confidentiality).toEqual(["secret"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("ignores a projection claim whose target path was not written", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-untouched",
        gpsSchema,
        tx,
      );

      // Only the source struct is written (root-schema update touching just
      // /measurement); the claimed target path stays untouched, so the claim
      // must not be verified (or its label carried) for this transaction.
      cell.update({ measurement: { lat: 37.77, long: -122.41 } });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = readPersistedEntries(storageManager, persistedId);
      // The source struct's own declared entry stands in the same label map,
      // so an absent `latitude` entry is a fact about a map that was written.
      expect(
        entries?.find((e) =>
          e.path.length === 1 && e.path[0] === "measurement"
        ),
      ).toBeDefined();
      expect(
        entries?.find((e) => e.path.length === 1 && e.path[0] === "latitude"),
      ).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a non-record projection claim as malformed", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-non-record",
        {
          type: "object",
          properties: {
            latitude: {
              type: "number",
              ifc: { projection: true },
            },
          },
          required: ["latitude"],
        } as unknown as JSONSchema,
        tx,
      );

      cell.set({ latitude: 37.77 });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "malformed projection claim at /latitude",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a projection claim when the projected value diverges", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-reject",
        gpsSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77, long: -122.41 },
        latitude: 1.23,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "projection claim failed at /latitude",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a projection claim on an array-item (wildcard) path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-wildcard",
        {
          type: "object",
          properties: {
            measurements: {
              type: "array",
              items: {
                type: "object",
                properties: { lat: { type: "number" } },
                ifc: { confidentiality: ["secret"] },
              },
            },
            latitudes: {
              type: "array",
              items: {
                type: "number",
                ifc: {
                  projection: { from: "/measurements", path: "/0/lat" },
                },
              },
            },
          },
          required: ["measurements", "latitudes"],
        } as const satisfies JSONSchema,
        tx,
      );

      cell.set({
        measurements: [{ lat: 37.77 }],
        latitudes: [37.77],
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "projection claim under an array wildcard is unsupported",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a malformed projection claim", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-malformed",
        {
          type: "object",
          properties: {
            measurement: {
              type: "object",
              properties: { lat: { type: "number" } },
              ifc: { confidentiality: ["secret"] },
            },
            latitude: {
              type: "number",
              // Missing `path` — the authored type surface rejects this at
              // compile time, but a schema arriving from storage or the wire
              // is not typed, so the claim must fail closed at commit, not
              // silently skip verification.
              ifc: { projection: { from: "/measurement" } },
            },
          },
          required: ["measurement", "latitude"],
        } as unknown as JSONSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77 },
        latitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "malformed projection claim at /latitude",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
