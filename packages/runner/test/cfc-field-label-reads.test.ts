import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// SPIKE PROBE (opus/cfc-carrier-records-payload-spike): what the read side
// does with a label placed on a value's fields rather than on the value. Each
// run seeds one labeled source, reads it one way, and writes a sink whose
// field requires the source's integrity (or, for the confidentiality rows,
// declares none). The write floor only observes, so the outcome is the
// read-side gate's. Results are printed, not asserted.

const signer = await Identity.fromPassphrase("runner-cfc-field-label-reads");

const GPS = "https://example.com/atoms/Gps";
const gps = { type: GPS, by: "device-1" };

const num = { type: "number" } as const;
const str = { type: "string" } as const;
const withIntegrity = (schema: Record<string, unknown>) => ({
  ...schema,
  ifc: { integrity: [gps] },
});

type Shape = {
  schema: JSONSchema;
  value: Record<string, unknown>;
  paths: Record<"lat" | "long" | "name", string[]>;
};

const flatPaths = { lat: ["lat"], long: ["long"], name: ["name"] };

const SHAPES: Record<string, Shape> = {
  objectLevel: {
    schema: withIntegrity({
      type: "object",
      properties: { lat: num, long: num, name: str },
      required: ["lat", "long", "name"],
    }) as JSONSchema,
    value: { lat: 1, long: 2, name: "home" },
    paths: flatPaths,
  },
  fieldLevel: {
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
    paths: flatPaths,
  },
  nested: {
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
  },
};

type Readable = {
  key: (name: string) => Readable;
  get: () => unknown;
  getRaw: () => unknown;
};

const at = (cell: Readable, path: readonly string[]) =>
  path.reduce((current, segment) => current.key(segment), cell);

const READS: Record<string, (cell: Readable, shape: Shape) => void> = {
  wholeRecursive: (cell) => void cell.getRaw(),
  wholeTraversed: (cell) => void cell.get(),
  locationLeaves: (cell, shape) => {
    at(cell, shape.paths.lat).get();
    at(cell, shape.paths.long).get();
  },
  nameOnly: (cell, shape) => void at(cell, shape.paths.name).get(),
  everyLeaf: (cell, shape) => {
    at(cell, shape.paths.lat).get();
    at(cell, shape.paths.long).get();
    at(cell, shape.paths.name).get();
  },
};

const FLOORED_SINK = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [{ type: GPS }] } },
  },
  required: ["out"],
} as JSONSchema;

const MINTING_SINK = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { requiredIntegrity: [{ type: GPS }], addIntegrity: [gps] },
    },
  },
  required: ["out"],
} as JSONSchema;

const SECRET_SINK = {
  type: "object",
  properties: { out: { type: "string" } },
  required: ["out"],
  ifc: { confidentiality: ["secret"] },
} as JSONSchema;

const PLAIN_SINK = {
  type: "object",
  properties: { out: { type: "string" } },
  required: ["out"],
} as JSONSchema;

const run = async (
  source: Shape,
  read: (cell: Readable, shape: Shape) => void,
  sink: JSONSchema,
  writeFloor: "observe" | "enforce" = "observe",
): Promise<string> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcWriteFloor: writeFloor,
    cfcPrefixProvenanceStats: true,
  });
  try {
    const seed = runtime.edit();
    runtime.getCell(signer.did(), "probe-source", source.schema, seed)
      .set(source.value);
    seed.prepareCfc();
    const seeded = await seed.commit();
    if (seeded.error) return `SEED FAILED: ${seeded.error.message}`;

    const tx = runtime.edit();
    read(
      runtime.getCell(
        signer.did(),
        "probe-source",
        source.schema,
        tx,
      ) as unknown as Readable,
      source,
    );
    runtime.getCell(signer.did(), "probe-sink", sink, tx).set({
      out: "derived",
    });
    let prepared: string;
    try {
      prepared = JSON.stringify(tx.prepareCfc()).slice(0, 60);
    } catch (error) {
      prepared = `threw ${(error as Error).message.slice(0, 90)}`;
    }
    const result = await tx.commit();
    const stats = runtime.getCfcStats();
    const outcome = result.error
      ? `REJECTED (${result.error.message.slice(0, 70)})`
      : "committed";
    return `${outcome}; gated reads ${stats.prefixGatedReads}; prepare ${prepared}`;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("probe: labels on a value's fields, as reads see them", () => {
  it("prints the integrity floor outcome per source shape and read", async () => {
    const lines: string[] = [];
    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      for (const [readName, read] of Object.entries(READS)) {
        lines.push(
          `${shapeName.padEnd(12)} ${readName.padEnd(15)} ${await run(
            shape,
            read,
            FLOORED_SINK,
          )}`,
        );
      }
    }
    console.log("== integrity floor [gps] on sink.out\n" + lines.join("\n"));
  });

  it("prints the integrity floor outcome with the write floor enforcing", async () => {
    const lines: string[] = [];
    for (const shapeName of ["objectLevel", "fieldLevel", "nested"]) {
      for (const readName of ["locationLeaves", "nameOnly", "everyLeaf"]) {
        lines.push(
          `${shapeName.padEnd(12)} ${readName.padEnd(15)} ${await run(
            SHAPES[shapeName]!,
            READS[readName]!,
            FLOORED_SINK,
            "enforce",
          )}`,
        );
      }
    }
    console.log("== write floor enforcing\n" + lines.join("\n"));
  });

  it("prints the outcome for a sink that mints the endorsement it requires", async () => {
    const lines: string[] = [];
    for (const shapeName of ["objectLevel", "fieldLevel", "nested"]) {
      for (const readName of ["locationLeaves", "nameOnly", "everyLeaf"]) {
        lines.push(
          `${shapeName.padEnd(12)} ${readName.padEnd(15)} ${await run(
            SHAPES[shapeName]!,
            READS[readName]!,
            MINTING_SINK,
            "enforce",
          )}`,
        );
      }
    }
    console.log("== minting sink, write floor enforcing\n" + lines.join("\n"));
  });

  it("prints the confidentiality outcome for a field-level secret", async () => {
    const secretField: Shape = {
      schema: {
        type: "object",
        properties: {
          pin: { type: "string", ifc: { confidentiality: ["secret"] } },
          name: str,
        },
        required: ["pin", "name"],
      } as JSONSchema,
      value: { pin: "1234", name: "home" },
      paths: { lat: ["pin"], long: ["pin"], name: ["name"] },
    };
    const lines: string[] = [];
    for (
      const readName of ["wholeRecursive", "wholeTraversed", "nameOnly"]
    ) {
      lines.push(
        `fieldSecret  ${readName.padEnd(15)} ${await run(
          secretField,
          READS[readName]!,
          PLAIN_SINK,
        )}`,
      );
    }
    for (const readName of ["wholeRecursive", "wholeTraversed"]) {
      lines.push(
        `fieldSecret  ${readName.padEnd(15)} [sink declares secret] ${await run(
          secretField,
          READS[readName]!,
          SECRET_SINK,
        )}`,
      );
    }
    console.log(
      "== confidentiality: sink declares none\n" + lines.join("\n"),
    );
  });
});
