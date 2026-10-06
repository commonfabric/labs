/**
 * `grantSpaceAccess()` and `revokeSpaceAccess()` in a handler the serving loop
 * runs. Each case stands up a room piece, whose list alice owns and bob may
 * write, and an inbox piece in a space of alice's own that the room's `grant`
 * handler sends a notice to, on flag-on clients. The serving loop then runs
 * the room's handlers as a delegating service identity over the loopback
 * plane, as it does in production. Every client is flag-on, so each event a
 * client fires is also run on that client as its speculative echo.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { StreamEventsDocValue } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { stageSpaceAccessChanges } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";

const roomSigner = await Identity.fromPassphrase("served access change room");
const room = roomSigner.did() as MemorySpace;
const inboxSigner = await Identity.fromPassphrase("served access change inbox");
const inbox = inboxSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "served access change service",
);
const aliceSigner = await Identity.fromPassphrase("served access change alice");
const bobSigner = await Identity.fromPassphrase("served access change bob");
const carolSigner = await Identity.fromPassphrase("served access change carol");
const aclId = `of:${room}`;

/** The room's list to start with: alice owns it, and bob may write. */
const genesisAcl = {
  [aliceSigner.did()]: "OWNER",
  [bobSigner.did()]: "WRITE",
};

/**
 * A room whose `grant` handler sets an entry in the room's list, records a
 * note, and sends a notice to the inbox it is given; whose `revoke` handler
 * removes an entry and records a note; and whose `relay` handler sends its
 * event on to `grant`.
 */
const ROOM_PATTERN = [
  "import {",
  "  grantSpaceAccess, handler, pattern, revokeSpaceAccess, Stream, Writable,",
  "} from 'commonfabric';",
  "import type { DID, SpaceGrantLevel } from 'commonfabric';",
  "type Change = { principal: DID; level?: SpaceGrantLevel };",
  "type Notice = { principal: DID };",
  "const grant = handler<",
  "  Change, { notes: Writable<string[]>; inbox: Stream<Notice> }",
  ">((event, { notes, inbox }) => {",
  "  grantSpaceAccess(notes, event.principal, event.level ?? 'WRITE');",
  "  notes.push(`granted ${event.principal}`);",
  "  inbox.send({ principal: event.principal });",
  "});",
  "const revoke = handler<Change, { notes: Writable<string[]> }>(",
  "  (event, { notes }) => {",
  "    revokeSpaceAccess(notes, event.principal);",
  "    notes.push(`revoked ${event.principal}`);",
  "  },",
  ");",
  "const relay = handler<Change, { grant: Stream<Change> }>(",
  "  (event, { grant }) => { grant.send(event); },",
  ");",
  "export default pattern<",
  "  { notes: Writable<string[]>; inbox: Stream<Notice> },",
  "  {",
  "    notes: string[];",
  "    grant: Stream<Change>;",
  "    revoke: Stream<Change>;",
  "    relay: Stream<Change>;",
  "  }",
  ">(({ notes, inbox }) => {",
  "  const grantStream = grant({ notes, inbox });",
  "  return {",
  "    notes,",
  "    grant: grantStream,",
  "    revoke: revoke({ notes }),",
  "    relay: relay({ grant: grantStream }),",
  "  };",
  "});",
].join("\n");

/** An inbox whose `receive` handler records each notice's principal. */
const INBOX_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "type Notice = { principal: string };",
  "const receive = handler<Notice, { received: Writable<string[]> }>(",
  "  (event, { received }) => { received.push(event.principal); },",
  ");",
  "export default pattern<",
  "  { received: Writable<string[]> },",
  "  { received: string[]; receive: Stream<Notice> }",
  ">(({ received }) => ({ received, receive: receive({ received }) }));",
].join("\n");

