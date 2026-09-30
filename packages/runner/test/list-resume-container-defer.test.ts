import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hasDataUriScheme } from "@commonfabric/data-model/codec-data-uri";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { Cell } from "../src/cell.ts";
import { ENTITY_URI_SCHEMES } from "../src/entity-kind.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Container-defer guard for the list builtins (filter / flatMap / map).
//
// On a cold resume the coordinator reconcile for one of these builtins reads its
// result container. The reconcile runs after the resume pre-sync settles, so a
// container that was persisted in a prior runtime is loaded before the reconcile
// reads it. The defer guard handles the other case: a container that has no
// durable document at all. Reading it returns undefined, and rather than
// reconcile against that absent value (which would write a stale-basis result
// that conflicts on commit and re-runs in a loop), the builtin pulls the
// container and defers. Once the pull settles and the container is still absent,
// the builtin seeds an empty array so the coordinator is not wedged waiting for
// a value that will never arrive. The per-element results then re-trigger the
// reconcile, which rebuilds the aggregate against the confirmed per-element
// values.
//
// This drives that path deterministically, in three runs. A discovery run on an
// emulated storage manager (its own private in-process server) resolves the
// result container's document id — document ids are content-derived, so the
// same program in the same space yields the same id in every run. The persisted run (runtime A) then builds the
// aggregate against the shared server through a transport that redirects that
// one document's operations in outgoing commits onto a decoy document id: the
// server applies every commit normally, but nothing is ever stored under the
// container's own id, so the container genuinely has no durable document while
// the input list and the per-element result docs persist normally. The resuming
// run (runtime B) loads everything except the container, and the builtin
// recovers: it defers, seeds the empty container (a write the server accepts,
// since no document exists under that id), and rebuilds the aggregate from the
// per-element values. The outcome tests assert that the resume itself wrote
// the container, that no document under the container id arrived before that
// write, that the aggregate converges, and that the resume settles with every
// commit confirmed durably.
//
// The sequence tests prove the recovery order itself from the resume's wire
// traffic and from durable server state, with no reference to the builtins'
// internals. The container is durably absent at resume start while everything
// else the persisted run committed is durably present. The transport then
// withholds the server's answers about the container while the test drives
// the resume, and no write touches the aggregate value (the document's
// `value` slots — structural setup of the document may land) until the test
// releases the answers: a recovery that really waits for the absence
// confirmation writes nothing during the hold, where one that skips the pull
// or reconciles immediately writes during it and fails. After release, the
// server's absence statement precedes the first aggregate write; that write
// is the empty seed (`[]`, no element content); a later write carries the
// full aggregate — the documents the persisted slots link, or the inline
// values themselves; every container write settles, with lost optimistic
// races followed by a confirmed retry; after convergence, further reactive
// rounds and a long stretch of logical time produce no new commits; and a
// fresh runtime, which can see only durable state, materializes the same
// aggregate. The seed-then-rebuild order and the seed's empty content are
// pinned deliberately: they are the recovery contract other clients observe
// on the wire, and a change that coalesces or reorders those writes is a
// behavior change these tests are meant to surface.

const signer = await Identity.fromPassphrase("list resume container defer");
const space = signer.did();

// The document id withheld from the server (the builtin's result container).
// Populated from the discovery run before the persisted run starts.
const withheldDocIds = new Set<string>();

// Where the persisted run's container operations land instead. Any valid,
// never-queried document id works; the resume never asks for it.
const DECOY_DOC_ID = "of:fid1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Inspect an outgoing transact payload's operations on withheld doc ids.
// With `redirect` set, each such operation is moved onto the decoy id.
// Redirecting rather than deleting keeps the commit non-empty and shape-valid
// (some aggregate writes travel as a commit whose only operation is the
// container patch), so the server applies it and pending-read dependencies on
// the commit still resolve. Payloads are `<prefix>:<json>`; anything that does
// not parse or carries no matching operation passes through untouched.
function withheldCommitOps(payload: string, redirect: boolean): {
  payload: string;
  count: number;
} {
  if (!payload.includes('"transact"')) return { payload, count: 0 };
  let matches = false;
  for (const id of withheldDocIds) {
    if (payload.includes(id)) {
      matches = true;
      break;
    }
  }
  if (!matches) return { payload, count: 0 };
  const colon = payload.indexOf(":");
  if (colon < 0) return { payload, count: 0 };
  const prefix = payload.slice(0, colon + 1);
  let obj: any;
  try {
    obj = JSON.parse(payload.slice(colon + 1));
  } catch {
    return { payload, count: 0 };
  }
  if (obj?.type !== "transact" || !Array.isArray(obj?.commit?.operations)) {
    return { payload, count: 0 };
  }
  let count = 0;
  for (const op of obj.commit.operations) {
    if (op && withheldDocIds.has(String(op.id))) {
      if (redirect) op.id = DECOY_DOC_ID;
      count++;
    }
  }
  if (count === 0 || !redirect) return { payload, count };
  return { payload: prefix + JSON.stringify(obj), count };
}

