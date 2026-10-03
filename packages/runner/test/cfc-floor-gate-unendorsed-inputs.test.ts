import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-floor-gate-unendorsed-inputs",
);

const GPS = "https://example.com/atoms/Gps";
const gps = { type: GPS, by: "device-1" };

const num = { type: "number" } as const;
const str = { type: "string" } as const;
const withIntegrity = (schema: Record<string, unknown>) => ({
  ...schema,
  ifc: { integrity: [gps] },
});

type Source = {
  schema: JSONSchema;
  value: Record<string, unknown>;
  paths: Record<"lat" | "long" | "name", string[]>;
};

const NESTED: Source = {
  schema: {
    type: "object",
    properties: {
      location: withIntegrity({
        type: "object",
        properties: { lat: num, long: num },
        required: ["lat", "long"],
      }),
      name: str,
    },
    required: ["location", "name"],
  } as JSONSchema,
  value: { location: { lat: 1, long: 2 }, name: "home" },
  paths: {
    lat: ["location", "lat"],
    long: ["location", "long"],
    name: ["name"],
  },
};

const FIELD_LEVEL: Source = {
  schema: {
    type: "object",
    properties: {
      lat: withIntegrity(num),
      long: withIntegrity(num),
      name: str,
    },
    required: ["lat", "long", "name"],
  } as JSONSchema,
  value: { lat: 1, long: 2, name: "home" },
  paths: { lat: ["lat"], long: ["long"], name: ["name"] },
};

const WHOLE: Source = {
  schema: withIntegrity({
    type: "object",
    properties: { lat: num, long: num, name: str },
    required: ["lat", "long", "name"],
  }) as JSONSchema,
  value: { lat: 1, long: 2, name: "home" },
  paths: { lat: ["lat"], long: ["long"], name: ["name"] },
};

const LOCATION = withIntegrity({
  type: "object",
  properties: { lat: num, long: num },
  required: ["lat", "long"],
});

/** A value whose one member is endorsed: the whole of its data is too. */
const COVERED: Source = {
  schema: {
    type: "object",
    properties: { location: LOCATION },
    required: ["location"],
  } as JSONSchema,
  value: { location: { lat: 1, long: 2 } },
  paths: {
    lat: ["location", "lat"],
    long: ["location", "long"],
    name: ["location"],
  },
};

/** `COVERED` with an unendorsed member that holds no data but its own. */
const COVERED_BESIDE_EMPTY_LIST: Source = {
  schema: {
    type: "object",
    properties: {
      location: LOCATION,
      tags: { type: "array", items: str },
    },
    required: ["location", "tags"],
  } as JSONSchema,
  value: { location: { lat: 1, long: 2 }, tags: [] },
  paths: COVERED.paths,
};

type Readable = {
  key: (name: string) => Readable;
  get: () => unknown;
  getRaw: () => unknown;
};

const at = (cell: Readable, path: readonly string[]) =>
  path.reduce((current, segment) => current.key(segment), cell);

type Read = (cell: Readable, source: Source) => void;

const locationLeaves: Read = (cell, source) => {
  at(cell, source.paths.lat).get();
  at(cell, source.paths.long).get();
};
const nameOnly: Read = (cell, source) => void at(cell, source.paths.name).get();
const everyLeaf: Read = (cell, source) => {
  locationLeaves(cell, source);
  nameOnly(cell, source);
};
const wholeRecursive: Read = (cell) => void cell.getRaw();
const throughSchema: Read = (cell) => void cell.get();

const FLOORED_SINK = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [{ type: GPS }] } },
  },
  required: ["out"],
} as JSONSchema;

/**
 * Seeds `source`, reads it with `read`, and writes a sink field whose floor
 * requires the source's integrity. The write floor only observes, so the
 * outcome is the read-side gate's: the error message, or `undefined` for a
 * commit.
 */
const writeThroughFloor = async (
  source: Source,
  read: Read,
): Promise<string | undefined> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcWriteFloor: "observe",
  });
  try {
    const seed = runtime.edit();
    runtime.getCell(signer.did(), "floor-source", source.schema, seed)
      .set(source.value);
    seed.prepareCfc();
    const seeded = await seed.commit();
    expect(seeded.error).toBeUndefined();

    const tx = runtime.edit();
    read(
      runtime.getCell(
        signer.did(),
        "floor-source",
        source.schema,
        tx,
      ) as unknown as Readable,
      source,
    );
    runtime.getCell(signer.did(), "floor-sink", FLOORED_SINK, tx).set({
      out: "derived",
    });
    try {
      tx.prepareCfc();
    } catch {
      // The commit result carries the reason.
    }
    const result = await tx.commit();
    return result.error?.message;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("CFC requiredIntegrity floor over unendorsed inputs", () => {
  for (
    const [shape, source] of [["nested", NESTED], [
      "field-level",
      FIELD_LEVEL,
    ]] as const
  ) {
    describe(`a ${shape} label on part of a value`, () => {
      it("commits a write that reads only the endorsed part", async () => {
        expect(await writeThroughFloor(source, locationLeaves)).toBeUndefined();
      });

      it("rejects a write that also reads the unendorsed part", async () => {
        expect(await writeThroughFloor(source, everyLeaf)).toContain(
          "requiredIntegrity failed",
        );
      });

      it("rejects a write that reads only the unendorsed part", async () => {
        expect(await writeThroughFloor(source, nameOnly)).toContain(
          "requiredIntegrity failed",
        );
      });

      it("rejects a write that reads the whole value recursively", async () => {
        expect(await writeThroughFloor(source, wholeRecursive)).toContain(
          "requiredIntegrity failed",
        );
      });
    });
  }

  describe("a label on every member of a value", () => {
    it("commits a write that reads the whole value recursively", async () => {
      expect(await writeThroughFloor(COVERED, wholeRecursive))
        .toBeUndefined();
    });

    it("commits a write that reads the value through its schema", async () => {
      expect(await writeThroughFloor(COVERED, throughSchema)).toBeUndefined();
    });

    it("rejects a recursive read of the value beside an unendorsed empty list", async () => {
      expect(
        await writeThroughFloor(COVERED_BESIDE_EMPTY_LIST, wholeRecursive),
      ).toContain("requiredIntegrity failed");
    });
  });

  describe("a label on the whole value", () => {
    it("commits a write that reads any part of it", async () => {
      for (
        const read of [locationLeaves, everyLeaf, nameOnly, wholeRecursive]
      ) {
        expect(await writeThroughFloor(WHOLE, read)).toBeUndefined();
      }
    });
  });
});