/** `payload` as an event the renderer marked as a trusted gesture. */
function gesture<T extends Record<string, unknown>>(payload: T): T {
  const event = {
    ...payload,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "MembersSurface",
        eventIntegrity: ["MembersSurface"],
        uiContractDataset: { uiAction: "ChangeAccess" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

/** Every entry of every stream sidecar `engine` holds. */
const allEntriesIn = (
  engine: Engine.Engine,
): NonNullable<StreamEventsDocValue["entries"]> =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).flatMap(({ id }) =>
    (Engine.read(engine, { id })?.value as StreamEventsDocValue).entries ?? []
  );

/** The entries whose payload has `kind`, in any stream sidecar of `engine`. */
const entriesOfKind = (engine: Engine.Engine, kind: string) =>
  allEntriesIn(engine).filter((entry) =>
    (entry.payload as { kind?: string } | undefined)?.kind === kind
  );

/** The commits after genesis that wrote the room's list, in order. */
const aclCommitsIn = (engine: Engine.Engine) =>
  engine.database.prepare(
    `SELECT c.seq AS seq, c.class AS class, ` +
      `c.acting_principal AS actingPrincipal, ` +
      `c.capability_ref AS capabilityRef ` +
      `FROM "commit" c JOIN revision r ON r.commit_seq = c.seq ` +
      `WHERE r.id = ? AND c.seq > 1 ORDER BY c.seq`,
  ).all(aclId) as Array<{
    seq: number;
    class: string;
    actingPrincipal: string | null;
    capabilityRef: string | null;
  }>;

/** The room's notes, as the store holds them. */
const notesIn = (
  engine: Engine.Engine,
  result: ReturnType<Runtime["getCell"]>,
): unknown =>
  (Engine.read(engine, {
    id: result.key("notes").resolveAsCell().getAsNormalizedFullLink().id,
  })?.value as { notes?: unknown } | undefined)?.notes;

/** The seq of the commit carrying `eventId`'s consequences. */
const consequenceSeqIn = (engine: Engine.Engine, eventId: string) =>
  (engine.database.prepare(
    `SELECT seq FROM "commit" WHERE consequence_of LIKE ?`,
  ).get(`%"${eventId}"%`) as { seq: number } | undefined)?.seq;

describe("executor-space-access-change", () => {
  for (const mode of ["off", "enforce"] as const) {
    describe(`under memory ACL mode \`${mode}\``, () => {
      let storeSeq = 0;
      let server: MemoryV2Server.Server;
      let cleanups: Array<() => Promise<void>>;
      let servingRuntime: Runtime | undefined;

      beforeEach(async () => {
        storeSeq += 1;
        server = new MemoryV2Server.Server({
          store: new URL(`memory://served-access-change-${mode}-${storeSeq}`),
          subscriptionRefreshDelayMs: 0,
          authorizeSessionOpen: authorizeLoopbackSessionOpen,
          sessionOpenAuth: { audience: "did:key:z6Mk-runner-emulated-memory" },
          acl: { mode, delegatingDids: [serviceSigner.did()] },
        });
        cleanups = [];
        servingRuntime = undefined;
        for (
          const [space, acl] of [
            [room, genesisAcl],
            [inbox, { [aliceSigner.did()]: "OWNER" }],
          ] as const
        ) {
          Engine.applyCommit(await server.engineForSpace(space), {
            sessionId: "served-access-change-genesis",
            space,
            principal: space,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${space}`,
                value: { value: acl },
              }],
            },
          });
        }
      });

      afterEach(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await server.close();
      });

      /** A client runtime acting as `signer`, with server execution on. */
      const newClient = (signer: Identity): Runtime => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        cleanups.push(async () => {
          await runtime.dispose();
          await manager.close();
        });
        return runtime;
      };

      /**
       * Compiles `source` through `client`, runs it in `space` over
       * `argument`, and demands its result, which it returns.
       */
      const runPiece = async (
        client: Runtime,
        space: MemorySpace,
        name: string,
        source: string,
        argument: Record<string, unknown>,
      ) => {
        const compiled = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: source }],
        }, { space });
        const argumentCell = client.getCell(space, `${name}-arg`);
        const result = client.getCell<Record<string, unknown>>(
          space,
          `${name}-result`,
          compiled.resultSchema,
        );
        await argumentCell.sync();
        await result.sync();
        {
          const tx = client.edit();
          argumentCell.withTx(tx).set(argument);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        {
          const tx = client.edit();
          client.run(tx, compiled, argumentCell, result);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        const cancelDemand = result.sink(() => {});
        cleanups.push(() => Promise.resolve(cancelDemand()));
        await client.idle();
        await client.storageManager.synced();
        return { compiled, result };
      };

      /**
       * Stands the room and the inbox up on alice's client and returns them,
       * with the room's result as `client` sees it.
       */
      const standUpRoom = async () => {
        const client = newClient(aliceSigner);
        const inboxPiece = await runPiece(
          client,
          inbox,
          "inbox",
          INBOX_PATTERN,
          { received: [] },
        );
        const roomPiece = await runPiece(client, room, "room", ROOM_PATTERN, {
          notes: [],
          inbox: inboxPiece.result.key("receive"),
        });
        const roomFor = async (other: Runtime) => {
          const result = other.getCell<Record<string, unknown>>(
            room,
            "room-result",
            roomPiece.compiled.resultSchema,
          );
          await result.sync();
          return result;
        };
        return {
          client,
          result: roomPiece.result,
          roomFor,
          engine: await server.engineForSpace(room),
          inboxEngine: await server.engineForSpace(inbox),
        };
      };

      /** Starts the serving loop over the memory server. */
      const startHost = () => {
        const host = new ExecutorHost({
          server,
          serviceIdentity: serviceSigner.did(),
          ensureSpaceRoots: false,
          // deno-lint-ignore require-await
          createRuntime: async (servedSpace) => {
            const manager = LoopbackStorageManager.connect(server, {
              as: serviceSigner,
              servingHomeSpace: servedSpace,
            });
            const runtime = new Runtime({
              apiUrl: new URL(import.meta.url),
              storageManager: manager,
              servingPosture: true,
              experimental: { serverExecution: true },
            });
            if (servedSpace === room) servingRuntime = runtime;
            return {
              runtime,
              dispose: async () => {
                await runtime.dispose();
                await manager.close();
              },
            };
          },
          policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
        });
        cleanups.push(() => host.close());
      };

      /**
       * Sends `event` on the stream `key` of `result` from `client`, and
       * resolves with the entry of `event`'s `kind` on that stream once every
       * entry of that kind is consequenced.
       */
      const sendAndSettle = async (
        client: Runtime,
        result: ReturnType<Runtime["getCell"]>,
        key: string,
        event: Record<string, unknown> & { kind: string },
      ) => {
        const engine = await server.engineForSpace(room);
        result.key(key).send(event);
        await client.idle();
        await client.storageManager.synced();
        await awaitAdmitted(server, () => {
          const entries = entriesOfKind(engine, event.kind);
          return entries.length > 0 &&
            entries.every((entry) => entry.consequenced === true);
        });
        return entriesOfKind(engine, event.kind)[0];
      };

      it("commits a gesture's grant as the actor's own delegated commit of the list, before the notice it sends", async () => {
        const { client, result, engine, inboxEngine } = await standUpRoom();
        startHost();

        const entry = await sendAndSettle(
          client,
          result,
          "grant",
          gesture({
            kind: "grant",
            principal: carolSigner.did(),
            level: "OWNER",
          }),
        );
        await awaitAdmitted(
          server,
          () =>
            allEntriesIn(inboxEngine).some((delivered) =>
              (delivered.payload as { principal?: string } | undefined)
                ?.principal === carolSigner.did()
            ),
        );

        expect(entry.error).toBeUndefined();
        expect(Engine.read(engine, { id: aclId })?.value).toEqual({
          ...genesisAcl,
          [carolSigner.did()]: "OWNER",
        });
        // One commit changed the list, the served run's, made as alice under
        // the event's grant. A flag-on client's echo of the handler commits
        // none of its own.
        const aclCommits = aclCommitsIn(engine);
        expect(aclCommits.map(({ seq: _seq, ...commit }) => commit)).toEqual([{
          class: "authored",
          actingPrincipal: aliceSigner.did(),
          capabilityRef: `event-consequence:${entry.eventId}`,
        }]);
        // The commit carrying the handler's consequences, and with them the
        // outbox row the notice is delivered from, comes after it.
        const consequenceSeq = consequenceSeqIn(engine, entry.eventId);
        expect(consequenceSeq).toBeGreaterThan(aclCommits[0].seq);
        expect(notesIn(engine, result)).toEqual([
          `granted ${carolSigner.did()}`,
        ]);
      });

      it("commits a gesture's revoke of an entry", async () => {
        const { client, result, engine } = await standUpRoom();
        startHost();

        const entry = await sendAndSettle(
          client,
          result,
          "revoke",
          gesture({ kind: "revoke", principal: bobSigner.did() }),
        );

        expect(entry.error).toBeUndefined();
        expect(Engine.read(engine, { id: aclId })?.value).toEqual({
          [aliceSigner.did()]: "OWNER",
        });
        expect(
          aclCommitsIn(engine).map(({ actingPrincipal }) => actingPrincipal),
        )
          .toEqual([aliceSigner.did()]);
      });

      it("fails a `WRITE` member's grant on its entry, committing nothing of that run", async () => {
        const { result, roomFor, engine } = await standUpRoom();
        startHost();
        const bobClient = newClient(bobSigner);

        const entry = await sendAndSettle(
          bobClient,
          await roomFor(bobClient),
          "grant",
          gesture({
            kind: "takeover",
            principal: carolSigner.did(),
            level: "OWNER",
          }),
        );

        expect(entry.error).toContain(
          `which ${bobSigner.did()} does not hold`,
        );
        expect(Engine.read(engine, { id: aclId })?.value).toEqual(genesisAcl);
        expect(aclCommitsIn(engine)).toEqual([]);
        expect(notesIn(engine, result)).toEqual([]);
      });

      it("fails a grant for an event that is not a trusted gesture on its entry", async () => {
        const { client, result, engine } = await standUpRoom();
        startHost();

        const entry = await sendAndSettle(client, result, "grant", {
          kind: "unmarked",
          principal: carolSigner.did(),
        });

        expect(entry.error).toContain(
          "requires the handler's event to be a trusted gesture",
        );
        expect(Engine.read(engine, { id: aclId })?.value).toEqual(genesisAcl);
        expect(aclCommitsIn(engine)).toEqual([]);
      });

      it("fails the grant a handler relays a gesture's event to, which carries no gesture", async () => {
        const { client, result, engine } = await standUpRoom();
        startHost();

        // The relayed event reaches `grant` as a link to the relay's own
        // event, so its entry is found by its stream.
        const grantStream = result.key("grant").resolveAsCell()
          .getAsNormalizedFullLink().id;
        const grantEntries = () =>
          allEntriesIn(engine).filter((entry) =>
            entry.stream.id === grantStream
          );
        result.key("relay").send(
          gesture({ kind: "relayed", principal: carolSigner.did() }),
        );
        await client.idle();
        await client.storageManager.synced();
        await awaitAdmitted(
          server,
          () =>
            grantEntries().length === 1 &&
            grantEntries()[0].consequenced === true,
        );

        expect(grantEntries()[0].error).toContain(
          "requires the handler's event to be a trusted gesture",
        );
        expect(Engine.read(engine, { id: aclId })?.value).toEqual(genesisAcl);
      });

      it("refuses at the seal a served change made as an actor without `OWNER`, committing nothing of that run", async () => {
        const { result, roomFor, engine } = await standUpRoom();
        startHost();
        const bobClient = newClient(bobSigner);
        const bobRoom = await roomFor(bobClient);
        // A first event on the stream warms the serving loop on it, so that
        // the probe below replaces the room's own `grant` handler there.
        const warmup = await sendAndSettle(bobClient, bobRoom, "grant", {
          kind: "warmup",
          principal: carolSigner.did(),
        });
        const serving = servingRuntime!;
        const notesLink = result.key("notes").getAsNormalizedFullLink();
        const cancelProbe = serving.scheduler.addEventHandler(
          (tx) => {
            stageSpaceAccessChanges(
              tx,
              new Map([[room, [{
                principal: carolSigner.did(),
                level: "OWNER" as const,
                actor: bobSigner.did(),
              }]]]),
            );
            serving.getCellFromLink<string[]>(notesLink).withTx(tx)
              .push("probed");
          },
          {
            space: room,
            id: warmup.stream.id as URI,
            path: [...warmup.stream.path],
            scope: warmup.stream.scope ?? "space",
          },
        );
        try {
          const entry = await sendAndSettle(bobClient, bobRoom, "grant", {
            kind: "probe",
            principal: carolSigner.did(),
          });

          expect(entry.error).toContain(
            `The change to the access list of ${room} was refused`,
          );
          expect(Engine.read(engine, { id: aclId })?.value).toEqual(
            genesisAcl,
          );
          expect(notesIn(engine, result)).toEqual([]);
        } finally {
          cancelProbe();
        }
      });

      it("commits no change to the list from a client's echo of a gesture's grant", async () => {
        const { client, result, engine } = await standUpRoom();

        result.key("grant").send(
          gesture({ kind: "echoed", principal: carolSigner.did() }),
        );
        await client.idle();
        await client.storageManager.synced();

        // The echo ran: its note reads back through the client's overlay. A
        // change it committed would have committed before that note sealed.
        expect(result.key("notes").get()).toEqual([
          `granted ${carolSigner.did()}`,
        ]);
        expect(Engine.read(engine, { id: aclId })?.value).toEqual(genesisAcl);
        expect(aclCommitsIn(engine)).toEqual([]);
      });
    });
  }
});
