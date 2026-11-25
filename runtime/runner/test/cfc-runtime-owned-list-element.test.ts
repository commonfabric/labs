import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runtime owned list element");
const space = signer.did();
const stranger =
  (await Identity.fromPassphrase("runtime owned list element stranger")).did();

/** A clause no residency clause of `space` covers. */
const strangerOnly = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: stranger,
};

/**
 * A running piece's own list, written once by a transaction that read a
 * labeled value, then extended by keyed element the way a handler extends
 * one: `elementById()` names the element's document, the handler writes it,
 * and `addUnique()` adds its membership.
 */
describe("runtime-owned list elements", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A source whose `secret` field carries {@link strangerOnly}. */
  const seedSecret = async (name: string) => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, name, {
      type: "object",
      properties: { secret: { type: "string" } },
    } as JSONSchema);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: [strangerOnly] },
          }],
        },
      },
      // deno-lint-ignore no-explicit-any
    } as any);
    expect((await seed.commit().settled).error).toBeUndefined();
  };

  /** Start a piece holding a list of its own, and hand back its result. */
  const startPiece = async (name: string) => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => ({
      items: BuilderCell.of<{ name: string }[]>([]),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      name,
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return result;
  };

  type Piece = Awaited<ReturnType<typeof startPiece>>;

  /** Replace the list with one element derived from the labeled source. */
  const overRead = async (piece: Piece, sourceName: string) => {
    const tx = runtime.edit();
    const source = runtime.getCell(space, sourceName, undefined, tx);
    const raw = source.getRaw() as { secret?: string };
    // deno-lint-ignore no-explicit-any
    (piece.withTx(tx) as any).key("items").set([{ name: `${raw.secret}` }]);
    tx.prepareCfc();
    return await tx.commit().settled;
  };

  /**
   * Add an element by key, reading nothing but the list: write the keyed
   * element's document, then add its membership.
   */
  const addByKey = async (piece: Piece, key: string) => {
    const tx = runtime.edit();
    // deno-lint-ignore no-explicit-any
    const list = (piece.withTx(tx) as any).key("items");
    const entry = list.elementById(key);
    entry.set({ name: key });
    list.addUnique(entry);
    tx.prepareCfc();
    return await tx.commit().settled;
  };

  it("commits a keyed add to a list no labeled write has reached", async () => {
    const piece = await startPiece("clean-list");

    expect((await addByKey(piece, "first")).error).toBeUndefined();
  });

  it("commits a labeled write to the list itself", async () => {
    await seedSecret("tainting-source");
    const piece = await startPiece("tainted-list");

    expect((await overRead(piece, "tainting-source")).error).toBeUndefined();
  });

  it("commits a keyed add after a labeled write reached the list", async () => {
    // `addUnique()` reads the list only to decide whether to append, so the
    // clause the earlier write left there is not this transaction's to
    // carry into the keyed element's document.
    await seedSecret("wedging-source");
    const piece = await startPiece("wedged-list");
    expect((await overRead(piece, "wedging-source")).error).toBeUndefined();

    const added = await addByKey(piece, "after");

    expect(added.error).toBeUndefined();
  });

  it("commits a plain-value add after a labeled write reached the list", async () => {
    await seedSecret("plain-source");
    const piece = await startPiece("plain-list");
    expect((await overRead(piece, "plain-source")).error).toBeUndefined();
    const tx = runtime.edit();
    // deno-lint-ignore no-explicit-any
    (piece.withTx(tx) as any).key("items").addUnique({ name: "plain" });
    tx.prepareCfc();

    const { error } = await tx.commit().settled;

    expect(error).toBeUndefined();
  });

  it("refuses a keyed add whose handler read the labeled list", async () => {
    // Reading the list's content is an observation of the clause, and the
    // keyed element's document has no declaration to hold it.
    await seedSecret("observed-source");
    const piece = await startPiece("observed-list");
    expect((await overRead(piece, "observed-source")).error).toBeUndefined();
    const tx = runtime.edit();
    // deno-lint-ignore no-explicit-any
    const list = (piece.withTx(tx) as any).key("items");
    const seen = (list.get() as { name: string }[]).length;
    const entry = list.elementById("observed");
    entry.set({ name: `after ${seen}` });
    list.addUnique(entry);
    tx.prepareCfc();

    const { error } = await tx.commit().settled;

    expect(error?.message).toContain("writer-fit confidentiality misfit");
  });

  it("refuses a keyed add whose element carries the labeled source", async () => {
    await seedSecret("carried-source");
    const piece = await startPiece("carried-list");
    const tx = runtime.edit();
    const source = runtime.getCell(space, "carried-source", undefined, tx);
    const raw = source.getRaw() as { secret?: string };
    // deno-lint-ignore no-explicit-any
    const list = (piece.withTx(tx) as any).key("items");
    const entry = list.elementById("carried");
    entry.set({ name: `${raw.secret}` });
    list.addUnique(entry);
    tx.prepareCfc();

    const { error } = await tx.commit().settled;

    expect(error?.message).toContain("writer-fit confidentiality misfit");
  });
});
