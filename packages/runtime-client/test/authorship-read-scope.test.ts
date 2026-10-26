/**
 * What an authorship observation depends on in the worker: the author cell's
 * claim fields and its label, the value cell's position and its label, and
 * nothing else either document holds or links. Each case drives a real
 * `RuntimeClient` over a `MessageChannel` to a real processor serving a
 * runtime over emulated storage, so the handles are the ones a host binds, and
 * the subscriptions the worker's own.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/data-model";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { type Cell, KeepAsCell, Runtime } from "@commonfabric/runner";
import type { JSONSchema } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import {
  type AuthorshipObservation,
  type CfcAuthorshipState,
  observeAuthorship,
} from "@/authorship.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { createCellRef } from "@/backends/utils.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("authorship-read-scope", {
  implementation: "noble",
});
const home = signer.did();
const profileSpace =
  (await Identity.fromPassphrase("authorship-read-scope profile", {
    implementation: "noble",
  })).did();
const room = (await Identity.fromPassphrase("authorship-read-scope room", {
  implementation: "noble",
})).did();
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

/**
 * A client attached over a channel to a processor serving `runtime`, as a
 * page's client is to its worker.
 */
async function attachedClient(runtime: Runtime): Promise<RuntimeClient> {
  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
          identity: signer,
          space: home,
        }) as unknown as RuntimeProcessor,
      ),
  });
  await clients.handleMessage(
    clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: { apiUrl, identity: { placeholder: true }, spaceDid: home },
        },
      } as never),
    }),
  );
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  return await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: home },
  );
}

/** The part of a profile a room reads, as `fabrichat/schemas.tsx` types it. */
const chatProfileSchema = {
  type: "object",
  properties: { name: { type: "string" }, avatar: { type: "string" } },
} as const;

/**
 * A runtime holding, in three spaces, what a message's author link reaches:
 * the message, the author's profile, the profile's inbox in the author's
 * home, and the catalog that inbox links. A client is attached over a
 * channel.
 */
