/** Independent attendee runtimes allocate through one ACL-enforcing directory. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { readGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  ACLManager,
  type Cell,
  getDerivedInternalCellLink,
  type IExtendedStorageTransaction,
  Runtime,
  sendEvent,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { createTransactionCommitReceipt } from "../../runner/src/storage/commit-receipt.ts";
import {
  ensureSpaceRootPattern,
  resolveSpaceRootPattern,
} from "../../runner/src/ensure-space-root.ts";
import { interceptTransaction } from "../../runner/test/support/intercept-transaction.ts";

import type {
  AllocateMeeting,
  MeetingAttempt,
  MeetingClaim,
  MeetingClaimResult,
} from "../meeting-rooms/main.tsx";

const admin = await Identity.fromPassphrase("meeting directory admin");
const alice = await Identity.fromPassphrase("meeting attendee Alice");
const bob = await Identity.fromPassphrase("meeting attendee Bob");
const service = await Identity.fromPassphrase("meeting test serving identity");
const MEETING = "a".repeat(64);

interface Directory {
  claims: Record<string, MeetingClaim>;
  allocate: AllocateMeeting;
  reserve: MeetingAttempt;
  publish: MeetingAttempt;
}

interface Client {
  runtime: Runtime;
  storage: EmulatedStorageManager;
  directory: Cell<Directory>;
  cancel: () => void;
}

async function withDirectory(
  body: (
    open: (identity: Identity) => Promise<Client>,
    server: Server,
  ) => Promise<void>,
  serverExecution = false,
) {
  const server = new Server({
    acl: { mode: "enforce", delegatingDids: [service.did()] },
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: "did:key:meeting-directory-test" },
    subscriptionRefreshDelayMs: 0,
  });
  const clients: Client[] = [];
  let executor: ExecutorHost | undefined;
  const open = async (identity: Identity): Promise<Client> => {
    const storage = EmulatedStorageManager.connectTo(server, { as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example.test"),
      storageManager: storage,
      experimental: { serverExecution: identity !== admin && serverExecution },
    });
    if (identity === admin) {
      const acl = new ACLManager(runtime, admin.did());
      await acl.set(admin.did(), "OWNER");
      await acl.set(alice.did(), "WRITE");
      await acl.set(bob.did(), "WRITE");
    }
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: new URL("../meeting-rooms/main.tsx", import.meta.url).pathname,
        root: new URL("..", import.meta.url).pathname,
      },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space: admin.did(),
    });
    const directory = runtime.getCell<Directory>(
      admin.did(),
      "meeting-directory",
      compiled.resultSchema,
    );
    const client = { runtime, storage, directory, cancel: () => {} };
    clients.push(client);
    if (identity === admin) {
      const tx = runtime.edit();
      runtime.run(tx, compiled, {}, directory);
      runtime.getSpaceCell(admin.did()).withTx(tx).key("defaultPattern").set(
        directory,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    } else {
      await directory.sync();
      expect(await runtime.start(directory)).toBe(true);
    }
    client.cancel = directory.key("claims").sink(() => {});
    await runtime.idle();
    return client;
  };
  try {
    await open(admin);
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
            apiUrl: new URL("https://fabric.example.test"),
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
    await body(open, server);
  } finally {
    await executor?.close();
    await server.flushSessions();
    for (const client of clients) {
      client.cancel();
      await client.runtime.idle();
      await client.storage.synced();
      await client.runtime.patternManager.flushCompileCacheWrites();
      await client.runtime.dispose();
      await client.storage.close();
    }
    await server.close();
  }
}

async function invoke(
  client: Client,
  method: "reserve" | "allocate" | "publish",
  event: MeetingAttempt | AllocateMeeting,
): Promise<MeetingClaimResult> {
  const tx = await new Promise<IExtendedStorageTransaction>((resolve) => {
    sendEvent(client.directory.key(method), event, resolve, {
      eventId: crypto.randomUUID(),
      session: "meeting-test",
    });
  });
  expect(tx.status().status).not.toBe("error");
  expect(tx.handlingReceiptLink).toBeDefined();
  if (!tx.handlingReceiptLink) {
    throw new Error("Handler returned no durable receipt link");
  }
  await client.runtime.idle();
  await client.storage.synced();
  return await client.runtime.getCellFromLink<MeetingClaimResult>(
    tx.handlingReceiptLink,
  ).pull();
}

async function claim(client: Client): Promise<MeetingClaim> {
  await client.runtime.idle();
  const claims = await client.directory.key("claims").pull();
  expect(Object.keys(claims)).toEqual([MEETING]);
  return claims[MEETING];
}

/** Holds both handlers after evaluation so their first commits must compete. */
function race(first: Client, second: Client) {
  const both = defer<void>();
  const proposals: unknown[] = [];
  const gates = [first, second].map((client) => {
    let held = false;
    const edit = client.runtime.edit.bind(client.runtime);
    return stub(client.runtime, "edit", (...args) => {
      const tx = interceptTransaction(
        edit(...args),
        (method, _args, proceed) => {
          if (
            method !== "commit" || !tx.handlingReceiptLink || held
          ) return proceed();
          held = true;
          proposals.push(
            client.runtime.getCellFromLink<MeetingClaimResult>(
              tx.handlingReceiptLink,
            ).withTx(tx).getRaw(),
          );
          if (proposals.length === 2) both.resolve();
          const pending = both.promise.then(() => ({
            receipt: proceed() as ReturnType<
              IExtendedStorageTransaction["commit"]
            >,
          }));
          return createTransactionCommitReceipt(
            pending.then(({ receipt }) => receipt.settled),
            pending.then(({ receipt }) => receipt.verdict),
          );
        },
      );
      return tx;
    });
  });
  return {
    proposals,
    [Symbol.dispose]() {
      both.resolve();
      for (const gate of gates) gate.restore();
    },
  };
}

