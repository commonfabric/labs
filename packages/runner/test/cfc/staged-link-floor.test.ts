/**
 * An integrity floor (§8.12.4.1) below a link the runtime staged, as a list
 * builtin stages a callback's capture, is met only by what the link brings
 * there: staging writes none of the value and mints none of the slot's
 * integrity. Where the link's source reaches the value through links stored
 * before the transaction, the value is credited with the label of the
 * document a reader finds it in (§8.2.6), by the reader's own walk, and with
 * nothing where that walk cannot finish.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import type { JSONSchema, SchemaScope } from "../../src/builder/types.ts";
import type { IFCLabel } from "../../src/cfc/mod.ts";
import { recordCapturedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-staged-link-floor");
const space = signer.did();
const elsewhere = (await Identity.fromPassphrase("cfc-staged-link-floor-2"))
  .did();

const ADMIN = "admin-approved";

/**
 * A string whose value has to carry the `ADMIN` endorsement, read under
 * `scope` where one is given, and minted by a write through it where `mints`.
 */
const floored = (
  { scope, mints = false }: { scope?: SchemaScope; mints?: boolean } = {},
): JSONSchema => ({
  type: "string",
  ...(scope !== undefined && { scope }),
  ifc: {
    requiredIntegrity: [ADMIN],
    ...(mints && { addIntegrity: [ADMIN] }),
  },
});

/**
 * The argument a list builtin stages captures into: one captured record at
 * `params/record`, whose `secret` is floored, and captured fields at
 * `params/secret`, floored itself, and `params/minted`, floored and minting
 * what its floor requires. `cap` declares the scope the reader of the
 * record's `secret` may follow links in.
 */
const argumentSchema = (cap?: SchemaScope): JSONSchema => ({
  type: "object",
  properties: {
    params: {
      type: "object",
      properties: {
        record: {
          type: "object",
          properties: {
            secret: floored({ scope: cap }),
          },
        },
        secret: floored(),
        minted: floored({ mints: true }),
      },
    },
  },
});