// Count upserts that deliver a document under a withheld doc id in an incoming
// sync payload. The withheld id appears inside other documents' values (the
// result doc links to the container), so a substring check is not enough; and
// an upsert without a `doc` is the server stating the document is absent
// (`deleted: true`), not sending it, so only upserts carrying a document
// count.
function countWithheldUpserts(payload: string): number {
  if (!payload.includes('"upserts"')) return 0;
  let matches = false;
  for (const id of withheldDocIds) {
    if (payload.includes(id)) {
      matches = true;
      break;
    }
  }
  if (!matches) return 0;
  const colon = payload.indexOf(":");
  if (colon < 0) return 0;
  let obj: any;
  try {
    obj = JSON.parse(payload.slice(colon + 1));
  } catch {
    return 0;
  }
  const sync = obj?.ok?.sync ?? obj?.effect;
  if (!sync || !Array.isArray(sync.upserts)) return 0;
  return sync.upserts.filter(
    (u: any) => withheldDocIds.has(String(u?.id)) && u?.doc !== undefined,
  ).length;
}

// Parse a `<prefix>:<json>` wire payload; undefined when it does not parse.
function parseWirePayload(payload: string): any {
  const colon = payload.indexOf(":");
  if (colon < 0) return undefined;
  try {
    return JSON.parse(payload.slice(colon + 1));
  } catch {
    return undefined;
  }
}

// Read durable server state for a set of documents through a separate probe
// session: the document each id holds, or null where the server has none.
// Keys are `id\0scope` with the default scope normalized to "space".
function durableStateKey(id: string, scope: unknown): string {
  return `${id}\0${scope === undefined ? "space" : String(scope)}`;
}
async function durableSnapshots(
  server: MemoryV2Server.Server,
  roots: ReadonlyArray<{ id: string; scope?: unknown }>,
): Promise<Map<string, unknown>> {
  const client = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(server),
  });
  try {
    const session = await client.mount(
      space,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    const result = await session.queryGraph({
      roots: roots.map(({ id, scope }) => ({
        id,
        ...(scope === undefined || scope === "space"
          ? {}
          : { scope: scope as never }),
        selector: { path: [], schema: false },
      })),
    });
    const snapshots = new Map<string, unknown>();
    for (const entity of result.entities) {
      snapshots.set(durableStateKey(entity.id, entity.scope), entity.document);
    }
    return snapshots;
  } finally {
    await client.close();
  }
}

// Whether an incoming sync payload carries any upsert addressed to a withheld
// id — a delivered document or an absence statement alike.
function carriesWithheldUpsert(payload: string): boolean {
  let matches = false;
  for (const id of withheldDocIds) {
    if (payload.includes(id)) {
      matches = true;
      break;
    }
  }
  if (!matches) return false;
  const msg = parseWirePayload(payload);
  const sync = msg?.ok?.sync ?? msg?.effect;
  if (!sync || !Array.isArray(sync.upserts)) return false;
  return sync.upserts.some((u: any) => withheldDocIds.has(String(u?.id)));
}

function rewritingLoopback(
  server: MemoryV2Server.Server,
  redirectSends: boolean,
  onWithheldCommitOp: (n: number) => void,
  onWithheldUpsert: (n: number) => void,
  onFrame?: (direction: "send" | "receive", payload: string) => void,
  holdReceive?: (payload: string) => boolean,
  onHeldReceive?: (deliver: () => void) => void,
): MemoryV2Client.Transport {
  const inner = MemoryV2Client.loopback(server);
  return {
    send: (p: string) => {
      const { payload: rewritten, count } = withheldCommitOps(p, redirectSends);
      if (count > 0) onWithheldCommitOp(count);
      onFrame?.("send", rewritten);
      return inner.send(rewritten);
    },
    close: () => inner.close(),
    setReceiver: (r: (p: string) => void) => {
      inner.setReceiver((payload: string) => {
        const deliver = () => {
          const seen = countWithheldUpserts(payload);
          if (seen > 0) onWithheldUpsert(seen);
          onFrame?.("receive", payload);
          r(payload);
        };
        if (holdReceive?.(payload)) {
          onHeldReceive?.(deliver);
          return;
        }
        deliver();
      });
    },
    setCloseReceiver: (r: (e?: Error) => void) => inner.setCloseReceiver?.(r),
  };
}

