/**
 * Rehearses one compiled Home graph against the SDK's shared transition core.
 * The compiler receives the actual portable data module as a relative source
 * dependency. Explicit references stand in for a future Home bootstrap.
 * The authored adapter assumes validated input and catalog data. Negative
 * probes below demonstrate why it is not a production writer yet.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  ACLManager,
  type Cell,
  Runtime,
  sendEvent,
} from "@commonfabric/runner";
import {
  type SharedSpaceCatalog,
  type SharedSpaceMembershipChange,
  type SharedSpaceRegistration,
} from "@commonfabric/runner/shared-space-catalog-contract";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import type { WaveCommitSink } from "../../runner/src/executor/wave.ts";
import { ExecutorHost } from "../../runner/src/executor/host.ts";
import { ArrivalLog } from "../../runner/test/support/serving-waits.ts";
import {
  changeSharedSpaceMembership,
  getSharedSpaceCatalog,
  registerSharedSpace,
  sharedSpaceCatalogCell,
} from "../src/shared-space-catalog.ts";

const owner = await Identity.fromPassphrase("catalog rehearsal owner");
const service = await Identity.fromPassphrase("catalog rehearsal service");
const home = { principal: owner.did(), host: "https://home.example" };
const registration: SharedSpaceRegistration = {
  space: "did:key:rehearsal-room",
  host: "https://room.example",
  kind: "fabrichat-room",
  offer: { from: owner.did(), id: "offer-one" },
};

/** A synthetic command, after offer validation by the application. */
type Command =
  | { operation: "register"; input: SharedSpaceRegistration }
  | { operation: "membership"; input: SharedSpaceMembershipChange };

const dataSource = (await Deno.readTextFile(
  new URL(
    "../../runner/src/shared-space-catalog-data.ts",
    import.meta.url,
  ),
)).replaceAll('"@commonfabric/api/schema"', '"commonfabric/schema"')
  .replaceAll('"@commonfabric/api"', '"commonfabric"')
  .replaceAll('"@commonfabric/identity/did"', '"commonfabric"');

const source = `
import { currentPrincipal, eventKey, handler, pattern, Writable } from "commonfabric";
import { registerCatalogEntry, changeCatalogMembership,
  type SharedSpaceCatalog, type SharedSpaceRegistration,
  type SharedSpaceMembershipChange, type CatalogWritePath } from "./catalog-data.ts";
type Command = { operation: "register"; input: SharedSpaceRegistration }
  | { operation: "membership"; input: SharedSpaceMembershipChange };
type Context = { catalog: Writable<SharedSpaceCatalog | undefined>;
  principal: string;
  outcome: Writable<{ status: string; reason?: string; observedState?: string; observedRevision?: string }> };
const apply = handler<Command, Context>((event, { catalog, principal, outcome }) => {
  if (currentPrincipal() !== principal) throw new Error("Catalog actor differs from Home owner.");
  const stored = catalog.get();
  const next: SharedSpaceCatalog = stored === undefined ? { entries: {}, offers: {} }
    : { ...stored, entries: { ...stored.entries }, offers: { ...stored.offers } };
  let initialized = stored !== undefined;
  const write = (path: CatalogWritePath, value: unknown) => {
    if (!initialized) { catalog.set({ entries: {}, offers: {} }); initialized = true; }
    catalog.key(...path).set(value);
  };
  const result = event.operation === "register"
    ? registerCatalogEntry(next, event.input, eventKey(), event.input.since ?? Date.now(), write)
    : changeCatalogMembership(next, event.input, eventKey(), write);
  // Capture primitive evidence: an entry from a typed read can be a live link.
  outcome.set(result.status === "conflict"
    ? { status: result.status, reason: result.reason }
    : { status: result.status, observedState: result.entry.state,
        observedRevision: result.entry.revision });
});
export default pattern<Context>(({ catalog, principal, outcome }) => ({
  command: apply({ catalog, principal, outcome }), catalog, outcome,
}));
`;

