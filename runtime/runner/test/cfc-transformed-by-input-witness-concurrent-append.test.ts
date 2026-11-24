import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type {
  ImplementationIdentity,
  LabelMapEntry,
} from "../src/cfc/types.ts";
import { type Cell, cellTx } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// An append commits as a tail-relative operation, and the server puts it at
// the list's live tail, while the label envelope the appending transaction
// computed describes the list as it saw it. Two appends from sessions that
// saw the same list would land at two positions with the envelope written
// last describing one of them at the position the other took, so a labeled
// append whose list moved under it conflicts and is re-derived against the
// live list (`SpaceReplica.#commitReadActivities`), and its stamp lands
// beside its own element. An envelope written under that rule says so, in
// `stampPlacement`. One that does not say it can stamp a slot beside another
// writer's reference with nothing telling which reference the stamp
// describes, so a slot stamp in it witnesses nothing (CFC §18.7), and an
// envelope that carries such a stamp forward does not say it either.

const signer = await Identity.fromPassphrase("cfc-witness-concurrent-append");
const space = signer.did();
const ROOM = cfcAtom.space(space);

const verified = (
  moduleIdentity: string,
  symbol: string,
): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity,
  symbol,
  bindingPath: [symbol],
});

const SUBMIT = verified("module:conclave", "submit");
const COMMIT = verified("module:conclave", "commit");
const ATTACKER = verified("module:attacker", "plant");

const runtimeOver = (storageManager: EmulatedStorageManager) =>
  new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });

/** Seeds a labeled document each writer reads, and the empty list. */
const seed = async (runtime: Runtime): Promise<void> => {
  const tx = runtime.edit();
  const id = runtime.getCell(space, "secret", undefined, tx)
    .getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(tx, space);
  seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
    value: { note: "s" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: [], label: { confidentiality: [ROOM] } }],
      },
    },
  });
  runtime.getCell(space, "briefs", undefined, tx).set([]);
  expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
    .toBeUndefined();
  await runtime.storageManager.synced();
};

/** Loads the list and the labeled document at the runtime's current basis. */
const load = async (runtime: Runtime): Promise<void> => {
  for (const name of ["briefs", "secret"]) {
    const cell = runtime.getCell(space, name);
    await cell.sync();
    await cell.pull();
  }
};

/**
 * Appends one brief as `identity`, in a frame of its own, the way a handler
 * run does: an append whose list moved under it is refused, and is re-run
 * against the live list. The server's fan-out is manual here, so the re-run
 * drives it itself, where `editWithRetry` would wait to be caught up.
 */
const push = async (
  server: MemoryV2Server.Server,
  runtime: Runtime,
  identity: ImplementationIdentity,
  vote: string,
): Promise<void> => {
  const attempt = async () => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, identity);
    runtime.getCell(space, "secret", undefined, tx).getRaw();
    const frame = pushFrame({
      generatedIdCounter: 0,
      cause: `${identity.kind === "verified" ? identity.symbol : ""}-${vote}`,
    });
    try {
      runtime.getCell<unknown[]>(space, "briefs", undefined, tx)
        .push({ vote } as never);
    } finally {
      popFrame(frame);
    }
    tx.prepareCfc();
    return (await tx.commit({ holdSyncedUntilCovered: false }).verdict).error;
  };
  let error = await attempt();
  if (error?.name === "ConflictError") {
    await server.flushSessions();
    await load(runtime);
    error = await attempt();
  }
  expect(error).toBeUndefined();
  await runtime.storageManager.synced();
};