/** Reaches owned storage to exercise malformed and future persisted records. */
async function backingClaims(client: Client) {
  const manifest = client.directory.getMetaRaw("internal") as {
    partialCause: string;
    kind?: "computed";
  }[];
  const descriptor = manifest.find((entry) =>
    entry.partialCause === "claims" && entry.kind === undefined
  );
  if (!descriptor) throw new Error("Missing owned claims cell");
  const cell = client.runtime.getCellFromLink(
    getDerivedInternalCellLink(client.directory, descriptor),
  )
    .asSchema<Record<string, any>>({
      type: "object",
      additionalProperties: true,
    });
  await cell.sync();
  return cell;
}

describe("meeting-rooms", () => {
  it("uses the admitted attendee rather than the serving identity", async () => {
    await withDirectory(async (open) => {
      const first = await open(alice);
      const second = await open(bob);
      const event = {
        meeting: MEETING,
        attempt: "retained",
        creator: bob.did(),
      };
      expect(await invoke(first, "reserve", event)).toEqual({
        status: "reserved",
      });
      const reader = await open(bob);
      expect((await claim(reader)).creator).toBe(alice.did());
      expect(
        await invoke(second, "allocate", {
          ...event,
          allocation: { space: "did:key:room", publicationSeed: "seed" },
        }),
      )
        .toEqual({ status: "conflict", reason: "creator" });
      expect(
        await invoke(first, "allocate", {
          ...event,
          allocation: { space: "did:key:room", publicationSeed: "seed" },
        }),
      )
        .toEqual({ status: "allocated" });
      expect(await invoke(first, "publish", event)).toEqual({
        status: "published",
      });
      expect((await claim(first)).state).toBe("ready");
    }, true);
  });
  it("selects one creator when independent attendees reserve concurrently", async () => {
    await withDirectory(async (open) => {
      const first = await open(alice);
      const second = await open(bob);
      using competing = race(first, second);
      const results = await Promise.all([
        invoke(first, "reserve", {
          meeting: MEETING,
          attempt: "alice-attempt",
        }),
        invoke(second, "reserve", { meeting: MEETING, attempt: "bob-attempt" }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "existing",
        "reserved",
      ]);
      expect(competing.proposals).toEqual([{ status: "reserved" }, {
        status: "reserved",
      }]);
      const reader = await open(alice);
      const recorded = await claim(reader);
      expect([alice.did(), bob.did()]).toContain(recorded.creator);
      expect(recorded.attempt).toBe(
        recorded.creator === alice.did() ? "alice-attempt" : "bob-attempt",
      );
      expect(recorded.state).toBe("reserved");
      expect(recorded.allocation).toBeUndefined();
    });
  });

  it("recovers the original claim after an ignored reply and another device's retry", async () => {
    await withDirectory(async (open) => {
      const first = await open(alice);
      await invoke(first, "reserve", {
        meeting: MEETING,
        attempt: "retained-attempt",
      });
      const restarted = await open(alice);
      expect(
        await invoke(restarted, "reserve", {
          meeting: MEETING,
          attempt: "retained-attempt",
        }),
      )
        .toEqual({ status: "existing" });
      expect(
        await invoke(restarted, "reserve", {
          meeting: MEETING,
          attempt: "different-device",
        }),
      )
        .toEqual({ status: "existing" });
      expect(await claim(restarted)).toEqual({
        creator: alice.did(),
        attempt: "retained-attempt",
        state: "reserved",
      });
    });
  });

  it("retains one allocation when two devices of the creator race", async () => {
    await withDirectory(async (open, server) => {
      const first = await open(alice);
      const event = { meeting: MEETING, attempt: "retained-attempt" };
      await invoke(first, "reserve", event);
      const second = await open(alice);
      const spaces = await Promise.all(
        [first, second].map((client, i) =>
          client.runtime.createSpace({
            root: {
              cause: JSON.stringify({
                purpose: "loom-publication-root",
                publication: "root-" + i,
              }),
            },
          })
        ),
      );
      const proposals = spaces.map((space, i) => ({
        space,
        publicationSeed: "root-" + i,
      }));
      using competing = race(first, second);
      const results = await Promise.all([
        invoke(first, "allocate", { ...event, allocation: proposals[0] }),
        invoke(second, "allocate", { ...event, allocation: proposals[1] }),
      ]);
      expect(results).toContainEqual({ status: "allocated" });
      expect(results).toContainEqual({
        status: "conflict",
        reason: "allocation",
      });
      expect(competing.proposals).toEqual([{ status: "allocated" }, {
        status: "allocated",
      }]);
      const reader = await open(alice);
      const recorded = await claim(reader);
      expect(proposals).toContainEqual(recorded.allocation);
      expect(recorded.state).toBe("allocated");
      // A source-free reservation stops the server from preparing a loser.
      for (const space of spaces) {
        expect(
          await ensureSpaceRootPattern(first.runtime, space, {
            isHomeSpace: false,
            genesisRoot: readGenesisRoot(await server.engineForSpace(space)),
          }),
        ).toEqual({ outcome: "awaiting-creator" });
        expect(await resolveSpaceRootPattern(first.runtime, space))
          .toBeUndefined();
      }
      if (!recorded.allocation) throw new Error("Missing allocation");
      expect(
        await invoke(reader, "allocate", {
          ...event,
          allocation: recorded.allocation,
        }),
      )
        .toEqual({ status: "existing" });
      expect(await claim(reader)).toEqual(recorded);
    });
  });

  it("requires the winning principal, attempt and allocation before readiness", async () => {
    await withDirectory(async (open) => {
      const first = await open(alice);
      const second = await open(bob);
      const event = { meeting: MEETING, attempt: "retained-attempt" };
      const allocation = {
        space: await first.runtime.createSpace(),
        publicationSeed: "root",
      };
      expect(await invoke(first, "publish", event)).toEqual({
        status: "conflict",
        reason: "missing",
      });
      await invoke(first, "reserve", event);
      expect(await invoke(first, "publish", event)).toEqual({
        status: "conflict",
        reason: "allocation",
      });
      expect(await invoke(second, "allocate", { ...event, allocation }))
        .toEqual({ status: "conflict", reason: "creator" });
      expect(
        await invoke(first, "allocate", {
          ...event,
          attempt: "wrong",
          allocation,
        }),
      )
        .toEqual({ status: "conflict", reason: "attempt" });
      expect(await invoke(first, "allocate", { ...event, allocation })).toEqual(
        { status: "allocated" },
      );
      expect(await invoke(second, "publish", event)).toEqual({
        status: "conflict",
        reason: "creator",
      });
      expect(await invoke(first, "publish", { ...event, attempt: "wrong" }))
        .toEqual({ status: "conflict", reason: "attempt" });
      expect((await claim(first)).state).toBe("allocated");
      expect(await invoke(first, "publish", event)).toEqual({
        status: "published",
      });
      const reader = await open(bob);
      expect((await claim(reader)).state).toBe("ready");
      expect(await invoke(first, "allocate", { ...event, allocation })).toEqual(
        { status: "existing" },
      );
      expect(
        await invoke(first, "allocate", {
          ...event,
          allocation: { ...allocation, publicationSeed: "replacement" },
        }),
      )
        .toEqual({ status: "conflict", reason: "allocation" });
      expect(await invoke(first, "publish", event)).toEqual({
        status: "published",
      });
      expect((await claim(first)).allocation).toEqual(allocation);
    });
  });

  for (
    const [stored, reason] of [
      [{
        creator: alice.did(),
        attempt: "retained",
        state: "future-state",
        future: 42,
      }, "unsupported-state"],
      [
        { creator: alice.did(), attempt: "retained", state: "allocated" },
        "malformed-state",
      ],
      [{
        creator: alice.did(),
        attempt: "retained",
        state: "reserved",
        allocation: null,
      }, "malformed-state"],
    ] as const
  ) {
    it(`retains ${JSON.stringify(stored)} with a typed conflict`, async () => {
      await withDirectory(async (open) => {
        const first = await open(alice);
        const raw = await backingClaims(first);
        expect(
          (await first.runtime.editWithRetry((tx) =>
            raw.withTx(tx).set({ [MEETING]: stored })
          )).error,
        ).toBeUndefined();
        const event = { meeting: MEETING, attempt: "retained" };
        expect(await invoke(first, "reserve", event)).toEqual({
          status: "conflict",
          reason,
        });
        expect(
          await invoke(first, "allocate", {
            ...event,
            allocation: { space: "did:key:room", publicationSeed: "seed" },
          }),
        )
          .toEqual({ status: "conflict", reason });
        expect(await invoke(first, "publish", event)).toEqual({
          status: "conflict",
          reason,
        });
        expect(await raw.pull()).toEqual({ [MEETING]: stored });
      });
    });
  }
});