/** Runs independent client replicas with an optional real serving executor. */
async function rehearse(
  serverExecution: boolean,
  body: (
    runtime: Runtime,
    fresh: () => Runtime,
    start: () => void,
  ) => Promise<void>,
  decorateWaveCommitSink?: (sink: WaveCommitSink) => WaveCommitSink,
  cleanup?: () => void,
) {
  const server = new Server({
    acl: { mode: "enforce", delegatingDids: [service.did()] },
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: "did:key:catalog-rehearsal-memory" },
    subscriptionRefreshDelayMs: 0,
  });
  const clients: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];
  let host: ExecutorHost | undefined;
  const fresh = () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL(home.host),
      storageManager: storage,
      experimental: { serverExecution },
    });
    clients.push({ runtime, storage });
    return runtime;
  };
  try {
    const runtime = fresh();
    const acl = new ACLManager(runtime, owner.did());
    await acl.set(owner.did(), "OWNER");
    const start = () => {
      if (!serverExecution || host) return;
      host = new ExecutorHost({
        server,
        decorateWaveCommitSink,
        serviceIdentity: service.did(),
        createRuntime: (space) => {
          const storage = EmulatedStorageManager.connectTo(server, {
            as: service,
            servingHomeSpace: space,
          });
          const runtime = new Runtime({
            apiUrl: new URL(home.host),
            storageManager: storage,
            servingPosture: true,
            experimental: { serverExecution: true },
          });
          return Promise.resolve({
            runtime,
            dispose: async () => {
              await runtime.dispose();
              await storage.close();
            },
          });
        },
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      });
    };
    await body(runtime, fresh, start);
  } finally {
    cleanup?.();
    await host?.close();
    await server.flushSessions();
    for (const { runtime, storage } of clients) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  }
}

/** Creates a new graph root while retaining the independently addressed catalog. */
async function standUp(runtime: Runtime, root: string) {
  const compiled = await runtime.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: source }, {
      name: "/catalog-data.ts",
      contents: dataSource,
    }],
  }, { space: owner.did() });
  const outcome = runtime.getCell<unknown>(
    owner.did(),
    `${root}-outcome`,
    true,
  );
  const catalog = sharedSpaceCatalogCell(runtime, home);
  await catalog.sync();
  const result = runtime.getCell<{ command: Command }>(
    owner.did(),
    root,
    compiled.resultSchema,
  );
  const spaceCell = runtime.getSpaceCell(owner.did());
  await spaceCell.sync();
  const tx = runtime.edit();
  spaceCell.withTx(tx).key("defaultPattern").set(result);
  outcome.withTx(tx).set({ status: "pending" });
  runtime.run(
    tx,
    compiled,
    { catalog, principal: home.principal, outcome },
    result,
  );
  expect((await tx.commit()).error).toBeUndefined();
  result.sink(() => {});
  await runtime.idle();
  await runtime.patternManager.flushCompileCacheWrites();
  return { command: result.key("command"), outcome };
}

/** Waits for durable handling, rather than the speculative outcome cell. */
async function fire(command: Cell<Command>, event: Command) {
  const acks = new ArrivalLog<string>();
  sendEvent(command, event, (tx) => acks.record(tx.status().status));
  await acks.reached(1);
  expect(acks.entries[0]).not.toBe("error");
}

