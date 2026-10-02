// The labels a lazy view consumes where it decides something by which keys
// the data carries.
//
// A view reads its container shallowly and each child only when the reader
// touches it. Two decisions come off the container alone — whether a
// `required` key is there, and which keys an enumeration lists — and each one
// observes the existence of a child the reader may never touch. CFC spec
// §4.6.3 has a key-presence check consume `shape` at the child, and an
// enumeration the `shape` of each child it returns. Neither consumes the
// child's value or anything below it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { type CfcConfClause } from "../src/cfc/clause.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("schema-view-presence-labels");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[] };
  origin?: string;
  observes?: string;
};

/** The existence label a write that created `path` under `atom` leaves. */
const existence = (path: string[], atom: string): StoredEntry => ({
  path,
  label: { confidentiality: [atom] },
  origin: "derived",
  observes: "shape",
});

/** The content label a write of `path` under `atom` leaves. */
const content = (path: string[], atom: string): StoredEntry => ({
  path,
  label: { confidentiality: [atom] },
  origin: "derived",
  observes: "value",
});

const REQUIRES_SECRET: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    secret: { type: "string" },
    note: { type: "string" },
  },
  required: ["name", "secret"],
} as const;

describe("schema-view presence labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // At this rung a tainted write to a store that declares no ceiling
      // lands, and the assertions read back the label it persisted.
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Store `value` at `cause` with `entries` as its label map. */
  const seed = async (
    cause: string,
    value: FabricValue,
    entries: StoredEntry[],
  ): Promise<void> => {
    const tx = runtime.edit();
    const id = runtime.getCell(space, cause, undefined, tx)
      .getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
  };

  /** The confidentiality of every derived entry stored on document `id`. */
  const derivedConfidentiality = (id: string) => {
    const tx = runtime.edit();
    try {
      return (readStoredCfcMetadata(tx, { space, id })?.labelMap.entries ?? [])
        .filter((entry) => entry.origin === "derived")
        .flatMap((entry) => entry.label.confidentiality ?? []);
    } finally {
      tx.abort();
    }
  };

  /**
   * Reads `source` through `schema` the way a lift reads its argument, hands
   * what it read to `body`, writes what that returns to a fresh document, and
   * returns the confidentiality the write was stamped with.
   */
  const readAndCopy = async <T extends object>(
    source: string,
    schema: JSONSchema,
    body: (argument: T | undefined) => unknown,
    { lazy = true }: { lazy?: boolean } = {},
  ): Promise<CfcConfClause[]> => {
    const tx = runtime.edit();
    if (lazy) tx.markLazyMaterialize(true);
    const result = body(
      runtime.getCell<T | undefined>(space, source, schema, tx).get(),
    );
    tx.markLazyMaterialize(false);
    const out = runtime.getCell(space, `${source}-out`, undefined, tx);
    out.set({ result });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return derivedConfidentiality(out.getAsNormalizedFullLink().id);
  };

  const nameOf = (argument: { name: string } | undefined) =>
    argument?.name ?? null;

  describe("a required key", () => {
    it("carries the existence label of a present required key the reader never reads", async () => {
      await seed("present", { name: "n", secret: "s" }, [
        existence(["secret"], "seal"),
      ]);
      expect(await readAndCopy("present", REQUIRES_SECRET, nameOf))
        .toContain("seal");
    });

    it("carries the existence label where the required key is absent", async () => {
      await seed("absent", { name: "n" }, [existence(["secret"], "seal")]);
      expect(await readAndCopy("absent", REQUIRES_SECRET, nameOf))
        .toContain("seal");
    });

    it("carries the same existence label an eager read carries", async () => {
      await seed("eager", { name: "n", secret: "s" }, [
        existence(["secret"], "seal"),
      ]);
      expect(
        await readAndCopy("eager", REQUIRES_SECRET, nameOf, { lazy: false }),
      ).toContain("seal");
    });

    it("carries nothing from the value label of a required key the reader never reads", async () => {
      await seed("value-label", { name: "n", secret: "s" }, [
        existence(["secret"], "seal"),
        content(["secret"], "content"),
      ]);
      const confidentiality = await readAndCopy(
        "value-label",
        REQUIRES_SECRET,
        nameOf,
      );
      expect(confidentiality).toContain("seal");
      expect(confidentiality).not.toContain("content");
    });

    it("carries nothing from below a required key the reader never reads", async () => {
      await seed("below", { name: "n", secret: { inner: "s" } }, [
        existence(["secret"], "seal"),
        existence(["secret", "inner"], "inner-existence"),
        content(["secret", "inner"], "inner-content"),
      ]);
      const confidentiality = await readAndCopy(
        "below",
        {
          type: "object",
          properties: {
            name: { type: "string" },
            secret: {
              type: "object",
              properties: { inner: { type: "string" } },
            },
          },
          required: ["name", "secret"],
        } as const,
        nameOf,
      );
      expect(confidentiality).toContain("seal");
      expect(confidentiality).not.toContain("inner-existence");
      expect(confidentiality).not.toContain("inner-content");
    });

    it("carries nothing from an optional key the reader never reads", async () => {
      await seed("optional", { name: "n", secret: "s", note: "x" }, [
        existence(["note"], "note-existence"),
      ]);
      expect(await readAndCopy("optional", REQUIRES_SECRET, nameOf))
        .toEqual([]);
    });
  });

  describe("a union", () => {
    it("carries the existence label of the key that decides which branch matches", async () => {
      // A union the value's type does not settle is evaluated whole, by the
      // traversal an eager read uses, so the branch it selects is read.
      await seed("union", { secret: "s" }, [existence(["secret"], "seal")]);
      expect(
        await readAndCopy(
          "union",
          {
            anyOf: [
              {
                type: "object",
                properties: { secret: { type: "string" } },
                required: ["secret"],
              },
              {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            ],
          } as const,
          (argument) => argument === undefined,
        ),
      ).toContain("seal");
    });
  });

  describe("an enumeration", () => {
    const OPTIONAL_SECRET: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" }, secret: { type: "string" } },
    } as const;

    it("carries the existence label of each key it lists", async () => {
      await seed("listed", { name: "n", secret: "s" }, [
        existence(["secret"], "seal"),
      ]);
      expect(
        await readAndCopy(
          "listed",
          OPTIONAL_SECRET,
          (argument: object | undefined) =>
            Reflect.ownKeys(argument ?? {}).length,
        ),
      ).toContain("seal");
    });

    it("carries nothing from the value label of a key it lists", async () => {
      await seed("listed-value", { name: "n", secret: "s" }, [
        content(["secret"], "content"),
      ]);
      expect(
        await readAndCopy(
          "listed-value",
          OPTIONAL_SECRET,
          (argument: object | undefined) =>
            Reflect.ownKeys(argument ?? {}).length,
        ),
      ).toEqual([]);
    });
  });

  describe("a lift", () => {
    /**
     * Runs a lift that reads `name` off `source` through `schema`, and returns
     * how many times its body has run, the result cell, and the document its
     * output is stored in.
     */
    const runReadName = async (
      source: string,
      schema: JSONSchema = REQUIRES_SECRET,
    ) => {
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, lift } = commonfabric;
      let runs = 0;
      const readName = lift(
        (argument: { name: string }) => {
          runs++;
          return argument.name;
        },
        schema,
        { type: "string" } as const,
      );
      const readNamePattern = pattern<{ source: { name: string } }>(
        ({ source }) => ({ out: readName(source) }),
      );

      const tx = runtime.edit();
      const sourceCell = runtime.getCell(space, source, undefined, tx);
      const resultCell = runtime.getCell<{ out: string }>(
        space,
        `${source}-result`,
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        readNamePattern,
        { source: sourceCell },
        resultCell,
      );
      expect((await tx.commit()).ok).toBeDefined();
      await result.pull();
      await runtime.idle();
      const outputId = () => {
        const read = runtime.edit();
        const id = resolveLink(
          runtime,
          read,
          result.key("out").getAsNormalizedFullLink(),
        ).id;
        read.abort();
        return id;
      };
      return { runs: () => runs, result, outputId };
    };

    /**
     * Replaces the whole value stored at `cause`, then pulls `result`, which
     * runs whatever the change invalidated beneath it.
     */
    const overwrite = async (
      cause: string,
      value: FabricValue,
      result: { pull(): Promise<unknown> },
    ) => {
      const tx = runtime.edit();
      runtime.getCell(space, cause, undefined, tx).set(value);
      expect((await tx.commit()).ok).toBeDefined();
      await result.pull();
      await runtime.idle();
    };

    it("stamps its output with the existence label of a required key it never reads", async () => {
      await seed("lift-source", { name: "n", secret: "s" }, [
        existence(["secret"], "seal"),
      ]);
      const { result, outputId } = await runReadName("lift-source");
      expect(result.key("out").get()).toBe("n");
      expect(derivedConfidentiality(outputId())).toContain("seal");
    });

    it("does not run again when only the value of a required key it never reads changes", async () => {
      await seed("lift-value-change", { name: "n", secret: "s" }, []);
      const { runs, result } = await runReadName("lift-value-change");
      const before = runs();
      expect(before).toBeGreaterThan(0);
      await overwrite("lift-value-change", { name: "n", secret: "t" }, result);
      expect(runs()).toBe(before);
    });

    it("runs again when a required key it never reads goes away", async () => {
      // The declared default keeps the argument valid without the key, so the
      // body runs whenever the lift does.
      await seed("lift-key-removed", { name: "n", secret: "s" }, []);
      const { runs, result } = await runReadName(
        "lift-key-removed",
        {
          type: "object",
          properties: {
            name: { type: "string" },
            secret: { type: "string", default: "d" },
          },
          required: ["name", "secret"],
        } as const,
      );
      const before = runs();
      expect(before).toBeGreaterThan(0);
      await overwrite("lift-key-removed", { name: "n" }, result);
      expect(runs()).toBeGreaterThan(before);
    });
  });
});