class RewritingSessionFactory implements SessionFactory {
  readonly #getServer: () => MemoryV2Server.Server;
  readonly #redirectSends: boolean;
  readonly #onWithheldCommitOp: (n: number) => void;
  readonly #onWithheldUpsert: (n: number) => void;
  readonly #onFrame?: (
    direction: "send" | "receive",
    payload: string,
  ) => void;
  readonly #holdReceive?: (payload: string) => boolean;
  readonly #onHeldReceive?: (deliver: () => void) => void;

  constructor(
    getServer: () => MemoryV2Server.Server,
    redirectSends: boolean,
    onWithheldCommitOp: (n: number) => void,
    onWithheldUpsert: (n: number) => void,
    onFrame?: (
      direction: "send" | "receive",
      payload: string,
    ) => void,
    holdReceive?: (payload: string) => boolean,
    onHeldReceive?: (deliver: () => void) => void,
  ) {
    this.#getServer = getServer;
    this.#redirectSends = redirectSends;
    this.#onWithheldCommitOp = onWithheldCommitOp;
    this.#onWithheldUpsert = onWithheldUpsert;
    this.#onFrame = onFrame;
    this.#holdReceive = holdReceive;
    this.#onHeldReceive = onHeldReceive;
  }
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: rewritingLoopback(
        this.#getServer(),
        this.#redirectSends,
        this.#onWithheldCommitOp,
        this.#onWithheldUpsert,
        this.#onFrame,
        this.#holdReceive,
        this.#onHeldReceive,
      ),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}

class RewritingStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
    options: {
      redirectSends?: boolean;
      onWithheldCommitOp?: (n: number) => void;
      onWithheldUpsert?: (n: number) => void;
      onFrame?: (direction: "send" | "receive", payload: string) => void;
      holdReceive?: (payload: string) => boolean;
      onHeldReceive?: (deliver: () => void) => void;
    } = {},
  ): RewritingStorageManager {
    return new RewritingStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
      options.redirectSends ?? false,
      options.onWithheldCommitOp ?? (() => {}),
      options.onWithheldUpsert ?? (() => {}),
      options.onFrame,
      options.holdReceive,
      options.onHeldReceive,
    );
  }
  private constructor(
    options: Options,
    server: MemoryV2Server.Server,
    redirectSends: boolean,
    onWithheldCommitOp: (n: number) => void,
    onWithheldUpsert: (n: number) => void,
    onFrame?: (direction: "send" | "receive", payload: string) => void,
    holdReceive?: (payload: string) => boolean,
    onHeldReceive?: (deliver: () => void) => void,
  ) {
    super(
      options,
      new RewritingSessionFactory(
        () => server,
        redirectSends,
        onWithheldCommitOp,
        onWithheldUpsert,
        onFrame,
        holdReceive,
        onHeldReceive,
      ),
    );
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

const FILTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
      "  return { kept: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const FLATMAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};

const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { doubled: items.map((item) => item.n * 2) };",
      "});",
    ].join("\n"),
  }],
};

const FILTER_ITEMS = [
  { keep: true, label: "a" },
  { keep: true, label: "b" },
  { keep: false, label: "c" },
  { keep: true, label: "d" },
];
const FLATMAP_ITEMS = [
  { keep: true, n: 1 },
  { keep: false, n: 2 },
  { keep: true, n: 3 },
  { keep: true, n: 4 },
];
const MAP_ITEMS = [{ n: 1 }, { n: 2 }, { n: 3 }];

