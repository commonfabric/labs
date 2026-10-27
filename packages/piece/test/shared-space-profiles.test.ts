/**
 * Holds Home's record of which of a person's profiles acts in each social
 * space to what its readers rely on. Home is the real pattern, compiled from
 * this checkout, with two profiles its own `createProfile` made and the
 * private inbox its own `ensurePrivateInbox` made. Offers reach it through the
 * host's share intake, and a host's own registrations through Home's
 * `registerSharedSpace`. A second host is a runtime of its own over the same
 * store, as a person's second device is.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { sharedSpaceProfileViewSchema } from "@commonfabric/home-schemas";
import type { FabricValue } from "@commonfabric/data-model";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getDerivedInternalCellLink,
  type IExtendedStorageTransaction,
  type JSONSchema,
  type MemorySpace,
  type NormalizedFullLink,
  type Pattern,
  Runtime,
  type RuntimeProgram,
  sendEvent,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import {
  asStoredValue,
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  storedList,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  type ShareIntake,
  startShareIntakeOf,
} from "../src/ops/share-intake.ts";
import { installCustomRoot } from "./install-custom-root.ts";

const identity = await Identity.fromPassphrase("shared-space profiles owner");

/** A principal who is not the owner, and who makes a profile of their own. */
const stranger = await Identity.fromPassphrase(
  "shared-space profiles stranger principal",
);

/** The principal the offers name as their sender. */
const sender = (await Identity.fromPassphrase("shared-space profiles sender"))
  .did();

/** A profile space that is none of the owner's. */
const strangersProfileSpace =
  (await Identity.fromPassphrase("shared-space profiles stranger")).did();

/** The origin of the host the runtimes are served by. */
const HOST = "https://home.example";

/**
 * A stand-in for a Loom, with the public composition vetting a `loom` space
 * checks of its root: `panels`, and the `addPanel` and `removePanel` streams.
 */
const loomProgram: RuntimeProgram = {
  main: "/loom.tsx",
  files: [{
    name: "/loom.tsx",
    contents: `
import { handler, pattern, Writable } from "commonfabric";

type Panel = { title: string };

const addPanel = handler<{ panel: Panel }, { panels: Writable<Panel[]> }>(
  (event, { panels }) => {
    panels.push(event.panel);
  },
);

const removePanel = handler<{ panel: Panel }, { panels: Writable<Panel[]> }>(
  (event, { panels }) => {
    panels.set(panels.get().filter((each) => each.title !== event.panel.title));
  },
);

export default pattern(() => {
  const panels = new Writable<Panel[]>([]).for("panels");
  return {
    panels,
    addPanel: addPanel({ panels }),
    removePanel: removePanel({ panels }),
  };
});`,
  }],
};

/** The parts of Home these cases read, links read as links. */
const homeSchema = {
  type: "object",
  properties: {
    sharedSpaces: {
      type: "object",
      properties: { profiles: sharedSpaceProfileViewSchema },
    },
    sharedSpaceCatalog: {
      type: "object",
      properties: {
        entries: { type: "object", additionalProperties: true },
        offers: { type: "object", additionalProperties: true },
      },
    },
    sharedSpaceProfiles: { type: "object", additionalProperties: true },
    privateInbox: {
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    },
    profiles: {
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
    },
  },
} as const satisfies JSONSchema;

/** An offer as an inbox holds it. */
type Row = Record<string, unknown>;