describe("shared-space catalog pattern rehearsal", () => {
  for (const serverExecution of [false, true]) {
    it(`exposes the schema-only adapter's missing route validation with serving ${serverExecution}`, async () => {
      await rehearse(serverExecution, async (runtime, fresh, start) => {
        const invalid = { ...registration, host: "https://room.example/path" };
        await expect(registerSharedSpace(runtime, home, invalid)).rejects
          .toThrow();
        const graph = await standUp(runtime, "validation-probe-home");
        start();
        await fire(graph.command, { operation: "register", input: invalid });
        const peer = fresh();
        await expect(getSharedSpaceCatalog(peer, home)).rejects.toThrow(
          "malformed",
        );
        expect(sharedSpaceCatalogCell(peer, home).getRaw()).toMatchObject({
          entries: { [registration.space]: { host: invalid.host } },
        });
      });
    });

    it(`exposes a malformed optional field hidden by the pattern schema with serving ${serverExecution}`, async () => {
      await rehearse(serverExecution, async (runtime, fresh, start) => {
        const registered = await registerSharedSpace(
          runtime,
          home,
          registration,
        );
        if (registered.status === "conflict") {
          throw new Error("Registration failed.");
        }
        const graph = await standUp(runtime, "malformed-probe-home");
        const tx = runtime.edit();
        sharedSpaceCatalogCell(runtime, home).withTx(tx).key(
          "entries",
          registration.space,
          "since",
        ).set("future-incompatible-type");
        expect((await tx.commit()).error).toBeUndefined();
        await expect(getSharedSpaceCatalog(fresh(), home)).rejects.toThrow(
          "malformed",
        );
        start();
        await fire(graph.command, {
          operation: "membership",
          input: {
            space: registration.space,
            expectedRevision: registered.entry.revision,
            id: "schema-only-action",
            state: "archived",
          },
        });
        const peer = fresh();
        await expect(getSharedSpaceCatalog(peer, home)).rejects.toThrow(
          "malformed",
        );
        expect(sharedSpaceCatalogCell(peer, home).getRaw()).toMatchObject({
          entries: {
            [registration.space]: {
              state: "archived",
              since: "future-incompatible-type",
            },
          },
        });
      });
    });

    it(`preserves extension fields through pattern registration and membership with serving ${serverExecution}`, async () => {
      await rehearse(serverExecution, async (runtime, fresh, start) => {
        await registerSharedSpace(runtime, home, registration);
        const catalog = sharedSpaceCatalogCell(runtime, home);
        const tx = runtime.edit();
        catalog.withTx(tx).key("futureRoot").set({ opaque: [1, "keep"] });
        catalog.withTx(tx).key("entries", registration.space, "futureEntry")
          .set({ nested: true });
        const receiptKey = JSON.stringify([
          registration.offer!.from,
          registration.offer!.id,
        ]);
        catalog.withTx(tx).key("offers", receiptKey, "futureReceipt").set(
          "retain",
        );
        expect((await tx.commit()).error).toBeUndefined();
        const graph = await standUp(runtime, "extensions-home");
        start();
        await fire(graph.command, {
          operation: "register",
          input: {
            ...registration,
            offer: { from: owner.did(), id: "another-offer" },
          },
        });
        const read = await getSharedSpaceCatalog(fresh(), home);
        if (read.status !== "ready") throw new Error("Catalog absent.");
        const action: SharedSpaceMembershipChange = {
          space: registration.space,
          id: "pattern-archive",
          expectedRevision: read.catalog.entries[registration.space].revision,
          state: "archived",
        };
        await fire(graph.command, { operation: "membership", input: action });
        await fire(graph.command, { operation: "membership", input: action });
        const current = await getSharedSpaceCatalog(fresh(), home);
        expect(current).toMatchObject({
          status: "ready",
          catalog: {
            futureRoot: { opaque: [1, "keep"] },
            entries: {
              [registration.space]: {
                state: "archived",
                futureEntry: { nested: true },
              },
            },
            offers: { [receiptKey]: { futureReceipt: "retain" } },
          },
        });
        await runtime.idle();
        expect(graph.outcome.get()).toMatchObject({ status: "confirmed" });
      });
    });

    it(`discovers a dedicated catalog through a stable Home link with serving ${serverExecution}`, async () => {
      await rehearse(serverExecution, async (runtime, fresh, start) => {
        const registered = await registerSharedSpace(
          runtime,
          home,
          registration,
        );
        if (registered.status === "conflict") {
          throw new Error("Registration failed.");
        }
        await standUp(runtime, "original-home");
        const spaceCell = runtime.getSpaceCell(owner.did(), true);
        const tx = runtime.edit();
        spaceCell.withTx(tx).key("sharedSpaceCatalog").set(
          sharedSpaceCatalogCell(runtime, home),
        );
        expect((await tx.commit()).error).toBeUndefined();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/consumer.tsx",
          files: [{
            name: "/consumer.tsx",
            contents: `
            import { pattern, wish } from "commonfabric";
            import type { SharedSpaceCatalog } from "./catalog-data.ts";
            export default pattern(() => ({
              resolved: wish<SharedSpaceCatalog>({ query: "/sharedSpaceCatalog", scope: ["~"] }),
            }));
          `,
          }, { name: "/catalog-data.ts", contents: dataSource }],
        }, { space: owner.did() });
        const result = runtime.getCell<
          { resolved: { result?: SharedSpaceCatalog } }
        >(owner.did(), "consumer", compiled.resultSchema);
        const run = runtime.edit();
        runtime.run(run, compiled, {}, result);
        expect((await run.commit()).error).toBeUndefined();
        result.sink(() => {});
        start();
        await waitForCellValue<{ resolved: { result?: SharedSpaceCatalog } }>(
          runtime,
          result,
          (value) =>
            value?.resolved?.result?.entries[registration.space]?.state ===
              "saved",
          { stuckLabel: "Home catalog discovery" },
        );
        await standUp(fresh(), "replacement-home");
        await changeSharedSpaceMembership(fresh(), home, {
          space: registration.space,
          state: "archived",
          id: "archive-after-replacement",
          expectedRevision: registered.entry.revision,
        });
        await waitForCellValue<{ resolved: { result?: SharedSpaceCatalog } }>(
          runtime,
          result,
          (value) =>
            value?.resolved?.result?.entries[registration.space]?.state ===
              "archived",
          { stuckLabel: "Home catalog update" },
        );
      });
    });
    it(`arbitrates competing pattern and SDK membership actions with serving ${serverExecution}`, async () => {
      await rehearse(serverExecution, async (runtime, fresh, start) => {
        const initial = await registerSharedSpace(fresh(), home, registration);
        if (initial.status === "conflict") {
          throw new Error("Registration failed.");
        }
        const graph = await standUp(runtime, "competing-home");
        start();
        const archive: SharedSpaceMembershipChange = {
          space: registration.space,
          expectedRevision: initial.entry.revision,
          state: "archived",
          id: "pattern-archive",
        };
        const [, sdk] = await Promise.all([
          fire(graph.command, { operation: "membership", input: archive }),
          changeSharedSpaceMembership(fresh(), home, {
            ...archive,
            state: "saved",
            id: "sdk-save",
          }),
        ]);
        await runtime.idle();
        await graph.outcome.sync();
        const pattern = graph.outcome.get();
        if (sdk.status === "applied") {
          expect(pattern).toMatchObject({
            status: "conflict",
            reason: "revision",
          });
        } else {
          expect(sdk).toMatchObject({ status: "conflict", reason: "revision" });
          expect(pattern).toMatchObject({ status: "applied" });
        }
        const winner = await getSharedSpaceCatalog(fresh(), home);
        await fire(graph.command, { operation: "membership", input: archive });
        expect(await getSharedSpaceCatalog(fresh(), home)).toEqual(winner);
      });
    });

    it(`retains SDK archive across pattern replay and root recreation with serving ${serverExecution}`, async () => {
      await rehearse(serverExecution, async (runtime, fresh, start) => {
        const graph = await standUp(runtime, "first-home-root");
        start();
        await fire(graph.command, {
          operation: "register",
          input: registration,
        });
        const first = await getSharedSpaceCatalog(fresh(), home);
        if (first.status !== "ready") throw new Error("Catalog is absent.");
        const entry = first.catalog.entries[registration.space];
        expect(entry.state).toBe("saved");
        expect(entry.from).toBe(registration.offer!.from);
        expect(entry.since).toEqual(expect.any(Number));
        expect(
          await changeSharedSpaceMembership(fresh(), home, {
            space: registration.space,
            state: "archived",
            expectedRevision: entry.revision,
            id: "explicit-archive",
          }),
        ).toMatchObject({ status: "applied" });
        const replacement = await standUp(fresh(), "replacement-home-root");
        await fire(replacement.command, {
          operation: "register",
          input: {
            ...registration,
            offer: { from: owner.did(), id: "replay" },
          },
        });
        const read = await getSharedSpaceCatalog(fresh(), home);
        expect(read).toMatchObject({
          status: "ready",
          catalog: {
            entries: {
              [registration.space]: {
                state: "archived",
                from: entry.from,
                since: entry.since,
              },
            },
            offers: {
              [JSON.stringify([owner.did(), "offer-one"])]: {
                space: registration.space,
              },
              [JSON.stringify([owner.did(), "replay"])]: {
                space: registration.space,
              },
            },
          },
        });
        expect(await registerSharedSpace(fresh(), home, registration))
          .toMatchObject({ status: "existing", entry: { state: "archived" } });
      });
    });
  }

  for (const reject of [false, true]) {
    it(`waits for the authoritative consequence when a catalog commit is ${reject ? "rejected" : "held"}`, async () => {
      const held = new ArrivalLog<void>();
      const release = defer<void>();
      const retryRelease = defer<void>();
      let attempts = 0;
      try {
        await rehearse(true, async (runtime, fresh, start) => {
          const graph = await standUp(runtime, "held-home");
          start();
          const acks = new ArrivalLog<string>();
          const appends = new ArrivalLog<boolean>();
          sendEvent(
            graph.command,
            { operation: "register", input: registration },
            (tx) => acks.record(tx.status().status),
            { onAppended: (delivery) => appends.record(delivery.delivered) },
          );
          await held.reached(1);
          await appends.reached(1);
          expect(appends.entries).toEqual([true]);
          expect(acks.entries).toEqual([]);
          expect(await getSharedSpaceCatalog(fresh(), home)).toEqual({
            status: "absent",
          });
          release.resolve();
          if (reject) {
            await held.reached(2);
            expect(acks.entries).toEqual([]);
            expect(await getSharedSpaceCatalog(fresh(), home)).toEqual({
              status: "absent",
            });
            retryRelease.resolve();
          }
          await acks.reached(1);
          expect(acks.entries[0]).not.toBe("error");
          expect((await getSharedSpaceCatalog(fresh(), home)).status).toBe(
            "ready",
          );
        }, (sink) => ({
          ...sink,
          currentHeads: sink.currentHeads.bind(sink),
          concurrentWritePaths: sink.concurrentWritePaths.bind(sink),
          commitWave: async (batch) => {
            if (batch.consequenceOf.length > 0 && attempts < (reject ? 2 : 1)) {
              attempts += 1;
              held.record();
              if (attempts === 1) {
                await release.promise;
                if (reject) {
                  return {
                    error: {
                      name: "WaveCommitRejected",
                      message: "rehearsal refusal",
                    },
                  };
                }
              } else await retryRelease.promise;
            }
            return await sink.commitWave(batch);
          },
        }), () => {
          release.resolve();
          retryRelease.resolve();
        });
      } finally {
        release.resolve();
        retryRelease.resolve();
      }
    });
  }

  it("exposes a stale no-op stream observation without an explicit catalog precondition", async () => {
    const held = new ArrivalLog<void>();
    const release = defer<void>();
    let armed = true;
    try {
      await rehearse(true, async (runtime, fresh, start) => {
        const first = await registerSharedSpace(fresh(), home, registration);
        if (first.status === "conflict") {
          throw new Error("Registration failed.");
        }
        const graph = await standUp(runtime, "no-op-home");
        start();
        const acks = new ArrivalLog<string>();
        sendEvent(
          graph.command,
          { operation: "register", input: registration },
          (tx) => acks.record(tx.status().status),
        );
        await held.reached(1);
        expect(acks.entries).toEqual([]);
        const archived = await changeSharedSpaceMembership(fresh(), home, {
          space: registration.space,
          state: "archived",
          expectedRevision: first.entry.revision,
          id: "peer-archive",
        });
        if (archived.status !== "applied") throw new Error("Archive failed.");
        release.resolve();
        await acks.reached(1);
        expect(acks.entries[0]).not.toBe("error");
        await runtime.idle();
        await graph.outcome.sync();
        expect(graph.outcome.get()).toMatchObject({
          status: "existing",
          observedState: "saved",
          observedRevision: first.entry.revision,
        });
        // The unmodified catalog is not a wave write destination. Its peer
        // change therefore needs a separate precondition before this adapter
        // can promise the SDK's no-op confirmation contract.
        expect(await getSharedSpaceCatalog(fresh(), home)).toMatchObject({
          status: "ready",
          catalog: {
            entries: {
              [registration.space]: {
                state: "archived",
                revision: archived.entry.revision,
              },
            },
          },
        });
      }, (sink) => ({
        currentHeads: sink.currentHeads.bind(sink),
        concurrentWritePaths: sink.concurrentWritePaths.bind(sink),
        commitWave: async (batch) => {
          if (armed && batch.consequenceOf.length > 0) {
            armed = false;
            held.record();
            await release.promise;
          }
          return await sink.commitWave(batch);
        },
      }), () => release.resolve());
    } finally {
      release.resolve();
    }
  });
});