describe("cfc-staged-link-floor", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      cfcWriteFloor: "enforce",
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  /**
   * Stores `value` in the document `id` of `inSpace`, with `label` at
   * `path`, as a document an earlier transaction wrote under its own schema.
   */
  async function seed(
    id: string,
    value: FabricValue,
    label: IFCLabel = {},
    path: string[] = [],
    inSpace: MemorySpace = space,
  ): Promise<void> {
    const tx = runtime.edit();
    const docId = runtime.getCell(inSpace, id, undefined, tx)
      .getAsNormalizedFullLink().id as URI;
    writeSeedEnvelopeDoc(tx, inSpace);
    seedStoredEnvelope(tx, {
      space: inSpace,
      id: docId,
      type: "application/json",
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path, label }] },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
  }

  /** A link to `path` of the document `id`, as a stored value holds one. */
  function linkTo(
    id: string,
    path: string[],
    inSpace: MemorySpace = space,
  ): FabricValue {
    const tx = runtime.edit();
    let cell = runtime.getCell<unknown>(inSpace, id, undefined, tx);
    for (const key of path) cell = cell.key(key as never);
    const link = cell.getAsLink();
    tx.abort();
    return link as unknown as FabricValue;
  }

  /**
   * Stages a capture of `path` of the document `id` at `params/<at>` of a new
   * argument, as a list builtin stages one, and records it unless `staged`
   * is false, when the link is an ordinary write. Returns the commit's error.
   */
  async function stage(
    at: "record" | "secret" | "minted",
    id: string,
    path: string[],
    { cap, staged = true }: { cap?: SchemaScope; staged?: boolean } = {},
  ): Promise<string | undefined> {
    const tx = runtime.edit();
    let source = runtime.getCell<unknown>(space, id, undefined, tx);
    for (const key of path) source = source.key(key as never);
    const argument = runtime.getCell(
      space,
      `argument-${at}-${id}-${staged}-${cap}`,
      argumentSchema(cap),
      tx,
    );
    argument.set({ params: { [at]: source.getAsWriteRedirectLink() } });
    if (staged) {
      recordCapturedArgumentFields(tx, argument.getAsNormalizedFullLink(), [
        "params",
      ]);
    }
    runtime.prepareTxForCommit(tx);
    return (await tx.commit()).error?.message;
  }

  const refusedAt = (at: string) =>
    `write floor failed at /params/${at} (requiredIntegrity, §8.12.4.1)`;

  it("credits a captured record with the label of the document its stored link leads to", async () => {
    await seed("e", { secret: "ok" }, { integrity: [ADMIN] }, ["secret"]);
    await seed("a", { secret: linkTo("e", ["secret"]) });
    expect(await stage("record", "a", [])).toBeUndefined();
  });

  it("credits no document the stored links only pass through", async () => {
    // a/secret → m/secret → p/secret. `m` labels the slot holding its link,
    // and `p`, which holds the value, endorses nothing.
    await seed("p", { secret: "unendorsed" });
    await seed("m", { secret: linkTo("p", ["secret"]) }, {
      integrity: [ADMIN],
    }, ["secret"]);
    await seed("a", { secret: linkTo("m", ["secret"]) });
    expect(await stage("record", "a", [])).toContain(
      refusedAt("record/secret"),
    );
    expect(await stage("record", "m", [])).toContain(
      refusedAt("record/secret"),
    );
    expect(await stage("secret", "m", ["secret"])).toContain(
      refusedAt("secret"),
    );
  });

  it("commits a captured field whose source holds nothing there where the field's schema mints its floor", async () => {
    await seed("empty", {});
    await seed("via", { secret: linkTo("empty", ["secret"]) });
    expect(await stage("minted", "empty", ["secret"])).toBeUndefined();
    expect(await stage("minted", "via", ["secret"])).toBeUndefined();
  });

  it("refuses a captured field whose source holds nothing there where the field's schema mints nothing", async () => {
    // Nothing lands through the capture, so only a write through the field's
    // schema could meet the floor, and this one mints nothing.
    await seed("empty", {});
    expect(await stage("secret", "empty", ["secret"])).toContain(
      refusedAt("secret"),
    );
  });

  for (const crossDocument of [false, true]) {
    it(`refuses, and finishes, a capture whose stored links grow its path ${crossDocument ? "across documents" : "in their own document"}`, async () => {
      // `loop-a` labels the slot holding its link, which holds no value.
      const slotLabel = { integrity: [ADMIN] };
      if (crossDocument) {
        await seed("loop-a", { x: linkTo("loop-b", ["y"]) }, slotLabel, ["x"]);
        await seed("loop-b", { y: linkTo("loop-a", ["x", "z"]) });
      } else {
        await seed("loop-a", { x: linkTo("loop-a", ["x", "z"]) }, slotLabel, [
          "x",
        ]);
      }
      expect(await stage("record", "loop-a", ["x"])).toContain(
        refusedAt("record/secret"),
      );
      expect(await stage("secret", "loop-a", ["x", "secret"])).toContain(
        refusedAt("secret"),
      );
    });
  }

  it("refuses a capture whose stored link leads into a scope its reader may not follow", async () => {
    const tx = runtime.edit();
    const user = runtime.getCell(
      space,
      "u",
      {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { addIntegrity: [ADMIN] } },
        },
      },
      tx,
      "user",
    );
    user.set({ secret: "ok" });
    expect((await tx.commit()).error).toBeUndefined();
    const read = runtime.edit();
    const toUser = runtime.getCell<unknown>(space, "u", undefined, read, "user")
      .key("secret" as never).getAsLink();
    read.abort();
    // `a` labels the slot holding its link, which holds no value.
    await seed("a", { secret: toUser as unknown as FabricValue }, {
      integrity: [ADMIN],
    }, ["secret"]);
    // The same chain commits for a reader that may follow it.
    expect(await stage("record", "a", [])).toBeUndefined();
    expect(await stage("record", "a", [], { cap: "space" })).toContain(
      refusedAt("record/secret"),
    );
  });

  it("credits the label of a document in another space a stored link leads to", async () => {
    await seed("e", { secret: "ok" }, { integrity: [ADMIN] }, [
      "secret",
    ], elsewhere);
    await seed("p", { secret: "unendorsed" }, {}, [], elsewhere);
    await seed("to-e", { secret: linkTo("e", ["secret"], elsewhere) });
    await seed("to-p", { secret: linkTo("p", ["secret"], elsewhere) });
    expect(await stage("record", "to-e", [])).toBeUndefined();
    expect(await stage("record", "to-p", [])).toContain(
      refusedAt("record/secret"),
    );
  });

  it("keeps a written link's credit: the label its source stores at the path", async () => {
    // Only a link the runtime staged is credited where its value is held. A
    // link a write sets is credited with its source's own label, as before.
    await seed("e", { secret: "ok" }, { integrity: [ADMIN] }, ["secret"]);
    await seed("a", { secret: linkTo("e", ["secret"]) });
    expect(await stage("record", "a", [], { staged: false })).toContain(
      refusedAt("record/secret"),
    );
  });
});