/** A private inbox, its offers read as they are stored. */
const inboxSchema = {
  type: "object",
  properties: {
    offers: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const satisfies JSONSchema;

/** A profile, read for its name. */
const namedSchema = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

/** One runtime over the shared store, acting as the owner. */
interface Host {
  runtime: Runtime;
  storage: EmulatedStorageManager;
  controller: PiecesController;
}

// One cache for every runtime this file makes, so that a pattern compiles
// once per file rather than once per case.
const moduleByteCache = createCompileByteCache();

describe("shared-space-profiles", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let hosts: Host[];
  let first: Host;
  let runtime: Runtime;
  let home: Cell<Record<string, unknown>>;
  let homeResultSchema: JSONSchema | undefined;
  let homePattern: Pattern;
  let homeProgram: RuntimeProgram;
  let inbox: Cell<unknown>;
  let personal: Cell<unknown>;
  let work: Cell<unknown>;
  let intake: ShareIntake | undefined;

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    hosts = [];
    first = await open();
    runtime = first.runtime;
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: new URL("../../patterns/system/home.tsx", import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: identity.did(),
      tx,
    });
    homeResultSchema = pattern.resultSchema;
    homePattern = pattern;
    homeProgram = program;
    home = runtime.getCell<Record<string, unknown>>(
      identity.did(),
      "shared-space profiles home",
      undefined,
      tx,
    );
    const result = runtime.run(tx, pattern, {}, home);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await first.controller.linkDefaultPattern(home);
    // The profile made first is the one `#profile` returns, so that `work`
    // can be retired.
    await create("Personal");
    await create("Work");
    [personal, work] = read(home).key("profiles").get() ?? [];
    await send("ensurePrivateInbox", {});
    const piece = read(home).key("privateInbox").key("piece").get();
    if (piece === undefined) throw new Error("Home made no private inbox.");
    inbox = piece.resolveAsCell();
  });

  afterEach(async () => {
    intake?.stop();
    intake = undefined;
    for (const each of hosts) {
      await each.controller.dispose();
      await each.storage.close();
    }
    await server.close();
  });

  /** Opens a runtime of its own over the shared store, as the owner. */
  async function open(): Promise<Host> {
    const storage = EmulatedStorageManager.connectTo(server, { as: identity });
    const runtime = new Runtime({
      moduleByteCache,
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    const controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    const host = { runtime, storage, controller };
    hosts.push(host);
    return host;
  }

  /** Disposes `host`, as a host that stops does. */
  async function close(host: Host): Promise<void> {
    hosts = hosts.filter((each) => each !== host);
    await host.controller.dispose();
    await host.storage.close();
  }

  /** `root`, a Home, read through the parts these cases read. */
  function read(root: Cell<unknown>) {
    return root.asSchema(homeSchema);
  }

  /** The space `cell` lives in. */
  function spaceOf(cell: Cell<unknown>): string {
    return cell.getAsNormalizedFullLink().space;
  }

  /** Sends `event` on Home's stream `stream`, and settles. */
  async function send(stream: string, event: unknown): Promise<void> {
    const tx = runtime.edit();
    home.withTx(tx).key(stream).send(event);
    await tx.commit().settled;
    await runtime.idle();
    await home.pull();
  }

  /** Creates a profile named `name`, as a click on the create form does. */
  async function create(name: string): Promise<void> {
    const event = {
      type: "click",
      name,
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfileCreateSurface",
        action: "CreateProfile",
      }),
    };
    markRendererTrustedEvent(event);
    await send("createProfile", event);
  }

  /**
   * Registers a space through Home's `registerSharedSpace`, as a host's own
   * join does, and returns the result Home's handling receipt holds.
   */
  async function register(event: Record<string, unknown>): Promise<unknown> {
    const handled = Promise.withResolvers<NormalizedFullLink | undefined>();
    sendEvent(
      home.key("registerSharedSpace"),
      event,
      (tx) => handled.resolve(tx.handlingReceiptLink),
    );
    const link = await handled.promise;
    await runtime.idle();
    await home.pull();
    return link === undefined
      ? undefined
      : await runtime.getCellFromLink(link).pull();
  }

  /** The registration of `space` a host makes from an offer it holds. */
  function registrationOf(
    space: string,
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { space, host: HOST, kind: "loom", ...fields };
  }

  /**
   * A space granting the sender `WRITE`, owned by the owner, declaring the
   * `loom` kind, whose root is a Loom stand-in.
   */
  async function loomSpace(): Promise<MemorySpace> {
    const space = await runtime.createSpace({
      grants: { [sender]: "WRITE" },
      spaceKind: "loom",
    });
    await replaceRoot(space);
    return space;
  }

  /** Runs a new Loom stand-in in `space` and links it as the space's root. */
  async function replaceRoot(space: MemorySpace): Promise<void> {
    // Disposing a controller disposes the runtime, which `afterEach` does
    // through the Home space's controller.
    const roots = new PiecesController(
      createSession({ identity, spaceDid: space }),
      runtime,
    );
    await roots.synced();
    await installCustomRoot(runtime, roots, loomProgram);
  }

  /** The root `space` links, by its address. */
  async function rootOf(space: MemorySpace): Promise<string | undefined> {
    const root = await runtime.getSpaceCell(space).key("defaultPattern")
      .asSchema({ type: "unknown", asCell: ["cell"] }).pull();
    return root?.getAsNormalizedFullLink().id;
  }

  /**
   * An offer of `space` from the sender keyed `id`, addressed to the profile
   * `to` when there is one.
   */
  function offerOf(space: string, id: string, to?: Cell<unknown>): Row {
    return {
      kind: "loom",
      id,
      space,
      host: HOST,
      ownerOrigin: HOST,
      title: `Loom ${id}`,
      from: sender,
      sharedAt: 1_700_000_000_000,
      receivedAt: 1_700_000_000_000,
      ...(to === undefined ? {} : { toProfile: { space: spaceOf(to) } }),
    };
  }

  /** Appends `rows` to the offers Home's private inbox holds. */
  async function deliver(rows: Row[]): Promise<void> {
    await runtime.editWithRetry((tx) => {
      // The inbox's `offers` is a redirect to the cell holding the list,
      // which is the one written.
      const offers = inbox.withTx(tx).asSchema(inboxSchema).key("offers")
        .resolveAsCell();
      offers.set([...offers.get() ?? [], ...rows]);
    });
  }

  /**
   * Starts the share intake over Home, if it has not started, and returns
   * once Home's catalog holds a receipt for the offer from the sender keyed
   * `id` and the intake has taken up all it was told of. Each read is a
   * `pull()` the catalog's sink wakes.
   */
  async function receivedThrough(id: string): Promise<void> {
    intake ??= startShareIntakeOf(runtime, home, identity.did());
    if (intake === undefined) throw new Error("Home has no stream");
    const offers = read(home).key("sharedSpaceCatalog").key("offers");
    let changed = Promise.withResolvers<void>();
    const cancel = offers.sink(() => {
      changed.resolve();
      changed = Promise.withResolvers<void>();
    });
    try {
      while (true) {
        const next = changed.promise;
        const held = await offers.pull() ?? {};
        if (Object.hasOwn(held, JSON.stringify([sender, id]))) break;
        await next;
      }
    } finally {
      cancel();
    }
    await intake.idle();
    await runtime.idle();
  }

  /**
   * The receipt Home's catalog holds for the offer keyed `id`, or `undefined`
   * when it holds none.
   */
  async function receiptOf(id: string): Promise<unknown> {
    const offers = await read(home).key("sharedSpaceCatalog").key("offers")
      .pull() ?? {};
    return offers[JSON.stringify([sender, id])];
  }

  /**
   * Which profile Home's `sharedSpaces.profiles` says acts in `space`, as
   * `root`, the Home a host holds, reads it, or the observation itself while
   * it is unavailable.
   */
  async function profileIn(
    space: string,
    root: Cell<unknown> = home,
  ): Promise<unknown> {
    const view = await read(root).key("sharedSpaces").key("profiles").pull();
    return view?.status === "ready" ? view.spaces[space] : view;
  }

  /** How many conflicts from Home's handler the intake has logged. */
  function conflictsLogged(): number {
    return getLoggerCountsBreakdown()["piece.share-intake"]
      ?.["registration-conflict"]?.warn ?? 0;
  }

  /**
   * Commits what `write` writes with no handler's authority, and returns the
   * commit's error message.
   */
  async function untrusted(
    write: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string | undefined> {
    const tx = runtime.edit();
    write(tx);
    tx.prepareCfc();
    const { error } = await tx.commit().settled;
    await runtime.idle();
    return error?.message;
  }

  /**
   * Makes a profile named `name` as the stranger, in the stranger's own
   * space, on a runtime of their own, names it through its own `setName`,
   * which labels the name as the stranger's, and returns it as the owner's
   * runtime holds it.
   */
  async function strangersProfile(name: string): Promise<Cell<unknown>> {
    const storage = EmulatedStorageManager.connectTo(server, { as: stranger });
    const theirs = new Runtime({
      moduleByteCache,
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    try {
      const program = await resolveLocalProgram(
        (resolver) => theirs.harness.resolve(resolver),
        {
          main: new URL(
            "../../patterns/system/profile-home.tsx",
            import.meta.url,
          ).pathname,
          root: new URL("../../..", import.meta.url).pathname.replace(
            /\/$/,
            "",
          ),
        },
      );
      let tx = theirs.edit();
      const pattern = await theirs.patternManager.compilePattern(program, {
        space: stranger.did(),
        tx,
      });
      const profile = theirs.getCell<Record<string, unknown>>(
        stranger.did(),
        "a stranger's profile",
        undefined,
        tx,
      );
      theirs.run(tx, pattern, { initialName: name }, profile);
      theirs.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await profile.pull();
      tx = theirs.edit();
      profile.withTx(tx).key("setName").send({ name });
      expect((await tx.commit().settled).error).toBeUndefined();
      await theirs.idle();
      await storage.synced();
      theirs.runner.stop(profile);
      return runtime.getCellFromLink(profile.getAsNormalizedFullLink());
    } finally {
      await theirs.dispose({ closeStorage: false });
      await storage.close();
    }
  }

  /**
   * Appends `profile` to Home's `profiles` with a write no handler made, which
   * that list takes.
   */
  async function listProfile(profile: Cell<unknown>): Promise<void> {
    await rewriteProfiles((links) => [
      ...links,
      asStoredValue(profile.getAsLink()),
    ]);
  }

  /**
   * Replaces the links Home's `profiles` list holds with what `edit` makes of
   * them, writing the stored document beneath the runtime's write checks, as
   * none of Home's handlers would, since the list's write policies refuse
   * every other writer.
   */
  async function rewriteProfiles(
    edit: (links: readonly FabricValue[]) => FabricValue[],
  ): Promise<void> {
    const list = home.key("profiles").resolveAsCell();
    await list.sync();
    const document = { ...list.getAsNormalizedFullLink(), path: [] };
    const tx = runtime.edit();
    const stored = storedFields(tx, document);
    seedStoredEnvelope(tx, document, {
      ...stored,
      value: edit(storedList(stored.value)),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await home.pull();
  }

  /**
   * Stores a label of a version this build cannot read on the document the
   * name of `profile` resolves to, so that reading whose name it is fails.
   */
  async function unreadableName(profile: Cell<unknown>): Promise<void> {
    const name = profile.asSchema(namedSchema).key("name").resolveAsCell();
    await name.sync();
    const link = name.getAsNormalizedFullLink();
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, link.space);
    seedStoredEnvelope(
      tx,
      { space: link.space, scope: link.scope, id: link.id, path: ["cfc"] },
      {
        version: 999,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [] },
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  }

  /**
   * Runs, in Home's space, so that one handler can write there, a pattern
   * that binds Home's `registerSharedSpace` and `removeSharedSpace`, from the
   * module Home binds them from, to Home's own records of the profile acting
   * in each space and to the Home fields `roles` names in the places of
   * `profiles` and `retiredProfiles`, leaving `retiredProfiles` unbound when
   * it names none, as another pattern can. Its catalog is Home's own with
   * `homeCatalog`, and one of its own otherwise.
   */
  async function foreignBinding(
    {
      homeCatalog: homeCatalogField,
      profiles = "profiles",
      retiredProfiles,
    }: {
      homeCatalog?: true | string;
      profiles?: string;
      retiredProfiles?: string;
    } = {},
  ): Promise<Cell<Record<string, unknown>>> {
    const homeCatalog = homeCatalogField !== undefined;
    const space = identity.did();
    const main = homeProgram.main.replace(/home\.tsx$/, "foreign.tsx");
    const program: RuntimeProgram = {
      ...homeProgram,
      main,
      files: [
        ...homeProgram.files,
        {
          name: main,
          contents: `
import { type Cell, pattern, Writable } from "commonfabric";
import {
  registerSharedSpace,
  removeSharedSpace,
  type SharedSpaceCatalogStorage,
  type SharedSpaceProfileStorage,
} from "./shared-space-catalog.ts";

export default pattern<{
  records: Writable<SharedSpaceProfileStorage>;
  profiles: Writable<Cell<unknown>[]>;
  retiredProfiles?: Writable<Cell<unknown>[]>;
  ${homeCatalog ? "homeCatalog: Writable<SharedSpaceCatalogStorage>;" : ""}
}>(({ records, profiles, retiredProfiles, ${
            homeCatalog ? "homeCatalog" : ""
          } }) => {
  const catalog = ${
            homeCatalog
              ? "homeCatalog"
              : `new Writable<SharedSpaceCatalogStorage>({ entries: {}, offers: {} })
    .for("catalog")`
          };
  return {
    catalog,
    register: registerSharedSpace({
      catalog,
      sharedSpaceProfiles: records,
      profiles,
      ${retiredProfiles === undefined ? "" : "retiredProfiles,"}
    }),
    remove: removeSharedSpace({ catalog }),
  };
});`,
        },
      ],
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      `a foreign binding of Home's handlers ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    const result = runtime.run(tx, pattern, {
      records: home.key("sharedSpaceProfiles"),
      profiles: home.key(profiles),
      ...(retiredProfiles === undefined
        ? {}
        : { retiredProfiles: home.key(retiredProfiles) }),
      ...(homeCatalogField === undefined ? {} : {
        homeCatalog: homeCatalogField === true
          ? internal("sharedSpaceCatalog")
          : home.key(homeCatalogField),
      }),
    }, cell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    return result;
  }

  /** The internal cell of Home's that `.for(name)` names. */
  function internal(name: string): Cell<unknown> {
    const descriptor = homePattern.derivedInternalCells?.find((item) =>
      item.partialCause === name
    );
    if (descriptor === undefined) throw new Error(`Home has no ${name}.`);
    return runtime.getCellFromLink(
      getDerivedInternalCellLink(home, descriptor),
    );
  }

  /** Sends `event` on `stream`, and settles. */
  async function sendTo(stream: Cell<unknown>, event: unknown): Promise<void> {
    const handled = Promise.withResolvers<void>();
    sendEvent(stream, event, () => handled.resolve());
    await handled.promise;
    await runtime.idle();
  }

  describe("an offer naming the profile it is for", () => {
    it("records that profile as the one acting in the offered space", async () => {
      const space = await loomSpace();

      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");

      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });

    it("records the profile the first names, and registers a second naming another with a receipt saying its profile was refused", async () => {
      const space = await loomSpace();
      const conflicts = conflictsLogged();
      const barrier = await loomSpace();

      await deliver([
        offerOf(space, "work", work),
        offerOf(space, "personal", personal),
        offerOf(barrier, "barrier"),
      ]);
      await receivedThrough("barrier");

      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
      expect(await receiptOf("work")).not.toHaveProperty("profileConflict");
      expect(await receiptOf("personal")).toMatchObject({
        space,
        profileConflict: "profile",
      });
      expect(conflictsLogged()).toBe(conflicts + 1);
    });

    it("registers the space, recording no profile, when the profile it names is none of the owner's, and is not sent again by a later intake", async () => {
      const space = await loomSpace();
      const conflicts = conflictsLogged();
      const barrier = await loomSpace();

      await deliver([
        {
          ...offerOf(space, "stranger"),
          toProfile: { space: strangersProfileSpace },
        },
        offerOf(barrier, "barrier"),
      ]);
      await receivedThrough("barrier");

      expect(await receiptOf("stranger")).toMatchObject({
        space,
        profileConflict: "unknown-profile",
      });
      expect(await profileIn(space)).toEqual({ status: "unrecorded" });
      expect(conflictsLogged()).toBe(conflicts + 1);

      intake?.stop();
      intake = undefined;
      await deliver([offerOf(await loomSpace(), "second barrier")]);
      await receivedThrough("second barrier");

      expect(conflictsLogged()).toBe(conflicts + 1);
    });
  });

  describe("an offer whose receipt Home already holds", () => {
    it("takes the conflict of a profile Home cannot record into that receipt, and is not sent again by a later intake", async () => {
      const space = await loomSpace();
      expect(
        await register(registrationOf(space, {
          offer: { from: sender, id: "plain" },
        })),
      ).toEqual({ status: "registered", space });
      const conflicts = conflictsLogged();
      const barrier = await loomSpace();

      await deliver([
        {
          ...offerOf(space, "plain"),
          toProfile: { space: strangersProfileSpace },
        },
        offerOf(barrier, "barrier"),
      ]);
      await receivedThrough("barrier");

      expect(await receiptOf("plain")).toMatchObject({
        profileConflict: "unknown-profile",
      });
      expect(conflictsLogged()).toBe(conflicts + 1);

      intake?.stop();
      intake = undefined;
      await deliver([offerOf(await loomSpace(), "second barrier")]);
      await receivedThrough("second barrier");

      expect(conflictsLogged()).toBe(conflicts + 1);
    });
  });

  describe("an offer naming no profile", () => {
    it("records no profile, which a reader can tell from every recorded one", async () => {
      const space = await loomSpace();

      await deliver([offerOf(space, "legacy")]);
      await receivedThrough("legacy");

      expect(await profileIn(space)).toEqual({ status: "unrecorded" });
    });
  });

  describe("the two producers of a registration", () => {
    it("agree when the share intake registers an offer before a host registers it", async () => {
      const space = await loomSpace();
      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");

      expect(
        await register(registrationOf(space, {
          offer: { from: sender, id: "first" },
          profile: spaceOf(work),
        })),
      ).toEqual({ status: "existing", space });
      expect(
        await register(registrationOf(space, {
          offer: { from: sender, id: "first" },
        })),
      ).toEqual({ status: "existing", space });
      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });

    it("agree when a host registers an offer naming no profile before the share intake registers it naming one", async () => {
      const space = await loomSpace();
      expect(
        await register(registrationOf(space, {
          offer: { from: sender, id: "first" },
        })),
      ).toEqual({ status: "registered", space });
      expect(await profileIn(space)).toEqual({ status: "unrecorded" });

      const barrier = await loomSpace();
      await deliver([
        offerOf(space, "first", work),
        offerOf(barrier, "barrier"),
      ]);
      await receivedThrough("barrier");

      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });

    it("conflict, recording nothing, when a host names another profile than the share intake recorded", async () => {
      const space = await loomSpace();
      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");

      expect(
        await register(registrationOf(space, { profile: spaceOf(personal) })),
      ).toEqual({
        status: "conflict",
        reason: "profile",
        space,
        registration: "existing",
      });
      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });
  });

  describe("an offer whose profile Home refused as none of the person's live profiles", () => {
    it("is registered with its profile, and its receipt's conflict cleared, once Home lists the profile as live again", async () => {
      await send("retireProfile", { profile: work });
      const space = await loomSpace();
      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");
      expect(await receiptOf("first")).toMatchObject({
        profileConflict: "unknown-profile",
      });
      expect(await profileIn(space)).toEqual({ status: "unrecorded" });

      const records = read(home).key("sharedSpaceProfiles");
      let changed = Promise.withResolvers<void>();
      const cancel = records.sink(() => {
        changed.resolve();
        changed = Promise.withResolvers<void>();
      });
      try {
        await send("restoreProfile", { profile: work });
        while (true) {
          const next = changed.promise;
          if (Object.hasOwn(await records.pull() ?? {}, space)) break;
          await next;
        }
      } finally {
        cancel();
      }
      await intake?.idle();
      await runtime.idle();

      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
      expect(await receiptOf("first")).not.toHaveProperty("profileConflict");
    });
  });

  describe("Home's view of its records", () => {
    it("lists the spaces of the person's live profiles, leaving out a retired one and one that is not theirs", async () => {
      const live = async () => {
        const view = await read(home).key("sharedSpaces").key("profiles")
          .pull();
        return view?.status === "ready" ? view.live : view;
      };
      expect(await live()).toEqual([spaceOf(personal), spaceOf(work)]);

      await send("retireProfile", { profile: work });
      await listProfile(await strangersProfile("Mallory"));

      expect(await live()).toEqual([spaceOf(personal)]);
    });
  });

  describe("a recorded profile", () => {
    it("is what a second host that brings Home up reads, with no profile of its own chosen", async () => {
      const space = await loomSpace();
      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");
      await first.storage.synced();

      const second = await open();
      const root = await second.controller.getDefaultPattern();
      if (root === undefined) throw new Error("The second host finds no Home.");
      await second.runtime.idle();

      expect(await profileIn(space, root)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });

    it("reads as retired once its profile is retired, on a host that brings Home up again after the first stops", async () => {
      const space = await loomSpace();
      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");
      await send("retireProfile", { profile: work });
      expect(await profileIn(space)).toEqual({
        status: "retired",
        profile: spaceOf(work),
      });
      intake?.stop();
      intake = undefined;
      await first.storage.synced();
      await close(first);

      const second = await open();
      const root = await second.controller.getDefaultPattern();
      if (root === undefined) throw new Error("The second host finds no Home.");
      await second.runtime.idle();

      expect(await profileIn(space, root)).toEqual({
        status: "retired",
        profile: spaceOf(work),
      });
    });

    it("is kept when the space's root is replaced and the space is offered again", async () => {
      const space = await loomSpace();
      await deliver([offerOf(space, "first", work)]);
      await receivedThrough("first");
      const before = await rootOf(space);

      await replaceRoot(space);
      expect(await rootOf(space)).not.toBe(before);
      await deliver([offerOf(space, "again", work)]);
      await receivedThrough("again");

      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
      expect(
        await register(registrationOf(space, { profile: spaceOf(personal) })),
      ).toEqual({
        status: "conflict",
        reason: "profile",
        space,
        registration: "existing",
      });
    });

    it("is kept when its space is archived and restored", async () => {
      const space = await loomSpace();
      await register(registrationOf(space, { profile: spaceOf(work) }));
      const revision = () =>
        read(home).key("sharedSpaceCatalog").key("entries").get()?.[space]
          ?.revision;

      await send("changeSharedSpaceMembership", {
        space,
        id: "archive",
        expectedRevision: revision(),
        state: "archived",
      });
      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
      await send("changeSharedSpaceMembership", {
        space,
        id: "restore",
        expectedRevision: revision(),
        state: "saved",
      });

      expect(
        read(home).key("sharedSpaceCatalog").key("entries").get()?.[space]
          ?.state,
      ).toBe("saved");
      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });

    it("stays when its space's entry is removed, so that a later registration of the space keeps it", async () => {
      const space = await loomSpace();
      await register(registrationOf(space, { profile: spaceOf(work) }));
      const revision = read(home).key("sharedSpaceCatalog").key("entries")
        .get()?.[space]?.revision;

      await send("removeSharedSpace", { space, expectedRevision: revision });
      expect(read(home).key("sharedSpaceCatalog").key("entries").get()?.[space])
        .toBeUndefined();
      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toMatchObject({ space, profile: spaceOf(work) });

      expect(
        await register(registrationOf(space, { profile: spaceOf(personal) })),
      ).toEqual({
        status: "conflict",
        reason: "profile",
        space,
        registration: "registered",
      });
      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });

    it("reads as foreign once Home no longer lists its profile", async () => {
      const space = await loomSpace();
      await register(registrationOf(space, { profile: spaceOf(work) }));
      const listed = (read(home).key("profiles").get() ?? []).map(spaceOf);
      await rewriteProfiles((links) =>
        links.filter((_, index) => listed[index] !== spaceOf(work))
      );

      expect(await profileIn(space)).toEqual({
        status: "foreign",
        profile: spaceOf(work),
      });
    });
  });

  describe("a profile Home lists that is not the person's own", () => {
    it("is refused as unknown when a registration names it, though a write no handler made listed it", async () => {
      const theirs = await strangersProfile("Mallory");
      await listProfile(theirs);
      expect(
        (read(home).key("profiles").get() ?? []).map(spaceOf),
      ).toContain(spaceOf(theirs));
      const space = await loomSpace();

      expect(
        await register(registrationOf(space, { profile: spaceOf(theirs) })),
      ).toEqual({
        status: "conflict",
        reason: "unknown-profile",
        space,
        registration: "registered",
      });
      expect(await profileIn(space)).toEqual({ status: "unrecorded" });
    });

    it("whose name's label cannot be read fails the registration, which writes no receipt or record, so a later intake sends it again", async () => {
      await unreadableName(work);
      const space = await loomSpace();
      const barrier = await loomSpace();

      await deliver([
        offerOf(space, "first", work),
        offerOf(barrier, "barrier"),
      ]);
      await receivedThrough("barrier");

      expect(await receiptOf("first")).toBeUndefined();
      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toBeUndefined();
    });
  });

  describe("a binding of Home's handlers in another pattern", () => {
    it("can neither replace nor remove a record, though it holds Home's records", async () => {
      const space = await loomSpace();
      await register(registrationOf(space, { profile: spaceOf(work) }));
      const foreign = await foreignBinding();

      await sendTo(
        foreign.key("register"),
        registrationOf(space, { profile: spaceOf(personal) }),
      );
      const revision = foreign.key("catalog").key("entries").get()?.[space]
        ?.revision;
      await sendTo(foreign.key("remove"), {
        space,
        expectedRevision: revision,
      });

      expect(foreign.key("catalog").key("entries").get()?.[space])
        .toBeUndefined();
      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toEqual({ space, profile: spaceOf(work) });
    });

    it("records no profile when it binds no list of retired profiles, though it binds Home's catalog, records and profiles", async () => {
      await send("retireProfile", { profile: work });
      const space = await loomSpace();
      const foreign = await foreignBinding({ homeCatalog: true });

      await sendTo(
        foreign.key("register"),
        registrationOf(space, { profile: spaceOf(work) }),
      );

      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toBeUndefined();
    });

    it("records no profile when it binds Home's retired profiles as its profiles and Home's recently used ones as its retired, though it binds Home's catalog and records", async () => {
      await send("retireProfile", { profile: work });
      const space = await loomSpace();
      const foreign = await foreignBinding({
        homeCatalog: true,
        profiles: "retiredProfiles",
        retiredProfiles: "mru",
      });

      await sendTo(
        foreign.key("register"),
        registrationOf(space, { profile: spaceOf(work) }),
      );

      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toBeUndefined();
    });

    it("records no profile when it binds Home's catalog view in the place of its catalog, though it binds Home's records and lists each in its own place", async () => {
      const space = await loomSpace();
      const foreign = await foreignBinding({
        homeCatalog: "sharedSpaceCatalog",
        retiredProfiles: "retiredProfiles",
      });

      await sendTo(
        foreign.key("register"),
        registrationOf(space, { profile: spaceOf(work) }),
      );

      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toBeUndefined();
    });

    it("records a live profile when it binds Home's stored catalog by its field, and Home's records and lists each in its own place", async () => {
      const space = await loomSpace();
      const foreign = await foreignBinding({
        homeCatalog: "sharedSpaceCatalogStorage",
        retiredProfiles: "retiredProfiles",
      });

      await sendTo(
        foreign.key("register"),
        registrationOf(space, { profile: spaceOf(work) }),
      );

      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toEqual({ space, profile: spaceOf(work) });
    });

    it("records a live profile when it binds Home's catalog, records and lists each in its own place", async () => {
      const space = await loomSpace();
      const foreign = await foreignBinding({
        homeCatalog: true,
        retiredProfiles: "retiredProfiles",
      });

      await sendTo(
        foreign.key("register"),
        registrationOf(space, { profile: spaceOf(work) }),
      );

      expect(read(home).key("sharedSpaceProfiles").get()?.[space])
        .toEqual({ space, profile: spaceOf(work) });
    });
  });

  describe("Home's records", () => {
    it("refuse a write by anything but Home's handlers, whole, at a space or at a field", async () => {
      const space = await loomSpace();
      await register(registrationOf(space, { profile: spaceOf(work) }));
      const viaResult = (tx: IExtendedStorageTransaction) =>
        runtime.getCell(
          identity.did(),
          "shared-space profiles home",
          homeResultSchema,
          tx,
        ).key("sharedSpaceProfiles");
      const stored = (tx: IExtendedStorageTransaction) =>
        home.withTx(tx).key("sharedSpaceProfiles").resolveAsCell();
      const replacement = { space, profile: spaceOf(personal) };

      expect(await untrusted((tx) => viaResult(tx).set({}))).toContain(
        "writeAuthorizedBy",
      );
      expect(await untrusted((tx) => stored(tx).set({}))).toContain(
        "writeAuthorizedBy",
      );
      expect(
        await untrusted((tx) => stored(tx).key(space).set(replacement)),
      ).toContain("writeAuthorizedBy");
      expect(
        await untrusted((tx) =>
          stored(tx).key(space).key("profile").set(spaceOf(personal))
        ),
      ).toContain("writeAuthorizedBy");
      expect(await profileIn(space)).toEqual({
        status: "live",
        profile: spaceOf(work),
      });
    });
  });
});