describe("list builtin resume container defer", () => {
  let server: MemoryV2Server.Server;
  let sm1: RewritingStorageManager;
  let sm2: RewritingStorageManager;
  let redirected: number;
  let withheldUpserts: number;
  let resumeContainerWrites: number;
  let upsertsBeforeFirstContainerWrite: number;
  // Per-test wire observers, installed by a test body before it drives traffic.
  let sm1Frame:
    | ((direction: "send" | "receive", payload: string) => void)
    | undefined;
  let sm2Frame:
    | ((direction: "send" | "receive", payload: string) => void)
    | undefined;
  // When set, incoming resume frames it matches are withheld from the client
  // until the test delivers them; the transport queues their deliveries here.
  let sm2Hold: ((payload: string) => boolean) | undefined;
  let heldDeliveries: Array<() => void>;

  beforeEach(() => {
    redirected = 0;
    withheldUpserts = 0;
    resumeContainerWrites = 0;
    upsertsBeforeFirstContainerWrite = 0;
    sm1Frame = undefined;
    sm2Frame = undefined;
    sm2Hold = undefined;
    heldDeliveries = [];
    withheldDocIds.clear();
    server = newSharedServer();
    sm1 = RewritingStorageManager.make(signer, server, {
      redirectSends: true,
      onWithheldCommitOp: (n) => redirected += n,
      onFrame: (direction, payload) => sm1Frame?.(direction, payload),
    });
    sm2 = RewritingStorageManager.make(signer, server, {
      onWithheldCommitOp: (n) => {
        if (resumeContainerWrites === 0) {
          upsertsBeforeFirstContainerWrite = withheldUpserts;
        }
        resumeContainerWrites += n;
      },
      onWithheldUpsert: (n) => withheldUpserts += n,
      onFrame: (direction, payload) => sm2Frame?.(direction, payload),
      holdReceive: (payload) => sm2Hold?.(payload) ?? false,
      onHeldReceive: (deliver) => heldDeliveries.push(deliver),
    });
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  // Build the aggregate on `storageManager` and resolve the result container's
  // document id from the result cell. The result field's cell write-redirects
  // to the builtin's container; the resolved cell is the container document.
  async function buildAggregateAndResolveContainerId<T>(
    storageManager: StorageManager,
    program: RuntimeProgram,
    items: unknown,
    resultKey: string,
    resultField: string,
    read: (rc: Cell<any>) => T,
    expected: T,
  ) {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const tx0 = runtime.edit();
      const rc = runtime.getCell(space, resultKey, compiled.resultSchema, tx0);
      const handle = runtime.run(tx0, compiled, { items }, rc);
      await tx0.commit();
      for (let k = 0; k < 10; k++) {
        await handle.pull();
        await runtime.idle();
      }
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
      expect(read(rc)).toEqual(expected);

      const resolveTx = runtime.edit();
      const container = rc.key(resultField).withTx(resolveTx).resolveAsCell();
      const containerId = String(container.getAsNormalizedFullLink().id);
      resolveTx.abort("resolve container id");
      return { runtime, containerId, compiled };
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  // Shared front half of both resume tests: discover the container id, then
  // build and persist the aggregate on `sm1` with the container's operations
  // redirected away from its id. Returns the persisted run with its scheduler
  // still live; the runtime is disposed here only when a check fails.
  async function prepareMissingContainer<T>(
    program: RuntimeProgram,
    items: unknown,
    resultKey: string,
    resultField: string,
    read: (rc: Cell<any>) => T,
    expected: T,
  ) {
    // DISCOVERY: resolve the container's document id on a throwaway emulated
    // runtime, so the persisted run below can withhold it from its first
    // commit onward.
    const sm0 = EmulatedStorageManager.emulate({ as: signer });
    let discoveredContainerId: string;
    try {
      const discovery = await buildAggregateAndResolveContainerId(
        sm0,
        program,
        items,
        resultKey,
        resultField,
        read,
        expected,
      );
      discoveredContainerId = discovery.containerId;
      await discovery.runtime.dispose({ closeStorage: false });
    } finally {
      await sm0.close();
    }
    withheldDocIds.add(discoveredContainerId);

    // CREATE (runtime A): build and persist the durable aggregate. The
    // transport redirects the container document's operations, so the server
    // stores nothing under the container's id.
    const created = await buildAggregateAndResolveContainerId(
      sm1,
      program,
      items,
      resultKey,
      resultField,
      read,
      expected,
    );
    try {
      // Document ids are content-derived: the persisted run resolved the same
      // container id the discovery run did, so the redirect targeted the right
      // document.
      expect(created.containerId).toBe(discoveredContainerId);
      // The container's writes were actually redirected away from its id;
      // otherwise the container persisted normally, the resume finds it, and
      // the defer path is not exercised (the assertions below would pass
      // vacuously).
      expect(redirected).toBeGreaterThan(0);
    } catch (error) {
      await created.runtime.dispose();
      throw error;
    }
    return created;
  }

  async function runResumeWithMissingContainer<T>(
    program: RuntimeProgram,
    items: unknown,
    resultKey: string,
    resultField: string,
    read: (rc: Cell<any>) => T,
    expected: T,
  ): Promise<void> {
    const created = await prepareMissingContainer(
      program,
      items,
      resultKey,
      resultField,
      read,
      expected,
    );
    const rt1 = created.runtime;
    // Quiesce the writer in full; sm1 stays open for rt2 and afterEach closes
    // it. Nothing below can throw before this, so no finally is needed.
    await rt1.dispose({ closeStorage: false });

    // RESUME (runtime B): the server has no document under the container id,
    // so the coordinator reconcile reads it undefined and takes the
    // defer-then-seed recovery path.
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(program, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell(
        space,
        resultKey,
        created.compiled.resultSchema,
        tx,
      );
      await tx.commit();

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 25; k++) {
        await rc2.pull();
        await rt2.idle();
      }
      // Durable convergence: every resume commit (the seeded container and
      // the rebuilt aggregate) confirmed by the server.
      await sm2.synced();

      // The resume wrote the container itself — the seeded empty array and
      // the rebuilt aggregate — which only the recovery path does.
      expect(resumeContainerWrites).toBeGreaterThan(0);
      // Until that first recovery write, the server had delivered no
      // document under the container id — only `deleted: true` absence
      // statements — so the reconcile ran against a genuinely absent
      // container.
      expect(upsertsBeforeFirstContainerWrite).toBe(0);
      // After the seed lands the document exists, and the resume session
      // watches it, so the server's later sync frames deliver it. This also
      // keeps the receive-side counter honest: if the sync wire shape
      // drifted past countWithheldUpserts, this fails rather than letting
      // the absence assertion above pass vacuously.
      expect(withheldUpserts).toBeGreaterThan(0);
      // Converges to the durable aggregate despite the missing container.
      expect(read(rc2)).toEqual(expected);
    } finally {
      await rt2.dispose({ closeStorage: false });
    }
  }

  // The fake clock the preload installs per test; absent on a real-clock run.
  // Read through globalThis so this file also type-checks as a standalone
  // program (the ambient declaration in clock.d.ts is in scope only when the
  // package directory is checked as one).
  function fakeClock():
    | { settle(): Promise<void>; tick(ms: number): Promise<void> }
    | undefined {
    return (globalThis as {
      clock?: { settle(): Promise<void>; tick(ms: number): Promise<void> };
    }).clock;
  }

  // Collect every document id a raw value references (link sigils, data URIs).
  // Entity link schemes come from the runtime's registry; `data:` is the
  // inline-literal scheme a slot can hold directly.
  const referencedIdPattern = new RegExp(
    `^(${
      [...ENTITY_URI_SCHEMES.map((scheme) => `${scheme}:`), "data:"].join("|")
    })`,
  );
  function collectReferencedIds(value: unknown, into: Set<string>): void {
    if (typeof value === "string") {
      if (referencedIdPattern.test(value)) into.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collectReferencedIds(entry, into);
      return;
    }
    if (isObjectOrArray(value)) {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        collectReferencedIds(entry, into);
      }
    }
  }

  // Whether a parsed wire value contains an array equal to `slots`, all of
  // whose entries are primitives. This is how an aggregate of inline values
  // (no linked documents) is recognized inside a write.
  function containsPrimitiveArray(value: unknown, slots: unknown[]): boolean {
    if (Array.isArray(value)) {
      if (
        value.length === slots.length &&
        value.every((entry, index) => entry === slots[index])
      ) {
        return true;
      }
      return value.some((entry) => containsPrimitiveArray(entry, slots));
    }
    if (isObjectOrArray(value)) {
      return Object.values(value as Record<string, unknown>).some((entry) =>
        containsPrimitiveArray(entry, slots)
      );
    }
    return false;
  }

  // Read the aggregate's raw slots from the persisted run and derive each
  // element's signature: the document ids its slot links (empty for a slot
  // holding an inline value). The rebuild write must reproduce these.
  function aggregateSlotSignatures(
    runtime: Runtime,
    resultSchema: unknown,
    resultKey: string,
    resultField: string,
    count: number,
  ): { rawSlots: unknown[]; elementLinkIds: string[] } {
    const tx = runtime.edit();
    const rc = runtime.getCell(space, resultKey, resultSchema as never, tx);
    const raw = rc.key(resultField).withTx(tx).resolveAsCell().getRaw();
    tx.abort("read aggregate slots");
    expect(Array.isArray(raw)).toBe(true);
    const rawSlots = structuredClone(raw) as unknown as unknown[];
    expect(rawSlots.length).toBe(count);
    const ids = new Set<string>();
    collectReferencedIds(rawSlots, ids);
    return { rawSlots, elementLinkIds: [...ids] };
  }

  // Ordered wire events observed on the resume transport. `requested` is an
  // outgoing watch or query naming the container; `absent` / `present` are
  // incoming upserts for it (absence statement versus delivered document);
  // `commit` is any outgoing transact; `write` is a transact carrying container
  // operations, with the per-element document ids its container operations
  // reference; `verdict` is the server's response to a container write.
  type SequenceEvent =
    | { t: "requested" }
    | { t: "absent" }
    | { t: "present" }
    | { t: "commit"; requestId: string }
    | {
      t: "write";
      requestId: string;
      setOps: number;
      patchOps: number;
      valueWrites: number;
      elementRefs: string[];
      opsJson: string;
    }
    | { t: "verdict"; requestId: string; ok: boolean };

  // Whether a container operation writes the aggregate value — the document's
  // `value` slots — as opposed to structural plumbing such as the document's
  // result link. A patch addressed at `/value`, or a set whose document
  // carries a `value` field, does; the resume's setup writes do not.
  function writesAggregateValue(op: any): boolean {
    if (op?.op === "set") {
      return isObjectOrArray(op.value) &&
        "value" in op.value;
    }
    if (Array.isArray(op?.patches)) {
      return op.patches.some((patch: any) =>
        typeof patch?.path === "string" &&
        (patch.path === "/value" || patch.path.startsWith("/value/"))
      );
    }
    return false;
  }

  // Whether every aggregate-value operation in a write introduces an empty
  // aggregate: the empty seed writes `[]` and nothing else into the slots.
  function writesEmptyAggregate(containerOps: any[]): boolean {
    let sawValueWrite = false;
    for (const op of containerOps) {
      if (!writesAggregateValue(op)) continue;
      sawValueWrite = true;
      if (op.op === "set") {
        const slots = (op.value as Record<string, unknown>).value;
        if (!Array.isArray(slots) || slots.length !== 0) return false;
        continue;
      }
      for (const patch of op.patches as any[]) {
        if (
          typeof patch?.path !== "string" ||
          (patch.path !== "/value" && !patch.path.startsWith("/value/"))
        ) {
          continue;
        }
        if (!Array.isArray(patch.value) || patch.value.length !== 0) {
          return false;
        }
      }
    }
    return sawValueWrite;
  }

  function recordSequenceFrame(
    log: { events: SequenceEvent[]; writeRequests: Set<string> },
    elementLinkIds: readonly string[],
    direction: "send" | "receive",
    payload: string,
  ): void {
    const msg = parseWirePayload(payload);
    if (msg === undefined) return;
    if (direction === "send") {
      const roots = [
        ...(Array.isArray(msg.watches)
          ? msg.watches.flatMap((w: any) => w?.query?.roots ?? [])
          : []),
        ...(Array.isArray(msg?.query?.roots) ? msg.query.roots : []),
      ];
      if (roots.some((root: any) => withheldDocIds.has(String(root?.id)))) {
        log.events.push({ t: "requested" });
      }
      if (msg.type === "transact" && Array.isArray(msg.commit?.operations)) {
        const requestId = String(msg.requestId);
        log.events.push({ t: "commit", requestId });
        const containerOps = msg.commit.operations.filter((op: any) =>
          op && withheldDocIds.has(String(op.id))
        );
        if (containerOps.length > 0) {
          const json = JSON.stringify(containerOps);
          log.events.push({
            t: "write",
            requestId,
            setOps: containerOps.filter((op: any) => op.op === "set").length,
            patchOps: containerOps.filter((op: any) => op.op !== "set").length,
            valueWrites: containerOps.filter(writesAggregateValue).length,
            elementRefs: elementLinkIds.filter((id) => json.includes(id)),
            opsJson: json,
          });
          log.writeRequests.add(requestId);
        }
      }
      return;
    }
    const sync = msg?.ok?.sync ?? msg?.effect;
    if (sync && Array.isArray(sync.upserts)) {
      for (const upsert of sync.upserts) {
        if (!withheldDocIds.has(String(upsert?.id))) continue;
        log.events.push({
          t: upsert?.doc !== undefined ? "present" : "absent",
        });
      }
    }
    if (
      msg?.type === "response" && log.writeRequests.has(String(msg.requestId))
    ) {
      log.events.push({
        t: "verdict",
        requestId: String(msg.requestId),
        ok: msg.error === undefined,
      });
    }
  }

  // Drive the resume against the genuinely absent container and prove the
  // recovery SEQUENCE, not only the outcome: the container is durably absent
  // while everything else the persisted run wrote is durably present; the
  // resume requests the container and receives the server's absence statement
  // before its first container write; that first write is the bare empty seed;
  // a later write rebuilds the aggregate by linking the persisted per-element
  // documents; every container write is confirmed; and once converged, no
  // further commits occur — including across a long stretch of logical time —
  // with the rebuilt aggregate present in durable server state.
  async function runResumeSequence<T extends unknown[]>(
    program: RuntimeProgram,
    items: unknown,
    resultKey: string,
    resultField: string,
    read: (rc: Cell<any>) => T,
    expected: T,
  ): Promise<void> {
    const persisted = new Map<string, { id: string; scope?: unknown }>();
    sm1Frame = (direction, payload) => {
      if (direction !== "send") return;
      const msg = parseWirePayload(payload);
      if (msg?.type !== "transact" || !Array.isArray(msg.commit?.operations)) {
        return;
      }
      for (const op of msg.commit.operations) {
        if (!op || op.op === "sqlite" || op.op === "delete") continue;
        if (op.id === undefined || op.scope === "session") continue;
        const id = String(op.id);
        if (id === DECOY_DOC_ID) continue;
        persisted.set(durableStateKey(id, op.scope), { id, scope: op.scope });
      }
    };
    const created = await prepareMissingContainer(
      program,
      items,
      resultKey,
      resultField,
      read,
      expected,
    );
    const rt1 = created.runtime;
    try {
      const { rawSlots, elementLinkIds } = aggregateSlotSignatures(
        rt1,
        created.compiled.resultSchema,
        resultKey,
        resultField,
        expected.length,
      );
      // Whatever documents the aggregate's slots link (an inline slot links
      // none) are not the container, and the durable ones were committed by
      // the persisted run. A `data:` id is an inline literal, not a document
      // the server stores.
      for (const id of elementLinkIds) {
        expect(id).not.toBe(created.containerId);
        if (hasDataUriScheme(id)) continue;
        expect(
          [...persisted.values()].some((entry) => entry.id === id),
        ).toBe(true);
      }
      expect(persisted.has(durableStateKey(created.containerId, "space"))).toBe(
        false,
      );
      await rt1.dispose({ closeStorage: false });

      // Durable state as resume begins: the container has no document, while
      // every document the persisted run committed is present.
      const before = await durableSnapshots(server, [
        { id: created.containerId },
        ...persisted.values(),
      ]);
      expect(before.get(durableStateKey(created.containerId, "space")) ?? null)
        .toBe(null);
      for (const [key] of persisted) {
        expect(before.get(key) ?? null).not.toBe(null);
      }

      // RESUME under the sequence recorder, with the server's answers about
      // the container withheld at the transport until the test releases them.
      // The hold turns "does the recovery wait for the absence confirmation"
      // from an ordering accident into a forced property: while the answer is
      // withheld, a recovery that genuinely waits writes nothing, while one
      // that skips the pull or reconciles straight away writes the container
      // during the hold and fails below.
      const log = {
        events: [] as SequenceEvent[],
        writeRequests: new Set<string>(),
      };
      sm2Frame = (direction, payload) =>
        recordSequenceFrame(log, elementLinkIds, direction, payload);
      sm2Hold = carriesWithheldUpsert;
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm2,
      });
      try {
        await rt2.patternManager.compilePattern(program, { space });
        const tx = rt2.edit();
        const rc2 = rt2.getCell(
          space,
          resultKey,
          created.compiled.resultSchema,
          tx,
        );
        await tx.commit();
        const started = await rt2.start(rc2);
        expect(started).toBe(true);
        // Drive the resume with a sink (an effect, so the coordinator runs)
        // rather than pull(), which would wait on the very load being held.
        // The drive is bounded — zero-delay yields, and under the fake clock
        // settle() and a stretch of logical time — and it stops at the first
        // aggregate write, so a recovery that writes while the confirmation
        // is withheld fails the assertion below at once. (A recovery broken
        // that way storms into commit retries against the withheld document;
        // waiting out the storm would wedge the test, so it must not be
        // driven further.)
        const cancelSink = rc2.key(resultField).sink(() => {});
        const wroteAggregateOnHold = () =>
          log.events.some((event) =>
            event.t === "write" && event.valueWrites > 0
          );
        for (let k = 0; k < 40 && !wroteAggregateOnHold(); k++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const holdClock = fakeClock();
        if (holdClock !== undefined && !wroteAggregateOnHold()) {
          await holdClock.settle();
          await holdClock.tick(1_000);
          await holdClock.settle();
        }
        // The resume asked for the container, its answer is still withheld,
        // and no write touched the aggregate value while the confirmation was
        // pending. (Structural setup — the document's result link — may land;
        // the recovery's seed and rebuild may not.)
        expect(wroteAggregateOnHold()).toBe(false);
        expect(log.events.some((event) => event.t === "requested")).toBe(true);
        expect(heldDeliveries.length).toBeGreaterThan(0);
        // Release the withheld answers; recovery can now confirm absence.
        sm2Hold = undefined;
        for (const deliver of heldDeliveries.splice(0)) deliver();
        for (let k = 0; k < 25; k++) {
          await rc2.pull();
          await rt2.idle();
        }
        await sm2.synced();
        await rt2.idle();
        cancelSink();

        // Whether a write carries the aggregate's element content: for an
        // aggregate that links documents, any (or, for the full aggregate,
        // every) linked element id in its container operations; for an
        // aggregate of inline values, the persisted slots appearing as an
        // array in its operations.
        type WriteEvent = Extract<SequenceEvent, { t: "write" }>;
        const carriesAnyElement = (write: WriteEvent): boolean =>
          elementLinkIds.length > 0
            ? write.elementRefs.length > 0
            : containsPrimitiveArray(JSON.parse(write.opsJson), rawSlots);
        const carriesFullAggregate = (write: WriteEvent): boolean =>
          elementLinkIds.length > 0
            ? elementLinkIds.every((id) => write.elementRefs.includes(id))
            : containsPrimitiveArray(JSON.parse(write.opsJson), rawSlots);

        // The recovery sequence, in wire order. Ordering claims anchor on the
        // first write that touches the aggregate value — the recovery's own
        // writes — not on the resume's structural setup of the document.
        const firstIndex = (t: SequenceEvent["t"]) =>
          log.events.findIndex((event) => event.t === t);
        const writes = log.events.filter((event) =>
          event.t === "write"
        ) as WriteEvent[];
        const valueWrites = writes.filter((write) => write.valueWrites > 0);
        const firstValueWrite = log.events.findIndex((event) =>
          event.t === "write" && event.valueWrites > 0
        );
        const firstRequested = firstIndex("requested");
        const firstAbsent = firstIndex("absent");
        // Recovery wrote the aggregate value.
        expect(valueWrites.length).toBeGreaterThan(0);
        // The resume asked the server for the container before writing the
        // aggregate value.
        expect(firstRequested).toBeGreaterThanOrEqual(0);
        expect(firstRequested).toBeLessThan(firstValueWrite);
        // The server's absence statement arrived before the first aggregate
        // write: recovery confirmed absence, then wrote.
        expect(firstAbsent).toBeGreaterThanOrEqual(0);
        expect(firstAbsent).toBeLessThan(firstValueWrite);
        // The first aggregate write is the empty seed — it writes `[]` into
        // the slots and carries none of the aggregate's element content — and
        // the rebuild is a later aggregate write carrying all of it. Nothing
        // between them writes element content either.
        const seed = valueWrites[0];
        expect(writesEmptyAggregate(JSON.parse(seed.opsJson))).toBe(true);
        expect(carriesAnyElement(seed)).toBe(false);
        const rebuildIndex = writes.findIndex(carriesFullAggregate);
        expect(rebuildIndex).toBeGreaterThan(writes.indexOf(seed));
        for (const write of writes.slice(0, rebuildIndex)) {
          expect(carriesAnyElement(write)).toBe(false);
        }
        // Every container write settles with a server verdict; the seed and
        // the final write are confirmed; a write that lost an optimistic race
        // is followed by a confirmed retry; and a confirmed write carrying the
        // full aggregate exists — the rebuild landed durably.
        const verdicts = log.events.filter((event) =>
          event.t === "verdict"
        ) as Extract<SequenceEvent, { t: "verdict" }>[];
        const verdictFor = (write: WriteEvent) =>
          verdicts.find((verdict) => verdict.requestId === write.requestId);
        for (const write of writes) {
          expect(verdictFor(write)).toBeDefined();
        }
        expect(verdictFor(seed)?.ok).toBe(true);
        expect(verdictFor(writes[writes.length - 1])?.ok).toBe(true);
        for (const [index, write] of writes.entries()) {
          if (verdictFor(write)?.ok !== false) continue;
          expect(
            writes.slice(index + 1).some((later) =>
              verdictFor(later)?.ok === true
            ),
          ).toBe(true);
        }
        expect(
          writes.some((write) =>
            carriesFullAggregate(write) && verdictFor(write)?.ok === true
          ),
        ).toBe(true);

        // Quiescence without background retry churn: further reactive rounds
        // and a long stretch of logical time produce no new commits.
        const commitsAtConvergence = log.events.filter((event) =>
          event.t === "commit"
        ).length;
        for (let k = 0; k < 5; k++) {
          await rc2.pull();
          await rt2.idle();
        }
        const churnClock = fakeClock();
        if (churnClock !== undefined) {
          await churnClock.tick(60_000);
          await rt2.idle();
        }
        await sm2.synced();
        expect(log.events.filter((event) => event.t === "commit").length).toBe(
          commitsAtConvergence,
        );

        // The recovered aggregate, locally and in durable server state. The
        // container document now exists and holds the element links, and a
        // FRESH runtime — which can see only durable state, none of the
        // resume's local optimistic values — materializes the same aggregate.
        expect(read(rc2)).toEqual(expected);
        const after = await durableSnapshots(server, [
          { id: created.containerId },
        ]);
        const containerDoc =
          after.get(durableStateKey(created.containerId, "space")) ?? null;
        expect(containerDoc).not.toBe(null);
        const containerJson = JSON.stringify(containerDoc);
        for (const id of elementLinkIds) {
          expect(containerJson).toContain(id);
        }
        const sm3 = RewritingStorageManager.make(signer, server);
        try {
          const rt3 = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: sm3,
          });
          try {
            const tx3 = rt3.edit();
            const rc3 = rt3.getCell(
              space,
              resultKey,
              created.compiled.resultSchema,
              tx3,
            );
            await tx3.commit();
            for (let k = 0; k < 10; k++) {
              await rc3.pull();
              await rt3.idle();
            }
            expect(read(rc3)).toEqual(expected);
          } finally {
            await rt3.dispose();
          }
        } finally {
          await sm3.close();
        }
      } finally {
        await rt2.dispose({ closeStorage: false });
      }
    } finally {
      await rt1.dispose({ closeStorage: false });
    }
  }

  it("recovers a filter result whose container is missing on resume", async () => {
    await runResumeWithMissingContainer(
      FILTER_PROGRAM,
      FILTER_ITEMS,
      "cd-filter",
      "kept",
      (rc) =>
        (rc.key("kept").getAsQueryResult() ?? []).map(
          (x: { label: string }) => x.label,
        ),
      ["a", "b", "d"],
    );
  });

  it("recovers a flatMap result whose container is missing on resume", async () => {
    await runResumeWithMissingContainer(
      FLATMAP_PROGRAM,
      FLATMAP_ITEMS,
      "cd-flatmap",
      "values",
      (rc) => rc.key("values").getAsQueryResult() ?? [],
      [1, 3, 4],
    );
  });

  it("recovers a map result whose container is missing on resume", async () => {
    await runResumeWithMissingContainer(
      MAP_PROGRAM,
      MAP_ITEMS,
      "cd-map",
      "doubled",
      (rc) => rc.key("doubled").getAsQueryResult() ?? [],
      [2, 4, 6],
    );
  });

  it("filter resume confirms absence, seeds, then rebuilds durably", async () => {
    await runResumeSequence(
      FILTER_PROGRAM,
      FILTER_ITEMS,
      "cd-filter",
      "kept",
      (rc) =>
        (rc.key("kept").getAsQueryResult() ?? []).map(
          (x: { label: string }) => x.label,
        ),
      ["a", "b", "d"],
    );
  });

  it("flatMap resume confirms absence, seeds, then rebuilds durably", async () => {
    await runResumeSequence(
      FLATMAP_PROGRAM,
      FLATMAP_ITEMS,
      "cd-flatmap",
      "values",
      (rc) => rc.key("values").getAsQueryResult() ?? [],
      [1, 3, 4],
    );
  });

  it("map resume confirms absence, seeds, then rebuilds durably", async () => {
    await runResumeSequence(
      MAP_PROGRAM,
      MAP_ITEMS,
      "cd-map",
      "doubled",
      (rc) => rc.key("doubled").getAsQueryResult() ?? [],
      [2, 4, 6],
    );
  });
});
