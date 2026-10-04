import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { cfcAtom } from "@commonfabric/api/cfc";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { rootRenderPolicyFor } from "@commonfabric/html/worker";
import { Identity } from "@commonfabric/identity";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { ACLManager, Runtime } from "@commonfabric/runner";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { interceptTransaction } from "../../runner/test/support/intercept-transaction.ts";
import { RuntimeClients } from "../src/backends/client-registry.ts";
import { HostReadGate } from "../src/backends/host-read-gate.ts";
import { MessagePortRuntimeTransport } from "../src/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "../src/protocol/mod.ts";
import { RuntimeClient } from "../src/runtime-client.ts";
import {
  isSharedSpaceCatalog,
  type SharedSpaceCatalog,
  type SharedSpaceCatalogHome,
  type SharedSpaceMembershipChange,
  type SharedSpaceRegistration,
} from "../src/shared-space-catalog-contract.ts";
import {
  changeSharedSpaceMembership,
  getSharedSpaceCatalog,
  registerSharedSpace,
  sharedSpaceCatalogCell,
} from "../src/shared-space-catalog.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const identity = await Identity.fromPassphrase("shared catalog owner");
const other = await Identity.fromPassphrase("shared catalog other owner");
const home: SharedSpaceCatalogHome = {
  principal: identity.did(),
  host: "https://home.example",
};
const loom: SharedSpaceRegistration = {
  space: "did:key:loom-space",
  host: "https://spaces.example",
  kind: "loom",
  title: "A shared loom",
};
const room: SharedSpaceRegistration = {
  space: "did:key:room-space",
  host: "https://rooms.example",
  kind: "fabrichat-room",
};

/** Independent runtimes sharing one memory server and no Home UI. */
type Fixture = {
  /** The server whose fan-out a concurrency case may hold. */
  server: Server;

  /** First device's runtime. */
  first: Runtime;

  /** Second device's runtime. */
  second: Runtime;

  /** Creates a fresh device with empty local state. */
  fresh: (servingPosture?: boolean) => Runtime;
};

/** Runs a case against independent replicas and closes every session. */
async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
) {
  const server = new Server({
    acl: { mode: "enforce" },
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: "did:key:catalog-test-memory" },
    subscriptionRefreshDelayMs: 0,
  });
  const clients: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];
  const fresh = (servingPosture = false) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: identity });
    const runtime = new Runtime({
      apiUrl: new URL(home.host),
      storageManager: storage,
      servingPosture,
    });
    clients.push({ runtime, storage });
    return runtime;
  };
  try {
    const first = fresh();
    await new ACLManager(first, identity.did()).set(identity.did(), "OWNER");
    await body({ first, second: fresh(), fresh, server });
  } finally {
    await server.flushSessions();
    for (const { runtime, storage } of clients) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  }
}

/** Reads and validates the catalog from the supplied replica. */
async function read(runtime: Runtime): Promise<SharedSpaceCatalog> {
  const result = await getSharedSpaceCatalog(runtime, home);
  if (result.status !== "ready") throw new Error("Expected a stored catalog.");
  return result.catalog;
}

/** Attaches the public client through a real message channel to one replica. */
async function connect(runtime: Runtime) {
  const processor = buildProcessor({
    runtime,
    identity,
    space: identity.did(),
  });
  const registry = new RuntimeClients({
    owner: { id: 0, post: () => true },
    setConsoleBridge: () => {},
    initializeRuntime: () => Promise.resolve(processor),
  });
  await registry.handleMessage(
    registry.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: {
            apiUrl: "http://localhost/",
            identity: identity.keyPair,
            spaceDid: identity.did(),
          },
        },
      }),
    }),
  );
  const channel = new MessageChannel();
  registry.attach(channel.port2);
  const client = await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    {
      identity: identity.did(),
      apiUrl: new URL("http://localhost/"),
      spaceDid: identity.did(),
    },
  );
  return { client, processor };
}