async function messageByAProfile() {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
  });
  const write = async (
    space: string,
    id: string,
    value: unknown,
    schema?: unknown,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space as never, id, schema as never);
    cell.withTx(tx).setRawUntyped(value as never);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The commit failed: ${error.name}`);
    await runtime.scheduler.idleWithPendingCommits();
    return runtime.getCell(space as never, id, schema as never);
  };
  const catalog = await write(home, "catalog", { entries: {} });
  const inbox = await write(home, "inbox", {
    name: "inbox",
    catalog: catalog.getAsLink(),
    offers: [],
  });
  const profile = await write(profileSpace, "profile", {
    name: "an author",
    avatar: "a",
    inbox: {
      piece: inbox.getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      }),
    },
  }, chatProfileSchema);
  const message = await write(room, "message", {
    authorProfile: profile.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    }),
    body: "hello",
    sentAt: 1,
  });

  const client = await attachedClient(runtime);

  const idOf = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;
  return {
    runtime,
    write,
    /** The handles a host binds: the message's `body` and `authorProfile`. */
    handles: () => {
      const handle = client.getCellFromRef<
        { body: string; authorProfile: unknown }
      >(createCellRef(message));
      return { value: handle.key("body"), author: handle.key("authorProfile") };
    },
    ids: {
      message: idOf(message),
      profile: idOf(profile),
      inbox: idOf(inbox),
      catalog: idOf(catalog),
    },
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

/**
 * A runtime holding a message whose `body` links an attachment, which links
 * an archive in turn, and whose label says the author wrote the body; the
 * author's profile is labeled as representing her. The body is a record
 * holding the link, or with `shape: "list"` a list of it. `handles()` keys
 * the message's own handle, which carries no schema, as the Weaver relay
 * keys the message a link opens, or with `under` the handle read under that
 * schema. `relabel()` stores the same body under a label naming another
 * author.
 */
async function messageWithALinkingBody(shape: "record" | "list" = "record") {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
  });
  const cause = `authorship-read-scope-${crypto.randomUUID()}`;
  const cellAt = (name: string) =>
    runtime.getCell<unknown>(home, `${cause}-${name}`);
  const profile = cellAt("profile");
  const message = cellAt("message");
  const attachment = cellAt("attachment");
  const archive = cellAt("archive");
  const ada = (await Identity.fromPassphrase("authorship-read-scope ada", {
    implementation: "noble",
  })).did();

  /** Stores `value` in `cell`'s document with one integrity atom at `path`. */
  const seed = (
    tx: ReturnType<Runtime["edit"]>,
    cell: Cell<unknown>,
    value: unknown,
    path: string[],
    atom: { kind: string; subject: string },
  ) =>
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path, label: { integrity: [atom] } }],
        },
      },
    } as FabricValue);
  const commit = async (edit: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    edit(tx);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The commit failed: ${error.name}`);
    await runtime.scheduler.idleWithPendingCommits();
  };
  const messageValue = {
    body: shape === "record"
      ? { text: "see the attachment", attachment: attachment.getAsLink() }
      : [attachment.getAsLink()],
    authorProfile: profile.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    }),
  };
  await commit((tx) => {
    writeSeedEnvelopeDoc(tx, home);
    archive.withTx(tx).setRawUntyped({ entries: {} } as never);
    attachment.withTx(tx).setRawUntyped(
      { title: "notes", archive: archive.getAsLink() } as never,
    );
    seed(tx, profile, { name: "Ada" }, [], {
      kind: "represents-principal",
      subject: ada,
    });
    seed(tx, message, messageValue, ["body"], {
      kind: "authored-by",
      subject: ada,
    });
  });

  const client = await attachedClient(runtime);
  const idOf = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;
  return {
    runtime,
    /** The message's `body` and `authorProfile`, keyed off its handle. */
    handles: (under?: JSONSchema) => {
      const bare = client.getCellFromRef<Record<string, unknown>>(
        createCellRef(message),
      );
      const handle = under === undefined
        ? bare
        : bare.asSchema<Record<string, unknown>>(under);
      return { value: handle.key("body"), author: handle.key("authorProfile") };
    },
    /** Rewrites what the attachment links, the message left as it was. */
    archiveMore: () =>
      commit((tx) => {
        archive.withTx(tx).setRawUntyped(
          { entries: { added: attachment.getAsLink() } } as never,
        );
      }),
    relabel: () =>
      commit((tx) => {
        seed(tx, message, messageValue, ["body"], {
          kind: "authored-by",
          subject: signer.did(),
        });
      }),
    ids: {
      message: idOf(message),
      attachment: idOf(attachment),
      archive: idOf(archive),
    },
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

describe("observeAuthorship() in the worker", () => {
  it("depends on the author's claim fields and label, not on what the author's document links", async () => {
    await using fixture = await messageByAProfile();
    const { runtime, ids } = fixture;
    const reports: AuthorshipObservation[] = [];
    // Resolved as reports arrive: `reported(n)` settles once the observation
    // has reported `n` times, at once when it already has.
    const watchers: (() => void)[] = [];
    const reported = (count: number): Promise<void> =>
      new Promise((resolve) => {
        const check = () => {
          if (reports.length >= count) resolve();
        };
        check();
        watchers.push(check);
      });
    const { value, author } = fixture.handles();
    const cancel = observeAuthorship(value, author, (observation) => {
      reports.push(observation);
      for (const watcher of watchers) watcher();
    });
    try {
      await reported(1);
      await runtime.scheduler.idleWithPendingCommits();

      // The worker's subscriptions that read the author's profile: the one
      // on the message's `authorProfile`, and any the observation opened on
      // the profile itself. None reaches past the profile's claim fields.
      const authorSinks = runtime.scheduler.getGraphSnapshot().nodes.filter((
        node,
      ) =>
        node.id.startsWith("sink:") &&
        [...(node.reads ?? []), ...(node.shallowReads ?? [])].some((read) =>
          read.includes(ids.profile)
        )
      );
      expect(authorSinks.length).toBeGreaterThan(0);
      for (const sink of authorSinks) {
        const addresses = [...(sink.reads ?? []), ...(sink.shallowReads ?? [])];
        expect(addresses.some((read) => read.includes(ids.inbox))).toBe(false);
        expect(addresses.some((read) => read.includes(ids.catalog))).toBe(
          false,
        );
        // The profile's own document is read at its claim fields, never
        // whole: a whole read is a recursive one of its `value`.
        expect(
          (sink.reads ?? []).some((read) =>
            read.includes(ids.profile) && /\/value$/.test(read)
          ),
        ).toBe(false);
      }
      expect(reports.at(-1)?.authorClaim).toEqual({ name: "an author" });

      // What the profile links changes: no subscription on the message is
      // woken. The trace is the check; a report could not show a re-run that
      // delivered the same value again, since the gate drops those.
      const before = reports.length;
      runtime.scheduler.setTriggerTraceEnabled(true);
      await fixture.write(home, "catalog", {
        entries: { added: runtime.getCell(home, "inbox").getAsLink() },
      });
      await fixture.write(home, "inbox", {
        name: "inbox",
        catalog: runtime.getCell(home, "catalog").getAsLink(),
        offers: [{ from: "someone" }],
      });
      await runtime.scheduler.idleWithPendingCommits();
      const woken = runtime.scheduler.getTriggerTrace().flatMap((entry) =>
        entry.triggered.filter((record) =>
          record.actionId.startsWith("sink:") &&
          record.actionId.includes(ids.message)
        )
      );
      expect(woken).toEqual([]);

      // The claim itself changes: the observation reports it. Its report
      // travels the channel the writes above would have reported on, in
      // order, so once it is here nothing of theirs is still to come.
      await fixture.write(profileSpace, "profile", {
        name: "a renamed author",
        avatar: "a",
        inbox: {
          piece: runtime.getCell(home, "inbox").getAsLink({
            includeSchema: true,
            keepAsCell: KeepAsCell.All,
          }),
        },
      }, chatProfileSchema);
      await reported(before + 1);
      expect(reports.length).toBe(before + 1);
      expect(reports.at(-1)?.authorClaim).toEqual({ name: "a renamed author" });
    } finally {
      cancel();
    }
  });

  describe("a value bound with no schema", () => {
    /**
     * Keeps the worker's reports of a read with no shape, made as the read
     * opens, while it is in scope; every other error still prints.
     */
    const watchEmptySchemaReports = () => {
      const print = console.error;
      const reports: string[] = [];
      const errors = stub(console, "error", (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        if (line.includes("EMPTY SCHEMA SUBSCRIPTION")) reports.push(line);
        else print(...args);
      });
      return { reports, [Symbol.dispose]: () => errors.restore() };
    };

    /**
     * Observes the fixture's message as `under` reads it, collecting each
     * verdict: `next(state)` resolves once the latest verdict is `state`.
     */
    const observe = (
      fixture: Awaited<ReturnType<typeof messageWithALinkingBody>>,
      under?: JSONSchema,
    ) => {
      const states: CfcAuthorshipState[] = [];
      const waiting: Array<
        { state: CfcAuthorshipState; resolve: () => void }
      > = [];
      const next = (state: CfcAuthorshipState): Promise<void> =>
        new Promise((resolve) => {
          if (states.at(-1) === state) resolve();
          else waiting.push({ state, resolve });
        });
      const { value, author } = fixture.handles(under);
      const cancel = observeAuthorship(value, author, (observation) => {
        states.push(observation.state);
        for (const waiter of waiting.splice(0)) {
          if (waiter.state === observation.state) waiter.resolve();
          else waiting.push(waiter);
        }
      });
      return { next, cancel };
    };

    /**
     * What the subscriptions on the message read, each address once: `deep`
     * the reads that depend on what is below them, `shallow` the rest.
     */
    const messageReads = (
      fixture: Awaited<ReturnType<typeof messageWithALinkingBody>>,
    ) => {
      const sinks = fixture.runtime.scheduler.getGraphSnapshot().nodes.filter((
        node,
      ) =>
        node.id.startsWith("sink:") && node.id.includes(fixture.ids.message)
      );
      expect(sinks.length).toBeGreaterThan(0);
      return {
        deep: sinks.flatMap((sink) => sink.reads ?? []),
        shallow: sinks.flatMap((sink) => sink.shallowReads ?? []),
      };
    };
    const readsOf = (addresses: string[], id: string) =>
      addresses.filter((address) => address.includes(id));

    /** The message's sinks that `write` wakes. */
    const wokenBy = async (
      fixture: Awaited<ReturnType<typeof messageWithALinkingBody>>,
      write: () => Promise<void>,
    ) => {
      fixture.runtime.scheduler.setTriggerTraceEnabled(true);
      await write();
      return fixture.runtime.scheduler.getTriggerTrace().flatMap((entry) =>
        entry.triggered.filter((record) =>
          record.actionId.startsWith("sink:") &&
          record.actionId.includes(fixture.ids.message)
        )
      );
    };

    it("depends on the value's position and label, not on what a record there links", async () => {
      using emptySchema = watchEmptySchemaReports();
      await using fixture = await messageWithALinkingBody();
      const { runtime, ids } = fixture;
      const { next, cancel } = observe(fixture);
      try {
        // The label on the body is the message's, and it is read as before.
        await next("verified");
        await runtime.scheduler.idleWithPendingCommits();
        expect(emptySchema.reports).toEqual([]);
        const { deep, shallow } = messageReads(fixture);
        for (const id of [ids.attachment, ids.archive]) {
          expect(readsOf([...deep, ...shallow], id)).toEqual([]);
        }

        // What the attachment links changes: no subscription on the message
        // is woken.
        expect(await wokenBy(fixture, fixture.archiveMore)).toEqual([]);

        // The body's label alone changes: the verdict follows it.
        await fixture.relabel();
        await next("unverified");
      } finally {
        cancel();
      }
    });

    it("reads no further when the message's handle reads under `true`, which narrows to `{}` at the value", async () => {
      // The worker narrows the ancestor's schema at the key, so the value's
      // own `ref()` carries none: the ancestor's is the one that decides.

      using emptySchema = watchEmptySchemaReports();
      await using fixture = await messageWithALinkingBody();
      const { ids } = fixture;
      const { next, cancel } = observe(fixture, true);
      try {
        await next("verified");
        await fixture.runtime.scheduler.idleWithPendingCommits();
        expect(emptySchema.reports).toEqual([]);
        const { deep, shallow } = messageReads(fixture);
        for (const id of [ids.attachment, ids.archive]) {
          expect(readsOf([...deep, ...shallow], id)).toEqual([]);
        }
      } finally {
        cancel();
      }
    });

    it("reads a list's elements as references, their targets at their roots alone", async () => {
      // An element is a link, and reading it as a reference resolves it, so
      // its target's root is read shallowly: whether something is there.
      // Nothing below that root is read, and nothing it links.

      using emptySchema = watchEmptySchemaReports();
      await using fixture = await messageWithALinkingBody("list");
      const { ids } = fixture;
      const { next, cancel } = observe(fixture);
      try {
        await next("verified");
        await fixture.runtime.scheduler.idleWithPendingCommits();
        expect(emptySchema.reports).toEqual([]);
        const { deep, shallow } = messageReads(fixture);
        expect(readsOf(deep, ids.attachment)).toEqual([]);
        expect(
          readsOf(shallow, ids.attachment).every((address) =>
            address.endsWith("/value")
          ),
        ).toBe(true);
        expect(readsOf([...deep, ...shallow], ids.archive)).toEqual([]);
        expect(await wokenBy(fixture, fixture.archiveMore)).toEqual([]);
      } finally {
        cancel();
      }
    });
  });
});
