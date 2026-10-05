import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  ACLManager,
  type Cell,
  getDerivedInternalCellLink,
  getPatternIdentityRef,
  type IExtendedStorageTransaction,
  Runtime,
  sendEvent,
} from "@commonfabric/runner";
import {
  ExecutorHost,
  type ExecutorHostOptions,
} from "@commonfabric/runner/executor/host";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { interceptTransaction } from "../../runner/test/support/intercept-transaction.ts";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitEdges,
} from "../../runner/test/support/serving-waits.ts";

import type {
  SharedSpaceCatalog,
  SharedSpaceMembershipChange,
  SharedSpaceRegistration,
} from "../system/shared-space-catalog.ts";

const owner = await Identity.fromPassphrase("Home catalog owner");
const service = await Identity.fromPassphrase("Home catalog service");
const registration: SharedSpaceRegistration = {
  space: "did:key:catalog-room",
  host: "https://room.example",
  kind: "loom",
  offer: { from: "did:key:catalog-sender", id: "first" },
  since: 1000,
};

interface HomeSurface {
  sharedSpaceCatalog: SharedSpaceCatalog;
  registerSharedSpace: SharedSpaceRegistration;
  changeSharedSpaceMembership: SharedSpaceMembershipChange;
  addSpace: { did: string; name: string };
  spaces: { did: string; name: string }[];
}

/** Compiles Home and its production imports as authored source. */
async function compileHome(runtime: Runtime, revision?: string) {
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    {
      main: new URL("../system/home.tsx", import.meta.url).pathname,
      root: new URL("..", import.meta.url).pathname,
    },
  );
  if (revision !== undefined) {
    for (const file of program.files) {
      if (file.name === program.main) {
        file.contents += `\n// Source revision ${revision}\n`;
      }
    }
  }
  return await runtime.patternManager.compilePattern(program, {
    space: owner.did(),
  });
}

/** Opens the stored Home root, retaining its constructor-owned cells. */
async function openHome(runtime: Runtime, create: boolean) {
  const compiled = await compileHome(runtime);
  const result = runtime.getCell<HomeSurface>(
    owner.did(),
    "catalog-home",
    compiled.resultSchema,
  );
  if (create) {
    const root = runtime.getSpaceCell(owner.did());
    await root.sync();
    const tx = runtime.edit();
    root.withTx(tx).key("defaultPattern").set(result);
    runtime.run(tx, compiled, {}, result);
    expect((await tx.commit()).error).toBeUndefined();
  } else {
    await result.sync();
    expect(await runtime.start(result)).toBe(true);
  }
  return result;
}

/** Reads the actual owned storage selected by Home's named manifest entry. */
async function backingCatalog(runtime: Runtime, home: Cell<HomeSurface>) {
  const manifest = home.getMetaRaw("internal") as {
    partialCause: string;
    kind?: "computed";
  }[];
  const descriptor = manifest.find((entry) =>
    entry.partialCause === "sharedSpaceCatalog"
  );
  expect(descriptor).toBeDefined();
  expect(descriptor!.kind).toBeUndefined();
  const cell = runtime.getCellFromLink(
    getDerivedInternalCellLink(home, descriptor!),
  )
    .asSchema<Record<string, any>>({
      type: "object",
      additionalProperties: true,
    });
  await cell.sync();
  expect(cell.getRaw()).toMatchObject({ entries: {}, offers: {} });
  return cell;
}

/** Awaits this handling's own settlement and reads its ordinary receipt. */
async function invoke<T>(
  runtime: Runtime,
  stream: Cell<T>,
  event: unknown,
  id: string,
  onCommit?: () => void,
) {
  const tx = await new Promise<IExtendedStorageTransaction>((resolve) => {
    sendEvent(stream, event as T, (tx) => {
      onCommit?.();
      resolve(tx);
    }, {
      eventId: id,
      session: "catalog-test",
    });
  });
  const status = tx.status();
  if (
    status.status === "error" &&
    !("precondition" in status.error &&
      status.error.precondition === "receipt-exists")
  ) {
    throw "reason" in status.error && status.error.reason !== undefined
      ? status.error.reason
      : status.error;
  }
  expect(tx.handlingReceiptLink).toBeDefined();
  const receipt = runtime.getCellFromLink(tx.handlingReceiptLink!);
  return await receipt.pull();
}