describe("shared-space-catalog", () => {
  it("distinguishes an absent catalog from failed and malformed reads", async () => {
    await withFixture(async ({ first, fresh }) => {
      expect(await getSharedSpaceCatalog(first, home)).toEqual({
        status: "absent",
      });
      const address = sharedSpaceCatalogCell(first, home)
        .getAsNormalizedFullLink();
      const provider = first.storageManager.open(address.space);
      const failed = stub(
        provider,
        "sync",
        () => Promise.resolve({ error: new Error("Transport unavailable") }),
      );
      try {
        await expect(getSharedSpaceCatalog(first, home)).rejects.toThrow(
          "Transport unavailable",
        );
        await expect(registerSharedSpace(first, home, loom)).rejects.toThrow(
          "Transport unavailable",
        );
      } finally {
        failed.restore();
      }
      expect(await getSharedSpaceCatalog(fresh(), home)).toEqual({
        status: "absent",
      });
      const tx = first.edit();
      sharedSpaceCatalogCell(first, home).withTx(tx).set({ version: 999 });
      expect((await tx.commit()).error).toBeUndefined();
      await expect(getSharedSpaceCatalog(fresh(), home)).rejects.toThrow(
        "malformed or unsupported",
      );
    });
  });

  it("refuses revoked Home reads on fresh raw and worker clients instead of reporting absence", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const acl = new ACLManager(first, identity.did());
      await acl.set(other.did(), "OWNER");
      await acl.remove(identity.did());
      await expect(getSharedSpaceCatalog(fresh(), home)).rejects.toThrow();
      const attached = await connect(fresh());
      try {
        await expect(attached.client.getSharedSpaceCatalog(home)).rejects
          .toThrow();
      } finally {
        await attached.client.dispose();
        await attached.processor.dispose();
      }
    });
  });

  it("recovers both kinds on a fresh device without running Home", async () => {
    await withFixture(async ({ first, fresh }) => {
      expect((await registerSharedSpace(first, home, loom)).status).toBe(
        "registered",
      );
      expect((await registerSharedSpace(first, home, room)).status).toBe(
        "registered",
      );
      const catalog = await read(fresh());
      expect(Object.keys(catalog.entries).sort()).toEqual([
        loom.space,
        room.space,
      ]);
      expect(catalog.entries[loom.space].state).toBe("saved");
      expect(catalog.entries[room.space].kind).toBe("fabrichat-room");
    });
  });

  it("preserves independent registrations racing from two empty replicas", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      const results = await Promise.all([
        registerSharedSpace(first, home, loom),
        registerSharedSpace(second, home, room),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        "registered",
        "registered",
      ]);
      expect(Object.keys((await read(fresh())).entries).sort()).toEqual([
        loom.space,
        room.space,
      ]);
    });
  });

  it("converges simultaneous registration of one space on one entry", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      const results = await Promise.all([
        registerSharedSpace(first, home, loom),
        registerSharedSpace(second, home, { ...loom, title: "Other title" }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "existing",
        "registered",
      ]);
      if (
        results[0].status === "conflict" || results[1].status === "conflict"
      ) {
        throw new Error("Expected both registrations to succeed.");
      }
      expect(results[0].entry.revision).toBe(results[1].entry.revision);
      expect(Object.keys((await read(fresh())).entries)).toEqual([loom.space]);
    });
  });

  it("imports archived legacy membership without publishing a saved intermediate entry", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      const imported = await registerSharedSpace(first, home, {
        ...loom,
        initialState: "archived",
      });
      expect(imported.status).toBe("registered");
      expect((await read(fresh())).entries[loom.space].state).toBe("archived");
      await registerSharedSpace(second, home, loom);
      expect((await read(fresh())).entries[loom.space].state).toBe("archived");
    });
  });

  it("preserves the winning membership when saved and archived registrations race", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      const results = await Promise.all([
        registerSharedSpace(first, home, loom),
        registerSharedSpace(second, home, {
          ...loom,
          initialState: "archived",
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "existing",
        "registered",
      ]);
      const inserted = results.find((result) => result.status === "registered");
      if (!inserted || inserted.status === "conflict") {
        throw new Error("Expected an inserted entry.");
      }
      expect((await read(fresh())).entries[loom.space]).toEqual(inserted.entry);
      await registerSharedSpace(second, home, {
        ...loom,
        initialState: inserted.entry.state === "saved" ? "archived" : "saved",
      });
      expect((await read(fresh())).entries[loom.space]).toEqual(inserted.entry);
    });
  });

  it("preserves archive through registration and new offers on a fresh device", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const original = (await read(second)).entries[loom.space];
      const archive: SharedSpaceMembershipChange = {
        space: loom.space,
        id: "archive",
        expectedRevision: original.revision,
        state: "archived",
      };
      expect((await changeSharedSpaceMembership(first, home, archive)).status)
        .toBe("applied");
      expect(
        (await registerSharedSpace(second, home, {
          ...loom,
          offer: { from: other.did(), id: "new-offer" },
        })).status,
      ).toBe("existing");
      const after = (await read(fresh())).entries[loom.space];
      expect(after.state).toBe("archived");
      expect(after.revision).not.toBe(original.revision);
      expect(
        (await changeSharedSpaceMembership(second, home, {
          space: loom.space,
          id: "restore",
          expectedRevision: after.revision,
          state: "saved",
        })).status,
      ).toBe("applied");
      expect((await read(fresh())).entries[loom.space].state).toBe("saved");
    });
  });

  it("confirms a lost reply but refuses replay after a later explicit action", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const before = (await read(first)).entries[loom.space];
      const action: SharedSpaceMembershipChange = {
        space: loom.space,
        id: "lost-archive-reply",
        expectedRevision: before.revision,
        state: "archived",
      };
      await changeSharedSpaceMembership(first, home, action);
      const confirmation = await changeSharedSpaceMembership(
        fresh(),
        home,
        action,
      );
      expect(confirmation.status).toBe("confirmed");
      const archived = (await read(second)).entries[loom.space];
      await changeSharedSpaceMembership(second, home, {
        space: loom.space,
        id: "restore",
        expectedRevision: archived.revision,
        state: "saved",
      });
      expect(await changeSharedSpaceMembership(first, home, action)).toEqual({
        status: "conflict",
        reason: "revision",
      });
      expect((await read(fresh())).entries[loom.space].state).toBe("saved");
    });
  });

  it("admits at most one of two actions based on the same revision", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const before = (await read(second)).entries[loom.space];
      const results = await Promise.all([
        changeSharedSpaceMembership(first, home, {
          space: loom.space,
          id: "a",
          expectedRevision: before.revision,
          state: "archived",
        }),
        changeSharedSpaceMembership(second, home, {
          space: loom.space,
          id: "b",
          expectedRevision: before.revision,
          state: "saved",
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "applied",
        "conflict",
      ]);
      const winner = results.find((result) => result.status === "applied");
      if (!winner || winner.status === "conflict") {
        throw new Error("Expected a winner.");
      }
      expect((await read(fresh())).entries[loom.space]).toEqual(winner.entry);
    });
  });

  it("refuses an operation ID reused for a different membership choice", async () => {
    await withFixture(async ({ first }) => {
      await registerSharedSpace(first, home, loom);
      const before = (await read(first)).entries[loom.space];
      const action: SharedSpaceMembershipChange = {
        space: loom.space,
        id: "same-id",
        expectedRevision: before.revision,
        state: "archived",
      };
      await changeSharedSpaceMembership(first, home, action);
      expect(
        await changeSharedSpaceMembership(first, home, {
          ...action,
          state: "saved",
        }),
      ).toEqual({ status: "conflict", reason: "action" });
    });
  });

  it("keys offers by sender and ID and refuses a changed target atomically", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      const offer = { from: other.did(), id: "same-id" };
      await registerSharedSpace(first, home, { ...loom, offer });
      expect(await registerSharedSpace(second, home, { ...room, offer }))
        .toEqual({ status: "conflict", reason: "offer" });
      expect((await read(fresh())).entries[room.space]).toBeUndefined();
      await registerSharedSpace(second, home, {
        ...room,
        offer: { ...offer, from: identity.did() },
      });
      const catalog = await read(fresh());
      expect(Object.keys(catalog.offers)).toHaveLength(2);
      expect(Object.keys(catalog.entries)).toHaveLength(2);
    });
  });

  it("retains first-admission provenance across offers and membership changes", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, {
        ...loom,
        since: 123,
        offer: { from: other.did(), id: "first-offer" },
      });
      const initial = (await read(first)).entries[loom.space];
      expect(initial).toMatchObject({
        from: other.did(),
        since: 123,
        title: loom.title,
      });
      await changeSharedSpaceMembership(first, home, {
        space: loom.space,
        id: "archive-with-provenance",
        expectedRevision: initial.revision,
        state: "archived",
      });
      await registerSharedSpace(second, home, {
        ...loom,
        since: 456,
        title: "Another display hint",
        offer: { from: identity.did(), id: "later-offer" },
      });
      expect((await read(fresh())).entries[loom.space]).toMatchObject({
        from: other.did(),
        since: 123,
        title: loom.title,
        state: "archived",
      });

      const started = Date.now();
      await registerSharedSpace(second, home, room);
      const direct = (await read(fresh())).entries[room.space];
      expect(direct.from).toBeUndefined();
      expect(direct.since).toBeGreaterThanOrEqual(started);
      expect(direct.since).toBeLessThanOrEqual(Date.now());
      await registerSharedSpace(first, home, {
        ...room,
        offer: { from: other.did(), id: "offered-after-save" },
      });
      expect((await read(fresh())).entries[room.space]).toEqual(direct);
    });
  });

  it("refuses host and kind conflicts without redirecting or duplicating the entry", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      expect(
        await registerSharedSpace(second, home, { ...loom, host: room.host }),
      ).toEqual({ status: "conflict", reason: "host" });
      expect(
        await registerSharedSpace(second, home, {
          ...loom,
          kind: "fabrichat-room",
        }),
      ).toEqual({ status: "conflict", reason: "kind" });
      expect(Object.keys((await read(fresh())).entries)).toEqual([loom.space]);
    });
  });

  it("refuses a different Home principal or host before storing a catalog", async () => {
    await withFixture(async ({ first }) => {
      await expect(
        registerSharedSpace(first, { ...home, principal: other.did() }, loom),
      ).rejects.toThrow("principal");
      await expect(
        registerSharedSpace(first, { ...home, host: loom.host }, loom),
      ).rejects.toThrow("Home host");
      expect(await sharedSpaceCatalogCell(first, home).pull()).toBeUndefined();
    });
  });

  it("refuses sticky Home access failures despite a successful cached load", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const before = await read(first);
      const change: SharedSpaceMembershipChange = {
        space: loom.space,
        id: "denied-archive",
        expectedRevision: before.entries[loom.space].revision,
        state: "archived",
      };
      for (const source of ["spaceAccessError", "authorizationError"]) {
        const denied = new Error(`Sticky ${source} refusal`);
        const access = stub(
          first.storageManager,
          "spaceAccessError",
          () => source === "spaceAccessError" ? denied : undefined,
        );
        const authorization = stub(
          first.storageManager,
          "authorizationError",
          () => source === "authorizationError" ? denied : undefined,
        );
        try {
          await expect(getSharedSpaceCatalog(first, home)).rejects.toBe(denied);
          await expect(registerSharedSpace(first, home, room)).rejects.toBe(
            denied,
          );
          await expect(changeSharedSpaceMembership(first, home, change))
            .rejects.toBe(denied);
        } finally {
          authorization.restore();
          access.restore();
        }
        expect(await read(fresh())).toEqual(before);
      }
    });
  });

  it("refuses unscoped serving access even when the runtime identity matches Home", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const before = await read(first);
      const serving = fresh(true);
      expect(serving.userIdentityDID).toBe(home.principal);
      await expect(getSharedSpaceCatalog(serving, home)).rejects.toThrow(
        "principal",
      );
      await expect(registerSharedSpace(serving, home, room)).rejects.toThrow(
        "principal",
      );
      await expect(changeSharedSpaceMembership(serving, home, {
        space: loom.space,
        id: "serving-archive",
        expectedRevision: before.entries[loom.space].revision,
        state: "archived",
      })).rejects.toThrow("principal");
      expect(await read(fresh())).toEqual(before);
    });
  });

  it("refuses SDK reads and mutations when the catalog exceeds the host display ceiling", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const before = await read(first);
      const address = sharedSpaceCatalogCell(first, home)
        .getAsNormalizedFullLink();
      const tx = first.edit();
      writeSeedEnvelopeDoc(tx, identity.did());
      seedStoredEnvelope(tx, {
        space: identity.did(),
        id: address.id,
        type: "application/json",
        path: [],
      }, {
        value: before,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [cfcAtom.resource("CredentialSecret")],
              },
            }],
          },
        },
      });
      expect((await tx.commit()).error).toBeUndefined();
      const gate = new HostReadGate(
        rootRenderPolicyFor({ atoms: [], caveatKinds: [] }),
        {},
      );
      const { client, processor } = await connect(first);
      // The worker has no configurable host ceiling yet. Supply a real gate
      // policy at its boundary so these requests exercise actual label refusal.
      const enforce = stub(
        HostReadGate.prototype,
        "read",
        gate.read.bind(gate),
      );
      try {
        await expect(client.getSharedSpaceCatalog(home)).rejects.toThrow(
          "The host cannot read this shared-space catalog.",
        );
        await expect(client.registerSharedSpace(home, room)).rejects.toThrow(
          "The host cannot read this shared-space catalog.",
        );
        await expect(client.changeSharedSpaceMembership(home, {
          space: loom.space,
          id: "hidden-archive",
          expectedRevision: before.entries[loom.space].revision,
          state: "archived",
        })).rejects.toThrow("The host cannot read this shared-space catalog.");
      } finally {
        enforce.restore();
        await client.dispose();
        await processor.dispose();
      }
      expect(await read(fresh())).toEqual(before);
    });
  });

  it("refuses malformed stored data and leaves it intact", async () => {
    await withFixture(async ({ first, second }) => {
      const tx = first.edit();
      sharedSpaceCatalogCell(first, home).withTx(tx).set({
        version: 99,
        entries: {},
      });
      expect((await tx.commit()).error).toBeUndefined();
      await expect(registerSharedSpace(second, home, loom)).rejects.toThrow(
        "malformed or unsupported",
      );
      await sharedSpaceCatalogCell(first, home).pull();
      expect(sharedSpaceCatalogCell(first, home).getRaw()).toEqual({
        version: 99,
        entries: {},
      });
    });
  });

  it("refuses invalid registration kinds and routes without storing data", async () => {
    await withFixture(async ({ first }) => {
      for (
        const input of [
          { ...loom, kind: "" },
          { ...loom, host: "https://spaces.example/other" },
          { ...loom, host: "https://user:secret@spaces.example" },
          { ...loom, space: "did:not valid" },
        ]
      ) {
        await expect(
          registerSharedSpace(first, home, input as SharedSpaceRegistration),
        ).rejects.toThrow();
      }
      expect(await sharedSpaceCatalogCell(first, home).pull()).toBeUndefined();
    });
  });
  it("carries registration and lost-reply confirmation through the worker bridge", async () => {
    await withFixture(async ({ first, second }) => {
      const a = await connect(first);
      const b = await connect(second);
      try {
        const registration = await a.client.registerSharedSpace(home, loom);
        expect(registration.status).toBe("registered");
        const snapshot = await b.client.getSharedSpaceCatalog(home);
        const catalog = snapshot.status === "ready"
          ? snapshot.catalog
          : undefined;
        if (!isSharedSpaceCatalog(catalog)) {
          throw new Error("Expected a catalog over IPC.");
        }
        const action: SharedSpaceMembershipChange = {
          space: loom.space,
          id: "bridge-archive",
          state: "archived",
          expectedRevision: catalog.entries[loom.space].revision,
        };
        const dispatch = a.processor.handleRequest.bind(a.processor);
        const lostReply = stub(
          a.processor,
          "handleRequest",
          async (...args) => {
            const response = await dispatch(...args);
            if (args[0].type === RequestType.ChangeSharedSpaceMembership) {
              throw new Error("Catalog reply lost after commit");
            }
            return response;
          },
        );
        try {
          await expect(a.client.changeSharedSpaceMembership(home, action))
            .rejects.toThrow("reply lost");
        } finally {
          lostReply.restore();
        }
        expect(
          (await b.client.changeSharedSpaceMembership(home, action)).status,
        ).toBe("confirmed");
        expect((await read(second)).entries[loom.space].state).toBe("archived");
      } finally {
        await a.client.dispose();
        await b.client.dispose();
        await a.processor.dispose();
        await b.processor.dispose();
      }
    });
  });

  it("does not report registration or keep a receipt when Home rejects the write", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const acl = new ACLManager(first, identity.did());
      await acl.set(other.did(), "OWNER");
      await acl.set(identity.did(), "READ");
      await expect(registerSharedSpace(second, home, {
        ...room,
        offer: { from: other.did(), id: "refused" },
      })).rejects.toThrow();
      const catalog = await read(fresh());
      expect(Object.keys(catalog.entries)).toEqual([loom.space]);
      expect(catalog.offers).toEqual({});
    });
  });

  it("registers an application-validated kind without an SDK kind-list change", async () => {
    await withFixture(async ({ first, fresh }) => {
      const registration = { ...loom, kind: "future-kind" };
      expect((await registerSharedSpace(first, home, registration)).status)
        .toBe("registered");
      expect((await read(fresh())).entries[loom.space].kind).toBe(
        "future-kind",
      );
    });
  });

  it("retains unfamiliar states and action evidence without making them active or writable", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const initial = await read(first);
      for (const state of ["left", "future-state"]) {
        const opaque = {
          ...initial.entries[loom.space],
          state,
          lastAction: {
            id: "future-action",
            expectedRevision: "older",
            state: "saved",
            futureEvidence: ["opaque"],
          },
        };
        const tx = first.edit();
        sharedSpaceCatalogCell(first, home).withTx(tx).set({
          ...initial,
          entries: { [loom.space]: opaque },
        });
        expect((await tx.commit()).error).toBeUndefined();
        const registration = await registerSharedSpace(second, home, {
          ...loom,
          offer: { from: other.did(), id: state },
        });
        expect(registration.status).toBe("existing");
        await registerSharedSpace(second, home, room);
        const catalog = await read(fresh());
        expect(catalog.entries[loom.space]).toEqual(opaque);
        expect(
          Object.values(catalog.entries).filter((entry) =>
            entry.state === "saved"
          ).map((entry) => entry.space),
        ).toEqual([room.space]);
        for (const requested of ["saved", "archived"] as const) {
          expect(
            await changeSharedSpaceMembership(second, home, {
              space: loom.space,
              id: "future-action",
              expectedRevision: "older",
              state: requested,
            }),
          ).toEqual({ status: "conflict", reason: "unsupported-state" });
          expect(
            await changeSharedSpaceMembership(second, home, {
              space: loom.space,
              id: "new-action",
              expectedRevision: opaque.revision,
              state: requested,
            }),
          ).toEqual({ status: "conflict", reason: "unsupported-state" });
        }
        expect((await read(fresh())).entries[loom.space]).toEqual(opaque);
      }
    });
  });

  it("isolates unfamiliar action evidence from other entries and refuses to overwrite it", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const catalog = await read(first);
      const opaque = {
        ...catalog.entries[loom.space],
        lastAction: { futureEvidence: true },
      };
      const tx = first.edit();
      sharedSpaceCatalogCell(first, home).withTx(tx).set({
        ...catalog,
        entries: { [loom.space]: opaque },
      });
      expect((await tx.commit()).error).toBeUndefined();
      await registerSharedSpace(second, home, room);
      expect(
        await changeSharedSpaceMembership(second, home, {
          space: loom.space,
          id: "archive",
          expectedRevision: opaque.revision,
          state: "archived",
        }),
      ).toEqual({ status: "conflict", reason: "action" });
      expect((await read(fresh())).entries[loom.space]).toEqual(opaque);
    });
  });

  it("refuses contradictory action evidence without blocking other entries", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const catalog = await read(first);
      const entry = {
        ...catalog.entries[loom.space],
        lastAction: {
          id: "contradictory-action",
          expectedRevision: "older",
          state: "archived",
        },
      };
      const tx = first.edit();
      sharedSpaceCatalogCell(first, home).withTx(tx).set({
        ...catalog,
        entries: { [loom.space]: entry },
      });
      expect((await tx.commit()).error).toBeUndefined();
      await registerSharedSpace(first, home, room);
      const actions: Omit<SharedSpaceMembershipChange, "space">[] = [
        {
          id: "new-archive",
          expectedRevision: entry.revision,
          state: "archived",
        },
        { id: "new-save", expectedRevision: entry.revision, state: "saved" },
        {
          id: "contradictory-action",
          expectedRevision: "older",
          state: "archived",
        },
      ];
      for (const action of actions) {
        expect(
          await changeSharedSpaceMembership(first, home, {
            space: loom.space,
            ...action,
          }),
        ).toEqual({ status: "conflict", reason: "action" });
      }
      const after = await read(fresh());
      expect(after.entries[loom.space]).toEqual(entry);
      expect(after.entries[room.space].state).toBe("saved");
    });
  });

  it("preserves unknown kinds and extension fields while registering a known kind", async () => {
    await withFixture(async ({ first, second, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const catalog = await read(first);
      const future = {
        ...catalog.entries[loom.space],
        space: "did:key:future-space",
        kind: "future-kind",
        extra: "retained",
      };
      const tx = first.edit();
      sharedSpaceCatalogCell(first, home).withTx(tx).set({
        ...catalog,
        extra: "catalog-extension",
        entries: { ...catalog.entries, [future.space]: future },
      });
      expect((await tx.commit()).error).toBeUndefined();
      await registerSharedSpace(second, home, room);
      const value = await read(fresh());
      expect(value.entries[future.space]).toEqual(future);
      expect((value as SharedSpaceCatalog & { extra: string }).extra).toBe(
        "catalog-extension",
      );
    });
  });
  it("refuses confirmation when the transaction cannot pin its observed value", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const before = await read(first);
      const edit = first.edit.bind(first);
      const unsupported = stub(first, "edit", (...args) => {
        const tx = edit(...args);
        Object.defineProperty(tx, "addCommitPrecondition", {
          value: undefined,
        });
        return tx;
      });
      try {
        await expect(registerSharedSpace(first, home, loom)).rejects.toThrow(
          "Catalog confirmation requires commit preconditions.",
        );
      } finally {
        unsupported.restore();
      }
      expect(await read(fresh())).toEqual(before);
    });
  });

  it("reports a server-refused value pin as a catalog conflict", async () => {
    await withFixture(async ({ first, fresh }) => {
      await registerSharedSpace(first, home, loom);
      const action: SharedSpaceMembershipChange = {
        space: loom.space,
        id: "archive-before-pin-refusal",
        expectedRevision: (await read(first)).entries[loom.space].revision,
        state: "archived",
      };
      await changeSharedSpaceMembership(first, home, action);
      const before = await read(first);
      const address = sharedSpaceCatalogCell(first, home)
        .getAsNormalizedFullLink();
      const edit = first.edit.bind(first);
      const rejectedPin = stub(first, "edit", (...args) => {
        const tx = edit(...args);
        return interceptTransaction(tx, (method, _args, proceed) => {
          if (method !== "addCommitPrecondition") return proceed();
          if (!tx.addCommitPrecondition) {
            throw new Error("Expected pin support.");
          }
          // An absence pin against the stored catalog forces a real server
          // refusal without depending on when a peer's fan-out arrives.
          return tx.addCommitPrecondition(address.space, {
            kind: "entity-value-hash",
            id: address.id,
            scope: address.scope,
            valueHash: null,
          });
        });
      });
      try {
        expect(await registerSharedSpace(first, home, loom)).toEqual({
          status: "conflict",
          reason: "catalog-changed",
        });
        expect(await changeSharedSpaceMembership(first, home, action)).toEqual({
          status: "conflict",
          reason: "catalog-changed",
        });
      } finally {
        rejectedPin.restore();
      }
      expect(await read(fresh())).toEqual(before);
    });
  });

  it("refuses stale confirmation even while the newer choice's fan-out is withheld", async () => {
    await withFixture(async ({ first, second, server }) => {
      await registerSharedSpace(first, home, loom);
      const entry = (await read(first)).entries[loom.space];
      const archive: SharedSpaceMembershipChange = {
        space: loom.space,
        id: "old-archive",
        expectedRevision: entry.revision,
        state: "archived",
      };
      await changeSharedSpaceMembership(first, home, archive);
      const catalog = await read(second);
      const archived = catalog.entries[loom.space];
      expect(archived.state).toBe("archived");
      server.options.subscriptionRefreshDelayMs = "manual";
      const tx = second.edit();
      sharedSpaceCatalogCell(second, home).withTx(tx).set({
        ...catalog,
        entries: {
          ...catalog.entries,
          [loom.space]: {
            ...archived,
            state: "saved",
            revision: "peer-restore",
            lastAction: {
              id: "new-restore",
              expectedRevision: archived.revision,
              state: "saved",
            },
          },
        },
      });
      expect(
        (await tx.commit({
          resolveAt: "verdict",
        })).error,
      ).toBeUndefined();
      const stale = sharedSpaceCatalogCell(first, home).getRaw();
      if (!isSharedSpaceCatalog(stale)) {
        throw new Error("Expected the stale catalog.");
      }
      expect(stale.entries[loom.space].lastAction).toMatchObject({
        id: "old-archive",
      });
      // Release fan-out only after the server decides the stale confirmation.
      const edit = first.edit.bind(first);
      const verdictOnly = stub(first, "edit", (...args) => {
        const tx = edit(...args);
        return interceptTransaction(
          tx,
          (method, _args, proceed) =>
            method === "commit"
              ? tx.commit({ resolveAt: "verdict" }).then(async (result) => {
                await server.flushSessions();
                return result;
              })
              : proceed(),
        );
      });
      try {
        expect((await changeSharedSpaceMembership(first, home, archive)).status)
          .toBe("conflict");
      } finally {
        verdictOnly.restore();
      }
    });
  });
});
