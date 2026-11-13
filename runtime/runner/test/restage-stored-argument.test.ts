import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { refusedArgumentSlotsCell } from "../src/refused-argument-slots.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("restage-stored-argument");
const space = signer.did();

/** The confidentiality a planted slot label carries. */
const ATOM = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: space,
};

describe("restage-stored-argument", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A pattern whose result is `{ a }` over an argument under `schema`. */
  const patternOver = (schema: JSONSchema) => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    return pattern(
      (argument: { a?: unknown }) => ({ a: argument.a }),
      schema as never,
      { type: "object" } as never,
    );
  };

  /**
   * Sets `pattern` up on the result document `cause` over `argument`, and
   * returns what the setup threw, if anything, and whether its transaction
   * committed.
   */
  const setUp = async (
    cause: string,
    pattern: ReturnType<typeof patternOver>,
    argument: unknown,
  ): Promise<{ cell: Cell<unknown>; thrown?: unknown; committed: boolean }> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    let thrown: unknown;
    try {
      await runtime.setup(tx, pattern, argument, cell);
    } catch (error) {
      thrown = error;
    }
    const { error } = await tx.commit().settled;
    await runtime.idle();
    return { cell, thrown, committed: error === undefined };
  };

  /** The argument document `cell` stores, read under no schema. */
  const storedArgument = (cell: Cell<unknown>): unknown =>
    runtime.getCellFromLink({
      ...getMetaLink(cell, "argument")!,
      schema: undefined,
    }).getRaw();

  describe("an update that adds a required scoped slot", () => {
    // The setup's write fills a scoped slot it is not given with a redirect to
    // the instance that holds it, so the argument it stages has the slot the
    // update requires though the value it staged does not.

    const before: JSONSchema = {
      type: "object",
      properties: { a: { type: "string" }, keep: { type: "string" } },
    };
    const after: JSONSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        keep: { type: "string" },
        pref: { type: "string", scope: "user" },
      },
      required: ["pref"],
    };

    it("commits with no argument supplied", async () => {
      await setUp("scoped-unsupplied", patternOver(before), {
        a: "x",
        keep: "mine",
      });

      const { cell, thrown, committed } = await setUp(
        "scoped-unsupplied",
        patternOver(after),
        undefined,
      );

      expect(thrown).toBeUndefined();
      expect(committed).toBe(true);
      expect(storedArgument(cell)).toMatchObject({ a: "x", keep: "mine" });
    });

    it("keeps the slots it carries over in place with an argument supplied", async () => {
      await setUp("scoped-supplied", patternOver(before), {
        a: "x",
        keep: "mine",
      });

      const { cell, thrown, committed } = await setUp(
        "scoped-supplied",
        patternOver(after),
        { a: "y" },
      );

      expect(thrown).toBeUndefined();
      expect(committed).toBe(true);
      expect(storedArgument(cell)).toMatchObject({ a: "y", keep: "mine" });
      expect(
        refusedArgumentSlotsCell(runtime, cell.getAsNormalizedFullLink())
          .getRawUntyped(),
      ).toBeUndefined();
    });
  });

  it("keeps a stored argument that is a class instance whole across an update", async () => {
    const stamp = new FabricEpochNsec(5n);
    await setUp("instance-argument", patternOver(true as JSONSchema), stamp);

    const { cell, thrown, committed } = await setUp(
      "instance-argument",
      patternOver({} as JSONSchema),
      undefined,
    );

    expect(thrown).toBeUndefined();
    expect(committed).toBe(true);
    const stored = storedArgument(cell);
    expect(stored).toBeInstanceOf(FabricEpochNsec);
    expect(String(stored)).toBe(String(stamp));
  });

  it("labels the refused-slot store with the restriction stored at the slot of a link the update refuses", async () => {
    // A refused slot's value moves to the store by a plain write, which
    // carries no link's restriction, so the setup reads the slot as content
    // first and its label joins what the setup writes.

    const counter = runtime.getCell(space, "refused-link-counter");
    const { error } = await runtime.editWithRetry((tx) => {
      counter.withTx(tx).set({ count: 3 });
    });
    expect(error).toBeUndefined();
    const { cell } = await setUp(
      "refused-link",
      patternOver({ type: "object" }),
      { a: "x", tally: counter },
    );
    const argument = getMetaLink(cell, "argument")!;
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      space,
      scope: "space",
      id: argument.id,
      path: ["cfc"],
    }, {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["tally"],
          label: { confidentiality: [ATOM] },
          origin: "declared",
          observes: "followRef",
        }],
      },
    } as never);
    expect((await seed.commit().settled).error).toBeUndefined();

    const { committed } = await setUp(
      "refused-link",
      patternOver({
        type: "object",
        properties: { a: { type: "string" }, tally: { type: "number" } },
      }),
      { a: "y" },
    );

    expect(committed).toBe(true);
    const store = refusedArgumentSlotsCell(
      runtime,
      cell.getAsNormalizedFullLink(),
    );
    expect(store.getRawUntyped()).toBeDefined();
    const read = runtime.edit();
    try {
      const entries = readStoredCfcMetadata(read, {
        space,
        id: store.getAsNormalizedFullLink().id,
      })?.labelMap.entries ?? [];
      expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
        .toContainEqual(ATOM);
    } finally {
      read.abort("label read");
    }
  });
});