/** Observes a failed handler's generic terminal result without a value receipt. */
async function rejectInvocation<T>(
  runtime: Runtime,
  stream: Cell<T>,
  event: unknown,
  server: Server,
  serving: boolean,
  message = "",
) {
  if (!serving) {
    await expect(invoke(runtime, stream, event, crypto.randomUUID())).rejects
      .toMatchObject({ message: expect.stringContaining(message) });
    return;
  }
  const engine = await server.engineForSpace(owner.did());
  const sidecarId = streamEntriesDocId(
    stream.resolveAsCell().getAsNormalizedFullLink(),
  );
  const entries = () =>
    (Engine.read(engine, { id: sidecarId })?.value as
      | StreamEventsDocValue
      | undefined)?.entries ?? [];
  const index = entries().length;
  sendEvent(stream, event as T);
  await awaitAdmitted(server, () => {
    const entry = entries()[index];
    return entry?.consequenced === true && typeof entry.error === "string";
  });
  expect(entries()[index].error).toContain(message);
}

/** Records tentative handler receipts and commit verdicts without extra writes. */
function watchHandlingCommits(runtime: Runtime) {
  const outcomes = new ArrivalLog<{ eventId: string; value: unknown }>();
  const verdicts = new ArrivalLog<
    Awaited<ReturnType<IExtendedStorageTransaction["commit"]>>
  >();
  const edit = runtime.edit.bind(runtime);
  const wrapped = stub(runtime, "edit", (...args) => {
    const tx = interceptTransaction(edit(...args), (method, _args, proceed) => {
      if (
        method !== "commit" || !tx.dispatchedEventId || !tx.handlingReceiptLink
      ) {
        return proceed();
      }
      outcomes.record({
        eventId: tx.dispatchedEventId,
        value: runtime.getCellFromLink(tx.handlingReceiptLink).withTx(tx)
          .getRaw(),
      });
      return (proceed() as ReturnType<IExtendedStorageTransaction["commit"]>)
        .then((result) => {
          verdicts.record(result);
          return result;
        });
    });
    return tx;
  });
  return { outcomes, verdicts, [Symbol.dispose]: () => wrapped.restore() };
}