/** Where the stored envelope of the document `name` says its stamps sit. */
const storedStampPlacement = async (
  server: MemoryV2Server.Server,
  name: string,
): Promise<string | undefined> => {
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = runtimeOver(storageManager);
  try {
    const cell = runtime.getCell(space, name);
    await cell.sync();
    const tx = runtime.edit();
    const metadata = readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
    tx.abort();
    return metadata?.stampPlacement;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/**
 * The stored envelope of the list of briefs: at each slot, the writer its
 * value stamp names.
 */
const storedSlotStamps = async (
  server: MemoryV2Server.Server,
): Promise<{ slot: string; writer: string }[]> => {
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = runtimeOver(storageManager);
  try {
    await load(runtime);
    const tx = runtime.edit();
    const briefs = runtime.getCell<unknown[]>(space, "briefs", undefined, tx);
    const metadata = readStoredCfcMetadata(
      tx,
      briefs.getAsNormalizedFullLink(),
    );
    tx.abort();
    return (metadata?.labelMap.entries ?? []).flatMap((entry) => {
      if (
        entry.observes !== "value" || entry.path.length !== 1 ||
        !/^\d+$/.test(entry.path[0])
      ) return [];
      const integrity = entry.label.integrity ?? [];
      const writer = integrity.find((atom) =>
        (atom as { type?: unknown }).type === CFC_ATOM_TYPE.TransformedBy
      ) as { identity?: { symbol?: string } } | undefined;
      return [{ slot: entry.path[0], writer: writer?.identity?.symbol ?? "" }];
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** Runs `step` as the attacker's code, in a frame of its own. */
const asAttacker = async (
  runtime: Runtime,
  step: (briefs: Cell<unknown[]>) => void,
): Promise<void> => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, ATTACKER);
  runtime.getCell(space, "secret", undefined, tx).getRaw();
  const frame = pushFrame({ generatedIdCounter: 0, cause: "attacker" });
  try {
    step(runtime.getCell<unknown[]>(space, "briefs", undefined, tx));
  } finally {
    popFrame(frame);
  }
  tx.prepareCfc();
  expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
    .toBeUndefined();
  await runtime.storageManager.synced();
};

/**
 * Whether the commit step, reading every brief through its reference, mints
 * the witness naming the submit step.
 */
const commitWitnessesSubmit = async (
  server: MemoryV2Server.Server,
  expectedVotes: string[],
): Promise<boolean> => {
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = runtimeOver(storageManager);
  try {
    await load(runtime);
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, COMMIT);
    const briefs = runtime.getCell<{ vote: string }[]>(
      space,
      "briefs",
      undefined,
      tx,
    ).get();
    const votes = (briefs ?? []).map((brief) => brief.vote);
    expect(votes).toEqual(expectedVotes);
    runtime.getCell(space, "committed", undefined, tx).set({ votes });
    tx.prepareCfc();
    expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
    const readTx = runtime.edit();
    const metadata = readStoredCfcMetadata(
      readTx,
      runtime.getCell(space, "committed", undefined, readTx)
        .getAsNormalizedFullLink(),
    );
    readTx.abort();
    return (metadata?.labelMap.entries ?? []).some((entry) =>
      (entry.label.integrity ?? []).some((atom) => {
        const witness = (atom as { inputWitness?: { identity?: unknown } })
          .inputWitness;
        return (atom as { type?: unknown }).type ===
            CFC_ATOM_TYPE.TransformedBy &&
          witness !== undefined &&
          (witness.identity as { symbol?: unknown })?.symbol ===
            "submit";
      })
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/**
 * Rewrites the list's stored envelope with the entries `entriesOf` makes of
 * the stored ones, the same ones unless told otherwise, and with
 * `stampPlacement` saying where its stamps sit, or nothing of the kind when
 * it is left out.
 */
const rewriteStoredEnvelope = async (
  runtime: Runtime,
  entriesOf: (stored: LabelMapEntry[]) => LabelMapEntry[] = (stored) => stored,
  stampPlacement?: "committed",
): Promise<void> => {
  await load(runtime);
  const read = runtime.edit();
  const briefs = runtime.getCell<unknown[]>(space, "briefs", undefined, read);
  const value = briefs.getRaw();
  const metadata = readStoredCfcMetadata(
    read,
    briefs.getAsNormalizedFullLink(),
  );
  read.abort();
  const tx = runtime.edit();
  seedStoredEnvelope(tx, {
    space,
    scope: "space",
    id: briefs.getAsNormalizedFullLink().id,
    path: [],
  }, {
    value: value as never,
    cfc: {
      version: 1,
      schemaHash: metadata?.schemaHash ?? SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: entriesOf(metadata?.labelMap.entries ?? []),
      },
      ...(stampPlacement !== undefined ? { stampPlacement } : {}),
    },
  } as never);
  expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
    .toBeUndefined();
  await runtime.storageManager.synced();
};

/**
 * Rewrites the list's stored envelope as one written before the placement
 * rule held: the same entries, saying nothing of where its stamps sit. In
 * such an envelope nothing says which reference a slot stamp describes.
 */
const forgetStampPlacement = (
  runtime: Runtime,
  entriesOf?: (stored: LabelMapEntry[]) => LabelMapEntry[],
): Promise<void> => rewriteStoredEnvelope(runtime, entriesOf);

describe("input witnesses over appends made concurrently", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    managers = [];
    runtimes = [];
  });
  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  const session = () => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = runtimeOver(manager);
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  it("witnesses the submit step over appends made in turn", async () => {
    const first = session();
    await seed(first);
    await push(server, first, SUBMIT, "reject");
    await push(server, first, SUBMIT, "approve");
    expect(await commitWitnessesSubmit(server, ["reject", "approve"])).toBe(
      true,
    );
  });

  it("lands a labeled append's stamp beside its own element when the list moved under it", async () => {
    // The submit step appends from the list as it was before the attacker
    // appended. Its commit is re-derived against the live list, so its stamp
    // sits at the position the store gave its element, and the attacker's
    // stamp at the position before it is left standing.
    const attacker = session();
    const stale = session();
    await seed(attacker);
    await load(stale);
    await push(server, attacker, ATTACKER, "approve");
    await push(server, stale, SUBMIT, "reject");
    expect(await storedSlotStamps(server)).toEqual([
      { slot: "0", writer: "plant" },
      { slot: "1", writer: "submit" },
    ]);
  });

  it("withholds the witness where a copied reference's slot was stamped by its copier", async () => {
    // The attacker appends a copy of the submitted brief's reference while the
    // submit step appends from the list as it was, then removes the submit
    // step's brief. The slot holding the copy carries the attacker's stamp,
    // which names no step the follower endorses.
    const attacker = session();
    const stale = session();
    await seed(attacker);
    await push(server, attacker, SUBMIT, "reject");
    await load(stale);
    await asAttacker(attacker, (briefs) => {
      const stored = briefs.getRaw() as unknown[];
      briefs.push(stored[0] as never);
    });
    await push(server, stale, SUBMIT, "approve");
    // The attacker's later code, in a session that sees both appends.
    const later = session();
    await load(later);
    await asAttacker(later, (briefs) => {
      const stored = briefs.getRaw() as unknown[];
      expect(stored).toHaveLength(3);
      const submitted = parseLink(stored[2], briefs)!;
      briefs.removeByValue(
        later.getCellFromLink(submitted, undefined, cellTx(briefs)) as never,
      );
    });
    expect(await commitWitnessesSubmit(server, ["reject", "reject"])).toBe(
      false,
    );
  });

  it("says where the stamps sit in an envelope whose slots it stamped beside the references it anchored", async () => {
    const first = session();
    await seed(first);
    await push(server, first, SUBMIT, "reject");
    expect(await storedStampPlacement(server, "briefs")).toBe("committed");
    // The labeled document the step read holds a label and no writer's
    // stamp at a reference slot, so its envelope says nothing of the kind.
    expect(await storedStampPlacement(server, "secret")).toBeUndefined();
  });

  it("withholds the witness through a slot stamp persisted before the placement rule held", async () => {
    // Each slot holds the brief its stamp was written beside, and the stamp
    // still witnesses nothing: an envelope of that vintage can hold a stamp
    // beside another writer's reference, and nothing in it tells the two
    // cases apart.
    const first = session();
    await seed(first);
    await push(server, first, SUBMIT, "reject");
    await push(server, first, SUBMIT, "approve");
    await forgetStampPlacement(first);
    expect(await commitWitnessesSubmit(server, ["reject", "approve"])).toBe(
      false,
    );
  });

  it("keeps withholding the witness while a stamp from before the placement rule stands beside a later append", async () => {
    // The later append's own stamp is placed with its reference, and the
    // envelope still carries the earlier stamps, which nothing places: it
    // says nothing of where its stamps sit, and no slot in it witnesses.
    const writer = session();
    await seed(writer);
    await push(server, writer, SUBMIT, "reject");
    await push(server, writer, SUBMIT, "approve");
    await forgetStampPlacement(writer);
    await load(writer);
    await push(server, writer, SUBMIT, "approve");
    expect(await storedSlotStamps(server)).toEqual([
      { slot: "0", writer: "submit" },
      { slot: "1", writer: "submit" },
      { slot: "2", writer: "submit" },
    ]);
    expect(await storedStampPlacement(server, "briefs")).toBeUndefined();
    expect(
      await commitWitnessesSubmit(server, ["reject", "approve", "approve"]),
    ).toBe(false);
  });

  it("says where the stamps sit when the stamp an earlier envelope left stands at no reference", async () => {
    // The earlier envelope's one stamp names a writer at a path that holds
    // no reference, so the envelope the append writes carries no stamp it
    // cannot place.
    const writer = session();
    await seed(writer);
    await forgetStampPlacement(writer, () => [{
      path: ["note"],
      label: {
        confidentiality: [ROOM],
        integrity: [{ type: CFC_ATOM_TYPE.TransformedBy, identity: SUBMIT }],
      },
      origin: "derived",
      observes: "value",
    }]);
    await load(writer);
    await push(server, writer, SUBMIT, "reject");
    expect(await storedStampPlacement(server, "briefs")).toBe("committed");
  });

  it("takes a link entry's integrity at a slot for no writer's stamp", async () => {
    // The earlier envelope names the submit step at the first slot in the
    // entry that labels the pointer, where a builtin's link schema can put
    // it, and holds no writer's stamp there. A value read consumes no link
    // entry, so nothing at that slot is a stamp the later envelope cannot
    // place.
    const writer = session();
    await seed(writer);
    await push(server, writer, SUBMIT, "reject");
    await forgetStampPlacement(writer, (stored) => [
      ...stored.filter((entry) =>
        !(entry.path[0] === "0" && entry.observes === "value")
      ),
      {
        path: ["0"],
        label: {
          integrity: [{ type: CFC_ATOM_TYPE.TransformedBy, identity: SUBMIT }],
        },
        origin: "link",
      },
    ]);
    await load(writer);
    await push(server, writer, SUBMIT, "approve");
    expect(await storedStampPlacement(server, "briefs")).toBe("committed");
  });

  it("takes no witness from a `TransformedBy` a schema declares over the list's items at a slot another writer filled", async () => {
    // A trusted schema can declare `TransformedBy` in a list's item
    // integrity, and the declared entry stands as store policy over every
    // slot, the ones other writers append included. The attacker's raw
    // append of a copied reference leaves no value stamp at its slot, and
    // the submit step's later append stamps the list's own paths with the
    // submit step again, so the declaration is the only `TransformedBy` at
    // the copied slot. The envelope says where its writers' stamps sit, and
    // the declaration is no writer's stamp: it names no attempt, so the
    // copied slot witnesses nothing.
    const writer = session();
    await seed(writer);
    await push(server, writer, SUBMIT, "reject");
    await rewriteStoredEnvelope(writer, (stored) => [
      ...stored,
      {
        path: ["*"],
        label: {
          integrity: [{ type: CFC_ATOM_TYPE.TransformedBy, identity: SUBMIT }],
        },
        origin: "declared",
      },
    ], "committed");
    const attacker = session();
    await load(attacker);
    await asAttacker(attacker, (briefs) => {
      const stored = briefs.getRaw() as unknown[];
      briefs.push(stored[0] as never);
    });
    await load(writer);
    await push(server, writer, SUBMIT, "approve");
    expect(await storedStampPlacement(server, "briefs")).toBe("committed");
    expect(
      await commitWitnessesSubmit(server, ["reject", "reject", "approve"]),
    ).toBe(false);
  });

  it("withholds the witness where a concurrent append put another writer's element among the submitted ones", async () => {
    // The submit step's session loads the list before the attacker appends,
    // so its append is made against the list as it was and is re-run against
    // the live one. The commit step then reads an element the attacker wrote,
    // whose stamp names no step it endorses.
    const attacker = session();
    const stale = session();
    await seed(attacker);
    await load(stale);
    await push(server, attacker, ATTACKER, "approve");
    await push(server, stale, SUBMIT, "reject");
    expect(await commitWitnessesSubmit(server, ["approve", "reject"])).toBe(
      false,
    );
  });
});
