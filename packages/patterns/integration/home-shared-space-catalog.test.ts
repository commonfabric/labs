import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  ACLManager,
  type Cell,
  getDerivedInternalCellLink,
  getPatternIdentityRef,
  type IExtendedStorageTransaction,
  Runtime,
  sendEvent,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
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
) {
  const tx = await new Promise<IExtendedStorageTransaction>((resolve) => {
    sendEvent(stream, event as T, resolve, {
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

/** Independent replicas against an ACL-enforcing memory server. */
async function withHome(
  serverExecution: boolean,
  body: (
    runtime: Runtime,
    home: Cell<HomeSurface>,
    peer: () => Promise<{ runtime: Runtime; home: Cell<HomeSurface> }>,
    server: Server,
  ) => Promise<void>,
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
  const fresh = () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental: { serverExecution },
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
    await body(first.runtime, home, async () => {
      const client = fresh();
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

describe("Home shared-space catalog", () => {
  for (const serving of [false, true]) {
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
            space: "did:key:other-room",
          }, "retarget"),
        ).toEqual({ status: "conflict", reason: "offer" });
        expect(
          await invoke(runtime, home.key("registerSharedSpace"), {
            ...registration,
            kind: "other",
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