/** Independent replicas against an ACL-enforcing memory server. */
async function withHome(
  serverExecution: boolean,
  body: (
    runtime: Runtime,
    home: Cell<HomeSurface>,
    peer: (
      serverExecution?: boolean,
    ) => Promise<{ runtime: Runtime; home: Cell<HomeSurface> }>,
    server: Server,
  ) => Promise<void>,
  decorateWaveCommitSink?: ExecutorHostOptions["decorateWaveCommitSink"],
) {
  const server = new Server({
    acl: { mode: "enforce", delegatingDids: [service.did()] },
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: "did:key:home-catalog-memory" },
    subscriptionRefreshDelayMs: 0,
  });
  const clients: {
    runtime: Runtime;
    storage: EmulatedStorageManager;
    cancel?: () => void;
  }[] = [];
  let executor: ExecutorHost | undefined;
  const fresh = (executeOnServer = serverExecution) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental: { serverExecution: executeOnServer },
    });
    const client = {
      runtime,
      storage,
      cancel: undefined as undefined | (() => void),
    };
    clients.push(client);
    return client;
  };
  try {
    const first = fresh();
    await new ACLManager(first.runtime, owner.did()).set(owner.did(), "OWNER");
    const home = await openHome(first.runtime, true);
    first.cancel = home.key("sharedSpaceCatalog").sink(() => {});
    await first.runtime.idle();
    if (serverExecution) {
      executor = new ExecutorHost({
        server,
        decorateWaveCommitSink,
        serviceIdentity: service.did(),
        createRuntime: (space) => {
          const storage = EmulatedStorageManager.connectTo(server, {
            as: service,
            servingHomeSpace: space,
          });
          const runtime = new Runtime({
            apiUrl: new URL("https://home.example"),
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
        policy: { flushDeadlineMs: 5000, idleParkMs: 600000 },
      });
    }
    await body(first.runtime, home, async (executeOnServer) => {
      const client = fresh(executeOnServer);
      const home = await openHome(client.runtime, false);
      client.cancel = home.key("sharedSpaceCatalog").sink(() => {});
      await client.runtime.idle();
      return { runtime: client.runtime, home };
    }, server);
  } finally {
    await executor?.close();
    await server.flushSessions();
    for (const { runtime, storage, cancel } of clients) {
      cancel?.();
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  }
}

describe("Home catalog revisions across execution modes", () => {
  it("keeps an old revision stale when an invocation ID is admitted again", async () => {
    await withHome(true, async (runtime, home, fresh) => {
      const client = await fresh(false);
      const catalog = client.home.key("sharedSpaceCatalog");
      const membership = client.home.key("changeSharedSpaceMembership");
      await invoke(
        client.runtime,
        client.home.key("registerSharedSpace"),
        registration,
        "register",
      );
      const registered = (await catalog.pull()).entries[registration.space]
        .revision;
      const archive = {
        space: registration.space,
        id: "old-archive",
        state: "archived",
        expectedRevision: registered,
      };
      expect(
        await invoke(client.runtime, membership, archive, "reused-event"),
      ).toEqual({
        status: "applied",
        space: registration.space,
        id: archive.id,
      });
      const oldRevision = (await catalog.pull()).entries[registration.space]
        .revision;
      const restore = {
        space: registration.space,
        id: "restore",
        state: "saved",
        expectedRevision: oldRevision,
      };
      await invoke(client.runtime, membership, restore, "restore-event");
      const restored = (await catalog.pull()).entries[registration.space]
        .revision;
      expect(restored).not.toBe(oldRevision);

      // Serving execution can admit an ID first handled on a client. Its
      // receipt stays first-writer-wins, but the handler's writes still commit.
      const servedMembership = home.key("changeSharedSpaceMembership");
      expect(
        await invoke(runtime, servedMembership, {
          ...archive,
          id: "new-archive",
          expectedRevision: restored,
        }, "reused-event"),
      ).toEqual({
        status: "applied",
        space: registration.space,
        id: archive.id,
      });
      const archived = (await home.key("sharedSpaceCatalog").pull())
        .entries[registration.space];
      expect(archived.state).toBe("archived");
      expect(archived.revision).not.toBe(oldRevision);
      expect(archived.revision).not.toBe(restored);
      expect(archived.revision.length).toBeLessThanOrEqual(320);
      expect(
        await invoke(runtime, servedMembership, {
          ...restore,
          id: "stale-choice",
        }, "stale-choice-event"),
      ).toEqual({ status: "conflict", reason: "revision" });
      expect(
        (await home.key("sharedSpaceCatalog").pull())
          .entries[registration.space].state,
      ).toBe("archived");
    });
  });
});

describe("Home shared-space catalog", () => {
  for (
    const scenario of ["existing", "rejected-predecessor", "first-registration"]
  ) {
    it(`settles ${scenario} against withheld peer writes with client execution`, async () => {
      await withHome(false, async (runtime, home, fresh, server) => {
        if (scenario !== "first-registration") {
          await invoke(
            runtime,
            home.key("registerSharedSpace"),
            registration,
            "seed",
          );
        }
        const catalog = await backingCatalog(runtime, home);
        const before = await home.key("sharedSpaceCatalog").pull();
        const originalRevision = before.entries[registration.space]?.revision;
        const peer = await fresh();
        const peerCatalog = await backingCatalog(peer.runtime, peer.home);
        server.options.subscriptionRefreshDelayMs = "manual";
        const tx = peer.runtime.edit();
        const target = peerCatalog.withTx(tx);
        if (scenario === "first-registration") {
          target.key("entries", "did:key:peer-room").set({
            space: "did:key:peer-room",
            host: registration.host,
            kind: "fabrichat-room",
            state: "saved",
            revision: "peer-revision",
          });
          target.key("offers", JSON.stringify([owner.did(), "peer-offer"])).set(
            {
              from: owner.did(),
              id: "peer-offer",
              space: "did:key:peer-room",
              host: registration.host,
              kind: "fabrichat-room",
            },
          );
        } else {
          const state = scenario === "existing" ? "archived" : "saved";
          target.key("entries", registration.space, "state").set(state);
          target.key("entries", registration.space, "revision").set(
            "peer-revision",
          );
          target.key("entries", registration.space, "lastAction").set({
            id: "peer-choice",
            expectedRevision: originalRevision,
            state,
          });
        }
        expect((await tx.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        expect(catalog.getRaw()).toEqual(before);
        using watch = watchHandlingCommits(runtime);
        const completed = new ArrivalLog<unknown>();
        const invokeAndRecord = (id: string) => {
          const pending = scenario === "rejected-predecessor"
            ? invoke(runtime, home.key("changeSharedSpaceMembership"), {
              space: registration.space,
              id: "my-archive",
              state: "archived",
              expectedRevision: originalRevision,
            }, id)
            : invoke(
              runtime,
              home.key("registerSharedSpace"),
              registration,
              id,
            );
          return pending.then((result) => {
            completed.record(result);
            return result;
          });
        };
        const first = invokeAndRecord("first-attempt");
        const second = scenario === "rejected-predecessor"
          ? invokeAndRecord("second-attempt")
          : undefined;
        try {
          await watch.outcomes.reached(second ? 2 : 1);
          if (second) {
            expect(
              watch.outcomes.entries.slice(0, 2).map((entry) => entry.value),
            )
              .toEqual([
                {
                  status: "applied",
                  space: registration.space,
                  id: "my-archive",
                },
                {
                  status: "confirmed",
                  space: registration.space,
                  id: "my-archive",
                },
              ]);
          }
          await watch.verdicts.matching((verdict) =>
            verdict.error !== undefined
          );
          expect(completed.entries).toHaveLength(0);
          server.options.subscriptionRefreshDelayMs = 0;
          await server.flushSessions();
          if (second) {
            expect(await Promise.all([first, second])).toEqual([
              { status: "conflict", reason: "revision" },
              { status: "conflict", reason: "revision" },
            ]);
          } else {
            expect(await first).toEqual({
              status: scenario === "existing" ? "existing" : "registered",
              space: registration.space,
            });
          }
          const final = await home.key("sharedSpaceCatalog").pull();
          if (scenario === "first-registration") {
            expect(Object.keys(final.entries).sort()).toEqual(
              [registration.space, "did:key:peer-room"].sort(),
            );
            expect(Object.keys(final.offers)).toHaveLength(2);
          } else {
            expect(final.entries[registration.space]).toMatchObject({
              state: scenario === "existing" ? "archived" : "saved",
              revision: "peer-revision",
            });
            expect(
              catalog.key("entries", registration.space, "lastAction").getRaw(),
            ).toEqual({
              id: "peer-choice",
              expectedRevision: originalRevision,
              state: scenario === "existing" ? "archived" : "saved",
            });
          }
        } finally {
          server.options.subscriptionRefreshDelayMs = 0;
          await server.flushSessions();
          await Promise.allSettled([first, second]);
        }
      });
    });
  }

  it("confirms a held serving registration only after its wave commits", async () => {
    const held = new ArrivalLog<void>();
    const release = defer<void>();
    let armed = false;
    await withHome(true, async (runtime, home, fresh) => {
      const peer = await fresh();
      const catalog = await backingCatalog(peer.runtime, peer.home);
      const completed = new ArrivalLog<unknown>();
      const committed = new ArrivalLog<void>();
      armed = true;
      const pending = invoke(
        runtime,
        home.key("registerSharedSpace"),
        registration,
        "held",
        () => committed.record(),
      )
        .then((result) => {
          completed.record(result);
          return result;
        });
      try {
        await held.reached(1);
        expect(committed.entries).toHaveLength(0);
        expect(completed.entries).toHaveLength(0);
        const tx = peer.runtime.edit();
        catalog.withTx(tx).key("entries", "did:key:peer-room").set({
          space: "did:key:peer-room",
          host: registration.host,
          kind: "fabrichat-room",
          state: "saved",
          revision: "peer-revision",
        });
        catalog.withTx(tx).key(
          "offers",
          JSON.stringify([owner.did(), "peer-offer"]),
        ).set({
          from: owner.did(),
          id: "peer-offer",
          space: "did:key:peer-room",
          host: registration.host,
          kind: "fabrichat-room",
        });
        expect((await tx.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        expect(committed.entries).toHaveLength(0);
        expect(completed.entries).toHaveLength(0);
        release.resolve();
        expect(await pending).toEqual({
          status: "registered",
          space: registration.space,
        });
        expect(committed.entries).toHaveLength(1);
        const final = await home.key("sharedSpaceCatalog").pull();
        expect(Object.keys(final.entries).sort()).toEqual(
          [registration.space, "did:key:peer-room"].sort(),
        );
        expect(Object.keys(final.offers)).toHaveLength(2);
      } finally {
        release.resolve();
        await pending;
      }
    }, (sink) => ({
      currentHeads: sink.currentHeads.bind(sink),
      concurrentWritePaths: sink.concurrentWritePaths.bind(sink),
      ...(sink.intrusionSince
        ? { intrusionSince: sink.intrusionSince.bind(sink) }
        : {}),
      commitWave: async (batch) => {
        if (armed && batch.consequenceOf.length > 0) {
          armed = false;
          held.record();
          await release.promise;
        }
        return await sink.commitWave(batch);
      },
    }));
  });

  for (const serving of [false, true]) {
    it(`distinguishes an unfinished catalog read from a synchronized empty catalog with serving ${serving}`, async () => {
      await withHome(serving, async (_runtime, home, _fresh, server) => {
        const storage = EmulatedStorageManager.connectTo(server, { as: owner });
        const reader = new Runtime({
          apiUrl: new URL("https://home.example"),
          storageManager: storage,
          experimental: { serverExecution: serving },
        });
        const entered = defer<void>();
        const release = defer<void>();
        const sync = storage.syncCell.bind(storage);
        using _gate = stub(storage, "syncCell", async (cell, ...args) => {
          if (cell.getAsNormalizedFullLink().space === owner.did()) {
            entered.resolve();
            await release.promise;
          }
          return await sync(cell, ...args);
        });
        const catalog = reader.getCellFromLink<HomeSurface>(
          home.getAsNormalizedFullLink(),
        ).key("sharedSpaceCatalog");
        const values = new ArrivalLog<unknown>();
        const settled = new ArrivalLog<unknown>();
        const cancel = catalog.sink((value) => values.record(value));
        const pending = catalog.pull().then((value) => {
          settled.record(value);
          return value;
        });
        try {
          await entered.promise;
          await reader.idle();
          expect(values.entries).toEqual([undefined]);
          expect(settled.entries).toHaveLength(0);
          release.resolve();
          const firstRead = await pending;
          // A serving producer may publish after this replica finishes loading.
          if (firstRead !== undefined) {
            expect(firstRead).toEqual({ entries: {}, offers: {} });
          }
          const ready = await values.matching((value) => value !== undefined);
          expect(ready).toEqual({ entries: {}, offers: {} });
          expect(storage.authorizationError(owner.did())).toBeUndefined();
          expect(storage.spaceAccessError(owner.did())).toBeUndefined();
        } finally {
          release.resolve();
          await pending;
          cancel();
          await reader.idle();
          await storage.synced();
          await reader.dispose();
          await storage.close();
        }
      });
    });

    it(`reports denied Home access separately from an empty collection with serving ${serving}`, async () => {
      await withHome(serving, async (_runtime, home, _fresh, server) => {
        const outsider = await Identity.fromPassphrase(
          "Home catalog denied reader",
        );
        const storage = EmulatedStorageManager.connectTo(server, {
          as: outsider,
        });
        const reader = new Runtime({
          apiUrl: new URL("https://home.example"),
          storageManager: storage,
          experimental: { serverExecution: serving },
        });
        const catalog = reader.getCellFromLink<HomeSurface>(
          home.getAsNormalizedFullLink(),
        ).key("sharedSpaceCatalog");
        const values = new ArrivalLog<unknown>();
        const cancel = catalog.sink((value) => values.record(value));
        try {
          expect(await catalog.pull()).toBeUndefined();
          expect(storage.authorizationError(owner.did())?.name).toBe(
            "AuthorizationError",
          );
          expect(values.entries.length).toBeGreaterThan(0);
          expect(values.entries.every((value) => value === undefined)).toBe(
            true,
          );
        } finally {
          cancel();
          await reader.dispose();
          await storage.close();
        }
      });
    });

    it(`refuses Home replacement without resetting its catalog or navigation with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home) => {
        await invoke(runtime, home.key("registerSharedSpace"), {
          ...registration,
          initialState: "archived",
        }, "seed");
        await invoke(runtime, home.key("addSpace"), {
          did: registration.space,
          name: "Retained navigation",
        }, "navigation");
        const before = await home.key("sharedSpaceCatalog").pull();
        const spaces = await home.key("spaces").pull();
        expect(spaces).toHaveLength(1);
        const catalog = await backingCatalog(runtime, home);
        const stored = catalog.getAsNormalizedFullLink();
        const controller = new PiecesController(
          createSession({ identity: owner, spaceDid: owner.did() }),
          runtime,
        );
        await expect(controller.recreateDefaultPattern()).rejects.toThrow(
          "Cannot replace an existing Home root",
        );
        expect((await controller.getDefaultPattern(false))?.equals(home)).toBe(
          true,
        );
        expect((await backingCatalog(runtime, home)).getAsNormalizedFullLink())
          .toEqual(stored);
        expect(await home.key("sharedSpaceCatalog").pull()).toEqual(before);
        expect(await home.key("spaces").pull()).toEqual(spaces);
        expect(
          await invoke(
            runtime,
            home.key("registerSharedSpace"),
            registration,
            "still-running",
          ),
        )
          .toEqual({ status: "existing", space: registration.space });
      });
    });
    it(`retains constructor state across new Home source and a fresh replica with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home, fresh) => {
        await invoke(runtime, home.key("registerSharedSpace"), {
          ...registration,
          initialState: "archived",
        }, "seed");
        const original = await backingCatalog(runtime, home);
        const originalId = original.getAsNormalizedFullLink().id;
        const before = original.getRaw();
        const previousPattern = getPatternIdentityRef(home);
        const next = await compileHome(runtime, "constructor-retention");
        expect(runtime.patternManager.getArtifactEntryRef(next)?.identity).not
          .toBe(previousPattern?.identity);
        await runtime.runSynced(home, next);
        expect(getPatternIdentityRef(home)?.identity).toBe(
          runtime.patternManager.getArtifactEntryRef(next)?.identity,
        );
        const updated = await backingCatalog(runtime, home);
        expect(updated.getAsNormalizedFullLink().id).toBe(originalId);
        expect(updated.getRaw()).toEqual(before);
        const peer = await fresh();
        const reopened = await backingCatalog(peer.runtime, peer.home);
        expect(reopened.getAsNormalizedFullLink().id).toBe(originalId);
        expect(reopened.getRaw()).toEqual(before);
        expect(
          (await peer.home.key("sharedSpaceCatalog").pull())
            .entries[registration.space].state,
        ).toBe("archived");
      });
    });

    it(`keeps offer identities and explicit choices immutable with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home) => {
        await invoke(runtime, home.key("registerSharedSpace"), {
          ...registration,
          initialState: "archived",
        }, "seed");
        const stored = await backingCatalog(runtime, home);
        const entry = (await home.key("sharedSpaceCatalog").pull())
          .entries[registration.space];
        expect(entry.state).toBe("archived");
        expect(
          await invoke(runtime, home.key("registerSharedSpace"), {
            ...registration,
            host: "https://other.example",
            offer: undefined,
          }, "reroute"),
        ).toEqual({ status: "conflict", reason: "host" });
        expect(
          await invoke(runtime, home.key("registerSharedSpace"), {
            ...registration,
            space: "did:key:other-room",
          }, "retarget"),
        ).toEqual({ status: "conflict", reason: "offer" });
        expect(
          await invoke(runtime, home.key("registerSharedSpace"), {
            ...registration,
            kind: "other",
            offer: undefined,
          }, "retype"),
        ).toEqual({ status: "conflict", reason: "kind" });
        expect(
          await invoke(runtime, home.key("registerSharedSpace"), {
            ...registration,
            offer: { ...registration.offer!, id: "new-offer" },
            title: "Changed",
          }, "another-offer"),
        ).toEqual({ status: "existing", space: registration.space });
        const withOffer = await home.key("sharedSpaceCatalog").pull();
        expect(withOffer.entries[registration.space]).toEqual(entry);
        expect(Object.keys(withOffer.offers)).toHaveLength(2);
        const change = {
          space: registration.space,
          id: "restore",
          expectedRevision: entry.revision,
          state: "saved",
        };
        expect(
          await invoke(
            runtime,
            home.key("changeSharedSpaceMembership"),
            change,
            "restore",
          ),
        ).toMatchObject({ status: "applied" });
        expect(
          await invoke(runtime, home.key("changeSharedSpaceMembership"), {
            ...change,
            state: "archived",
          }, "reuse-action"),
        ).toEqual({ status: "conflict", reason: "action" });
        for (
          const [index, evidence] of ["opaque", {
            id: "foreign",
            state: "future-state",
            expectedRevision: entry.revision,
          }].entries()
        ) {
          await runtime.editWithRetry((tx) =>
            stored.withTx(tx).key("entries", registration.space, "lastAction")
              .set(evidence)
          );
          expect(
            await invoke(runtime, home.key("changeSharedSpaceMembership"), {
              ...change,
              id: "new-choice",
              expectedRevision: (await home.key("sharedSpaceCatalog").pull())
                .entries[registration.space].revision,
            }, `unsupported-action-${index}`),
          ).toEqual({ status: "conflict", reason: "action" });
          expect(
            stored.key("entries", registration.space, "lastAction").getRaw(),
          ).toEqual(evidence);
          expect(stored.key("entries", registration.space, "state").getRaw())
            .toBe("saved");
        }
      });
    });

    it(`rejects malformed optional fields in a linked event payload with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home, _fresh, server) => {
        const payload = runtime.getCell<SharedSpaceRegistration>(
          owner.did(),
          "malformed-event",
          {
            type: "object",
            properties: { since: { type: "number" } },
            additionalProperties: true,
          },
        );
        await runtime.editWithRetry((tx) =>
          payload.withTx(tx).asSchema<unknown>(true).set({
            ...registration,
            since: "bad",
          })
        );
        await rejectInvocation(
          runtime,
          home.key("registerSharedSpace"),
          payload,
          server,
          serving,
          "Invalid shared-space registration.",
        );
        expect(await home.key("sharedSpaceCatalog").pull()).toEqual({
          entries: {},
          offers: {},
        });
      });
    });

    it(`rejects malformed registration values with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home, _peer, server) => {
        for (
          const input of [
            { ...registration, host: "https://room.example/path" },
            { ...registration, host: "https://user:secret@room.example" },
            { ...registration, since: "bad" },
            { ...registration, since: -1 },
            { ...registration, space: "not-a-did" },
            { ...registration, offer: { from: "did:key:sender", id: "" } },
          ]
        ) {
          await rejectInvocation(
            runtime,
            home.key("registerSharedSpace"),
            input,
            server,
            serving,
          );
        }
        expect(await home.key("sharedSpaceCatalog").pull()).toEqual({
          entries: {},
          offers: {},
        });
      });
    });

    it(`refuses malformed stored fields and scalar roots with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home, _fresh, server) => {
        await invoke(
          runtime,
          home.key("registerSharedSpace"),
          registration,
          "seed",
        );
        const catalog = await backingCatalog(runtime, home);
        const valid = catalog.getRaw() as SharedSpaceCatalog;
        const malformed = [
          {
            ...valid,
            entries: {
              ...valid.entries,
              [registration.space]: {
                ...valid.entries[registration.space],
                since: "bad",
              },
            },
          },
          {
            ...valid,
            entries: {
              ...valid.entries,
              [registration.space]: {
                ...valid.entries[registration.space],
                title: 42,
              },
            },
          },
          "not-a-catalog",
        ];
        for (const value of malformed) {
          await runtime.editWithRetry((tx) =>
            catalog.withTx(tx).asSchema<unknown>(true).set(value)
          );
          await rejectInvocation(
            runtime,
            home.key("registerSharedSpace"),
            {
              space: "did:key:new-room",
              host: registration.host,
              kind: registration.kind,
            },
            server,
            serving,
            "The shared-space catalog is unavailable or malformed.",
          );
          expect(catalog.getRaw()).toEqual(value);
        }
        await runtime.editWithRetry((tx) => catalog.withTx(tx).set(valid));
        expect(
          (await home.key("sharedSpaceCatalog").pull())
            .entries[registration.space],
        ).toEqual(valid.entries[registration.space]);
      });
    });

    it(`retains extensions and future states with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home) => {
        await invoke(
          runtime,
          home.key("registerSharedSpace"),
          registration,
          "register",
        );
        const catalog = await backingCatalog(runtime, home);
        const tx = runtime.edit();
        catalog.withTx(tx).key("entries", registration.space, "futureField")
          .set({ nested: [1, 2] });
        catalog.withTx(tx).key("futureField").set({ version: 2 });
        expect((await tx.commit()).error).toBeUndefined();
        const first = await home.key("sharedSpaceCatalog").pull();
        await invoke(runtime, home.key("changeSharedSpaceMembership"), {
          space: registration.space,
          id: "archive",
          state: "archived",
          expectedRevision: first.entries[registration.space].revision,
        }, "archive");
        expect(catalog.getRaw()).toMatchObject({
          futureField: { version: 2 },
          entries: {
            [registration.space]: {
              state: "archived",
              futureField: { nested: [1, 2] },
            },
          },
        });
        await runtime.editWithRetry((tx) =>
          catalog.withTx(tx).key("entries", registration.space, "state").set(
            "future-state",
          )
        );
        expect(
          await invoke(runtime, home.key("changeSharedSpaceMembership"), {
            space: registration.space,
            id: "future",
            state: "saved",
            expectedRevision: (await home.key("sharedSpaceCatalog").pull())
              .entries[registration.space].revision,
          }, "future"),
        ).toEqual({ status: "conflict", reason: "unsupported-state" });
        expect(
          await invoke(
            runtime,
            home.key("registerSharedSpace"),
            registration,
            "replay",
          ),
        ).toEqual({ status: "existing", space: registration.space });
        expect(catalog.getRaw()).toMatchObject({
          entries: {
            [registration.space]: {
              state: "future-state",
              futureField: { nested: [1, 2] },
            },
          },
        });
      });
    });

    it(`preserves concurrent registrations and refuses competing choices with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home, fresh) => {
        const peer = await fresh();
        const second = {
          ...registration,
          space: "did:key:second-room",
          offer: { from: "did:key:catalog-sender", id: "second" },
        };
        expect(
          await Promise.all([
            invoke(
              runtime,
              home.key("registerSharedSpace"),
              registration,
              "first",
            ),
            invoke(
              peer.runtime,
              peer.home.key("registerSharedSpace"),
              second,
              "second",
            ),
          ]),
        ).toEqual([{ status: "registered", space: registration.space }, {
          status: "registered",
          space: second.space,
        }]);
        await awaitEdges(
          [(wake) => home.key("sharedSpaceCatalog").sink(wake)],
          () =>
            Object.keys(home.key("sharedSpaceCatalog").get().entries).length ===
              2,
        );
        const catalog = await home.key("sharedSpaceCatalog").pull();
        expect(Object.keys(catalog.entries).sort()).toEqual(
          [registration.space, second.space].sort(),
        );
        const choice = {
          space: registration.space,
          state: "archived",
          expectedRevision: catalog.entries[registration.space].revision,
        };
        const results = await Promise.all([
          invoke(runtime, home.key("changeSharedSpaceMembership"), {
            ...choice,
            id: "mine",
          }, "mine"),
          invoke(peer.runtime, peer.home.key("changeSharedSpaceMembership"), {
            ...choice,
            id: "theirs",
          }, "theirs"),
        ]);
        expect(
          results.map((value) => (value as { status: string }).status).sort(),
        ).toEqual(["applied", "conflict"]);
        expect(results).toContainEqual({
          status: "conflict",
          reason: "revision",
        });
        expect(
          (await peer.home.key("sharedSpaceCatalog").pull())
            .entries[registration.space].state,
        ).toBe("archived");
      });
    });

    it(`returns durable operation receipts separately from current membership with serving ${serving}`, async () => {
      await withHome(serving, async (runtime, home) => {
        expect(
          await invoke(
            runtime,
            home.key("registerSharedSpace"),
            registration,
            "register",
          ),
        ).toEqual({ status: "registered", space: registration.space });
        const catalog = home.key("sharedSpaceCatalog");
        const first = await catalog.pull();
        const archive = {
          space: registration.space,
          id: "archive",
          expectedRevision: first.entries[registration.space].revision,
          state: "archived" as const,
        };
        expect(
          await invoke(
            runtime,
            home.key("changeSharedSpaceMembership"),
            archive,
            "archive",
          ),
        ).toEqual({
          status: "applied",
          space: registration.space,
          id: "archive",
        });
        expect(
          await invoke(
            runtime,
            home.key("registerSharedSpace"),
            registration,
            "register-again",
          ),
        ).toEqual({ status: "existing", space: registration.space });
        expect((await catalog.pull()).entries[registration.space].state).toBe(
          "archived",
        );
        expect(
          await invoke(
            runtime,
            home.key("changeSharedSpaceMembership"),
            archive,
            "confirm-archive",
          ),
        ).toEqual({
          status: "confirmed",
          space: registration.space,
          id: "archive",
        });
        const archived = await catalog.pull();
        expect(
          await invoke(runtime, home.key("changeSharedSpaceMembership"), {
            ...archive,
            id: "restore",
            state: "saved",
            expectedRevision: archived.entries[registration.space].revision,
          }, "restore"),
        ).toMatchObject({ status: "applied" });
        expect(
          await invoke(
            runtime,
            home.key("changeSharedSpaceMembership"),
            archive,
            "archive",
          ),
        ).toEqual({
          status: "applied",
          space: registration.space,
          id: "archive",
        });
        expect((await catalog.pull()).entries[registration.space].state).toBe(
          "saved",
        );
        expect(
          await invoke(
            runtime,
            home.key("changeSharedSpaceMembership"),
            archive,
            "stale-archive",
          ),
        ).toEqual({ status: "conflict", reason: "revision" });
        await runtime.idle();
      });
    });
  }
});
