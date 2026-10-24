/**
 * Drives a release of a `system:` pattern through the reconciler onto a piece
 * whose argument document holds fields only a named writer may change, each
 * holding what that writer put there. The reconciler sets the release up with
 * no argument, so the setup stages the stored document again, those fields
 * among them, and the release commits only where that staging leaves them as
 * they were.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { cfcSchemaEntries } from "../src/cfc/schema-label-view.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import {
  type Cell,
  getPatternIdentityRef,
  getPieceReconciliation,
  type PieceReconciliation,
  resolveEntryIdentity,
  Runtime,
  type RuntimeProgram,
  systemPatternSource,
} from "../src/index.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const origin = systemPatternSource("system/guarded-room.tsx");
const route = "/api/patterns/system/guarded-room.tsx";

// `title` is written by `retitle` alone; `note` is guarded by nothing.
const WRITER_SOURCE = `/// <cts-enable />
import {
  Default,
  handler,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const retitle = handler<{ text: string }, { title: Writable<{ text: string }> }>(
  ({ text }, { title }) => {
    title.set({ text });
  },
);

interface Input {
  title?: Default<
    WriteAuthorizedBy<{ text: string }, typeof retitle>,
    { text: "" }
  >;
  note?: Default<string, "">;
}

interface Output {
  title: { text: string };
  note: string;
  retitle: Stream<{ text: string }>;
}

export default pattern<Input, Output>(({ title, note }) => ({
  title,
  note,
  retitle: retitle({ title }),
}));
`;

// `about` is written by `describeRoom` alone, from its surface's trusted
// event, and labeled with its author; `badge` is written from its surface's
// trusted event by whatever handler receives one.
const CONTRACT_SOURCE = `/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  Default,
  handler,
  pattern,
  Stream,
  type TrustedActionUiContract,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";

const describeRoom = handler<
  { title: string },
  { about: Writable<{ title: string } | undefined> }
>(({ title }, { about }) => {
  about.set({ title });
});

const pin = handler<{ text: string }, { badge: Writable<{ text: string }> }>(
  ({ text }, { badge }) => {
    badge.set({ text });
  },
);

interface Input {
  about?: AuthoredByCurrentUser<
    TrustedActionWrite<
      { title: string },
      typeof describeRoom,
      "Describe",
      "GuardedRoom"
    >
  >;
  badge?: Default<
    TrustedActionUiContract<{ text: string }, "Pin", "GuardedRoom">,
    { text: "" }
  >;
}

interface Output {
  about?: { title: string };
  badge: { text: string };
  describeRoom: Stream<{ title: string }>;
  pin: Stream<{ text: string }>;
}

export default pattern<Input, Output>(({ about, badge }) => ({
  about,
  badge,
  describeRoom: describeRoom({ about }),
  pin: pin({ badge }),
}));
`;

// The shapes a FabriChat room's inputs take: a record whose type is a named
// definition, written by `describeRoom` alone from its surface's trusted
// event, and a list under a named record, grown by `join` alone.
const NAMED_SOURCE = `/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  Default,
  handler,
  pattern,
  Stream,
  type TrustedActionWrite,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

interface About {
  title: string;
}

const describeRoom = handler<
  { title: string },
  { about: Writable<About | undefined> }
>(({ title }, { about }) => {
  about.set({ title });
});

type StoredAbout = AuthoredByCurrentUser<
  TrustedActionWrite<About, typeof describeRoom, "Describe", "GuardedRoom">
>;

const join = handler<{ name: string }, { roster: RosterCell }>(
  ({ name }, { roster }) => {
    roster.key("items").push(name);
  },
);

interface Roster {
  items?: WriteAuthorizedBy<string[], typeof join>;
}

type RosterCell = Writable<Roster | Default<Record<PropertyKey, never>>>;

interface Input {
  about?: StoredAbout;
  roster?: RosterCell;
}

interface Output {
  about?: About;
  roster: Roster;
  describeRoom: Stream<{ title: string }>;
  join: Stream<{ name: string }>;
}

export default pattern<Input, Output>(({ about, roster }) => ({
  about,
  roster,
  describeRoom: describeRoom({ about }),
  join: join({ roster }),
}));
`;

// `NAMED_SOURCE` with `notes` beside its fields: links, each to a document of
// its own whose `tags` only `post` and `describeRoom` may write, as a
// FabriChat room's `messages` do.
const LINKED_SOURCE = `/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  Default,
  handler,
  pattern,
  Stream,
  type TrustedActionWrite,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";

interface About {
  title: string;
}

const describeRoom = handler<
  { title: string },
  { about: Writable<About | undefined> }
>(({ title }, { about }) => {
  about.set({ title });
});

type StoredAbout = AuthoredByCurrentUser<
  TrustedActionWrite<About, typeof describeRoom, "Describe", "GuardedRoom">
>;

interface Note {
  text: string;
  tags?: WritePolicyAnyOf<string[], [
    WriteAuthorizedBy<unknown, typeof post>,
    WriteAuthorizedBy<unknown, typeof describeRoom>,
  ]>;
}

type NotesCell = Writable<Note[] | Default<[]>>;

const join = handler<{ name: string }, { roster: RosterCell }>(
  ({ name }, { roster }) => {
    roster.key("items").push(name);
  },
);

interface Roster {
  items?: WriteAuthorizedBy<string[], typeof join>;
}

type RosterCell = Writable<Roster | Default<Record<PropertyKey, never>>>;

const post = handler<{ text: string }, { notes: NotesCell }>(
  ({ text }, { notes }) => {
    const note = notes.elementById(text);
    note.set({ text, tags: ["new"] });
    notes.addUnique(note);
  },
);

interface Input {
  about?: StoredAbout;
  roster?: RosterCell;
  notes?: NotesCell;
}

interface Output {
  about?: About;
  roster: Roster;
  notes: Note[];
  describeRoom: Stream<{ title: string }>;
  join: Stream<{ name: string }>;
  post: Stream<{ text: string }>;
}

export default pattern<Input, Output>(({ about, roster, notes }) => ({
  about,
  roster,
  notes,
  describeRoom: describeRoom({ about }),
  join: join({ roster }),
  post: post({ notes }),
}));
`;

/** What a test reads off a room. */
type Room = Record<string, unknown>;

/** What `reconcileRelease()` hands its probe. */
interface Released {
  /** What the reconciler returned. */
  outcome: string;

  /** The room, read after the reconciliation. */
  room: Cell<Room>;

  /** The reconciliation the room records. */
  recorded: PieceReconciliation | undefined;

  /** The identity of the source the room was made from. */
  previousIdentity: string;

  /** The identity of the release. */
  currentIdentity: string;

  /** The runtime the room runs in. */
  runtime: Runtime;
}

/** Sends `event` to the piece's `stream`, and waits for what it wrote. */
async function send(
  runtime: Runtime,
  room: Cell<Room>,
  stream: string,
  event: unknown,
): Promise<void> {
  (room.key(stream) as unknown as { send: (e: unknown) => void }).send(event);
  await runtime.idle();
  await room.pull();
  await runtime.idle();
}

/**
 * `fields` as an event from the room's own surface for `action`, which a
 * field that surface's UI contract guards needs: the renderer-trusted mark
 * and the surface's provenance.
 */
function trustedEvent<T extends object>(action: string, fields: T): T {
  const event = {
    ...fields,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "GuardedRoom",
        eventIntegrity: ["GuardedRoom"],
        uiContractDataset: { uiAction: action },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

/**
 * Creates a room from `previous`, served as the `system:` origin's source,
 * and lets `prime` write its guarded fields. Then serves `current` instead,
 * reconciles the room, and hands what came of it to `probe`.
 */
async function reconcileRelease(
  name: string,
  previous: string,
  current: string,
  prime: (runtime: Runtime, room: Cell<Room>) => Promise<void>,
  probe: (released: Released) => void | Promise<void>,
): Promise<void> {
  const signer = await Identity.fromPassphrase(`guarded argument ${name}`);
  const previousIdentity = await resolveEntryIdentity(
    route,
    () => Promise.resolve(previous),
  );
  const currentIdentity = await resolveEntryIdentity(
    route,
    () => Promise.resolve(current),
  );
  let served = { contents: previous, identity: previousIdentity };
  const runtime = new Runtime(runtimePresets.unitTest({
    apiUrl: new URL("https://room.test"),
    storageManager: StorageManager.emulate({ as: signer }),
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname !== route) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          url.searchParams.has("identity") ? served.identity : served.contents,
        ),
      );
    },
  }));
  try {
    const program: RuntimeProgram = {
      main: route,
      files: [{ name: route, contents: previous }],
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: signer.did(),
      tx,
    });
    const room = runtime.getCell<Room>(signer.did(), name);
    runtime.runner.run(tx, pattern, {}, room, { sourceOrigin: origin });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await room.pull();
    await runtime.idle();
    await prime(runtime, room);
    expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);

    served = { contents: current, identity: currentIdentity };
    const outcome = await runtime.sourceReconciler.reconcile(room);
    await runtime.runner.idlePointerMaintenance();
    await room.pull();
    await probe({
      outcome,
      room,
      recorded: getPieceReconciliation(room),
      previousIdentity,
      currentIdentity,
      runtime,
    });
  } finally {
    await runtime.sourceReconciler.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.dispose();
  }
}

/** `source` one byte apart, which gives every handler in it a new identity. */
const releaseBehind = (source: string): string =>
  `${source}\n// a release behind\n`;

/** The claims the envelope the room's argument stores declares at `path`. */
function storedClaimsAt(
  runtime: Runtime,
  room: Cell<Room>,
  path: string,
): unknown {
  const tx = runtime.edit();
  try {
    const stored = loadStoredCfcEnvelope(
      tx,
      room.getArgumentCell<Room>()!.getAsNormalizedFullLink(),
    );
    expect(stored.status).toBe("loaded");
    if (stored.status !== "loaded") return undefined;
    const entry = cfcSchemaEntries(stored.schema).find((entry) =>
      entry.path.join("/") === path
    );
    return (entry?.schema as { ifc?: unknown } | undefined)?.ifc;
  } finally {
    tx.abort();
  }
}

/** The schema hash of the envelope the room's argument stores. */
function storedSchemaHash(runtime: Runtime, room: Cell<Room>): string {
  const tx = runtime.edit();
  try {
    const stored = loadStoredCfcEnvelope(
      tx,
      room.getArgumentCell<Room>()!.getAsNormalizedFullLink(),
    );
    expect(stored.status).toBe("loaded");
    return stored.status === "loaded" ? String(stored.metadata.schemaHash) : "";
  } finally {
    tx.abort();
  }
}

describe("source-reconciler-protected-argument", () => {
  describe("a field only its handler may write", () => {
    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(runtime, room, "retitle", { text: "lunch" });
      expect(room.get().title).toEqual({ text: "lunch" });
    };

    it("adopts a release that leaves the field as it is, and keeps what it holds", async () => {
      await reconcileRelease(
        "writer-release",
        releaseBehind(WRITER_SOURCE),
        WRITER_SOURCE,
        prime,
        ({ outcome, room, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().title).toEqual({ text: "lunch" });
        },
      );
    });

    it("refuses a release whose setup would change the field, records why, and keeps the field as it was", async () => {
      // The release gives the field's record a member with a default, which
      // the setup fills into what the field holds: a write there only
      // `retitle` may make.
      const current = WRITER_SOURCE.replace(
        "WriteAuthorizedBy<{ text: string }, typeof retitle>",
        'WriteAuthorizedBy<{ text: string; color?: Default<string, "red"> }, typeof retitle>',
      );
      expect(current).not.toBe(WRITER_SOURCE);
      await reconcileRelease(
        "writer-changing-release",
        WRITER_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain(
            "writeAuthorizedBy requires a trusted verified binding identity " +
              "at /title",
          );
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().title).toEqual({ text: "lunch" });
        },
      );
    });
  });

  describe("fields a UI contract guards", () => {
    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(
        runtime,
        room,
        "describeRoom",
        trustedEvent("Describe", { title: "lunch" }),
      );
      await send(runtime, room, "pin", trustedEvent("Pin", { text: "hi" }));
      expect(room.get().about).toEqual({ title: "lunch" });
      expect(room.get().badge).toEqual({ text: "hi" });
    };

    it("adopts a release that leaves the fields as they are, and keeps what they hold", async () => {
      await reconcileRelease(
        "contract-release",
        releaseBehind(CONTRACT_SOURCE),
        CONTRACT_SOURCE,
        prime,
        ({ outcome, room, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().badge).toEqual({ text: "hi" });
        },
      );
    });

    it("refuses a release whose setup would change a field, records the missing trusted event, and keeps the field as it was", async () => {
      // As for the writer's field above: the release fills a default into
      // what `badge` holds, which only an event from its surface may write.
      const current = CONTRACT_SOURCE.replace(
        'TrustedActionUiContract<{ text: string }, "Pin", "GuardedRoom">',
        'TrustedActionUiContract<{ text: string; color?: Default<string, "red"> }, "Pin", "GuardedRoom">',
      );
      expect(current).not.toBe(CONTRACT_SOURCE);
      await reconcileRelease(
        "contract-changing-release",
        CONTRACT_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain(
            "missing trusted-event policy input for",
          );
          expect(recorded?.detail).toContain("at /badge");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().badge).toEqual({ text: "hi" });
        },
      );
    });

    it("records a release that changes a field's trusted action as refused for good, and does not prepare it again", async () => {
      // The envelope `about` stores fixes the reviewed action that may write
      // it. The release's own differs, so the merge refuses it as a verdict
      // naming the stored envelope, and the room keeps that refusal across a
      // write under the schema it runs.

      const current = CONTRACT_SOURCE.replace(
        '      typeof describeRoom,\n      "Describe",',
        '      typeof describeRoom,\n      "Rename",',
      );
      expect(current).not.toBe(CONTRACT_SOURCE);
      await reconcileRelease(
        "contract-action-release",
        CONTRACT_SOURCE,
        current,
        prime,
        async ({ outcome, room, recorded, previousIdentity, runtime }) => {
          expect(outcome).toBe("rejected");
          expect(recorded).toMatchObject({
            outcome: "refused",
            reason: "apply-failed",
          });
          expect(recorded?.detail).toContain("must remain stable at /about");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);

          await send(runtime, room, "pin", trustedEvent("Pin", { text: "yo" }));
          using prepared = spy(runtime.runner, "syncStoredPieceCells");
          expect(await runtime.sourceReconciler.reconcile(room)).toBe(
            "rejected",
          );

          expect(prepared.calls).toHaveLength(0);
          expect(room.get().badge).toEqual({ text: "yo" });
        },
      );
    });
  });

  describe("fields whose types are named definitions", () => {
    // Across a release, the merged envelope keeps the stored claims in force
    // under another layout of definitions: it names the release's own
    // definitions apart, and spells out in place what the stored one names
    // by reference.

    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(
        runtime,
        room,
        "describeRoom",
        trustedEvent("Describe", { title: "lunch" }),
      );
      await send(runtime, room, "join", { name: "ada" });
      expect(room.get().about).toEqual({ title: "lunch" });
      expect(room.get().roster).toEqual({ items: ["ada"] });
    };

    it("adopts a release that leaves the fields as they are, and keeps what they hold", async () => {
      await reconcileRelease(
        "named-release",
        releaseBehind(NAMED_SOURCE),
        NAMED_SOURCE,
        prime,
        ({ outcome, room, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().roster).toEqual({ items: ["ada"] });
        },
      );
    });

    it("refuses a release that adds a policy to a named definition, and keeps the field as it was", async () => {
      // The release guards `Roster.items` with a UI contract as well, a
      // policy the stored envelope does not declare there.
      const current = NAMED_SOURCE.replace(
        "items?: WriteAuthorizedBy<string[], typeof join>;",
        'items?: TrustedActionWrite<string[], typeof join, "Join", "GuardedRoom">;',
      );
      expect(current).not.toBe(NAMED_SOURCE);
      await reconcileRelease(
        "named-policy-release",
        NAMED_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().roster).toEqual({ items: ["ada"] });
        },
      );
    });
  });

  describe("fields beside a list of links", () => {
    // A release re-describes the claims beneath a position holding links,
    // which describe the documents linked there: each `Note`'s `tags` names
    // the release's `post`. None of them governs this document.

    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(
        runtime,
        room,
        "describeRoom",
        trustedEvent("Describe", { title: "lunch" }),
      );
      await send(runtime, room, "join", { name: "ada" });
      await send(runtime, room, "post", { text: "hello" });
      expect(room.get().about).toEqual({ title: "lunch" });
      expect(room.get().notes).toEqual([{ text: "hello", tags: ["new"] }]);
    };

    it("adopts a release that re-describes what lies beneath the links, and keeps what the fields hold", async () => {
      await reconcileRelease(
        "linked-release",
        releaseBehind(LINKED_SOURCE),
        LINKED_SOURCE,
        prime,
        ({ outcome, room, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().notes).toEqual([{ text: "hello", tags: ["new"] }]);
        },
      );
    });

    it("keeps the stored envelope whole through a release that changes only the claims beneath the links", async () => {
      // The release names no writer for each `Note`'s `tags`, so its
      // envelope differs from the stored one beneath the links alone.
      const current = LINKED_SOURCE.replace(
        /tags\?: WritePolicyAnyOf<[^;]*;/,
        "tags?: AuthoredByCurrentUser<string[]>;",
      );
      expect(current).toContain("tags?: AuthoredByCurrentUser<string[]>;");
      let before = "";
      await reconcileRelease(
        "linked-claims-release",
        LINKED_SOURCE,
        current,
        async (runtime, room) => {
          await prime(runtime, room);
          before = storedSchemaHash(runtime, room);
        },
        ({ outcome, room, runtime, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(before).not.toBe("");
          expect(storedSchemaHash(runtime, room)).toBe(before);
        },
      );
    });

    it("adopts a release that adds a guarded slot beside a change beneath the links, storing the slot's policy and the release's claims beneath the links", async () => {
      // The release names no writer for each `Note`'s `tags` and adds
      // `titles`, a list only `rename` may write. The envelope stored beside
      // the new slot is the release's merged one, which re-describes what
      // lies beneath the links, as a release's merged envelope does.
      const current = LINKED_SOURCE
        .replace(
          /tags\?: WritePolicyAnyOf<[^;]*;/,
          "tags?: AuthoredByCurrentUser<string[]>;",
        )
        .replace(
          "interface Input {",
          `const rename = handler<{ title: string }, { titles: TitlesCell }>(
  ({ title }, { titles }) => {
    const record = titles.elementById("title");
    record.set({ title });
    titles.addUnique(record);
  },
);

type TitlesCell = Writable<
  WriteAuthorizedBy<About, typeof rename>[] | Default<[]>
>;

interface Input {
  titles?: TitlesCell;`,
        )
        .replace(
          "({ about, roster, notes }) => ({",
          "({ about, roster, notes, titles }) => ({\n  titles,\n  rename: rename({ titles }),",
        );
      expect(current).toContain("tags?: AuthoredByCurrentUser<string[]>;");
      expect(current).toContain("rename: rename({ titles })");
      await reconcileRelease(
        "linked-added-slot-release",
        LINKED_SOURCE,
        current,
        async (runtime, room) => {
          await prime(runtime, room);
          expect(storedClaimsAt(runtime, room, "notes/*/tags")).toMatchObject({
            writePolicyAnyOf: expect.any(Array),
          });
        },
        ({ outcome, room, runtime, recorded, currentIdentity }) => {
          expect(recorded?.detail).toBeUndefined();
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(storedClaimsAt(runtime, room, "notes/*/tags")).toEqual({
            addIntegrity: [{
              kind: "authored-by",
              subject: { __ctCurrentPrincipal: true },
            }],
          });
          expect(storedClaimsAt(runtime, room, "titles/*")).toMatchObject({
            writeAuthorizedBy: expect.anything(),
          });
          expect(room.get().titles).toEqual([]);
          expect(room.get().notes).toEqual([{ text: "hello", tags: ["new"] }]);
        },
      );
    });

    it("refuses a release that adds a policy beside the links, and keeps the field as it was", async () => {
      // `roster` holds no links, so a policy the release adds to
      // `Roster.items` governs this document, links or no links beside it.
      const current = LINKED_SOURCE.replace(
        "items?: WriteAuthorizedBy<string[], typeof join>;",
        'items?: TrustedActionWrite<string[], typeof join, "Join", "GuardedRoom">;',
      );
      expect(current).not.toBe(LINKED_SOURCE);
      await reconcileRelease(
        "linked-policy-release",
        LINKED_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().roster).toEqual({ items: ["ada"] });
        },
      );
    });

    it("refuses a release that adds a policy at the links themselves, and keeps the list as it was", async () => {
      // A claim at the position holding the links governs which links this
      // document may hold, so it is this document's to keep.
      const current = LINKED_SOURCE.replace(
        "type NotesCell = Writable<Note[] | Default<[]>>;",
        "type NotesCell = Writable<WriteAuthorizedBy<Note, typeof post>[] | Default<[]>>;",
      );
      expect(current).not.toBe(LINKED_SOURCE);
      await reconcileRelease(
        "linked-position-release",
        LINKED_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().notes).toEqual([{ text: "hello", tags: ["new"] }]);
        },
      );
    });
  });

  describe("a slot the release adds", () => {
    // The stored document holds nothing at the slot, and the stored envelope
    // declares nothing there, so the setup fills it with the release's
    // default and the release's envelope, which declares the slot's policy,
    // is stored.

    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(
        runtime,
        room,
        "describeRoom",
        trustedEvent("Describe", { title: "lunch" }),
      );
      await send(runtime, room, "join", { name: "ada" });
      expect(room.get().about).toEqual({ title: "lunch" });
      expect(room.get().roster).toEqual({ items: ["ada"] });
    };

    /**
     * What the error of a commit writing `value` at `slot` of the room's
     * argument says, through a cell with no schema, which only what the
     * stored envelope declares there governs.
     */
    const refusalOfDirectWrite = async (
      runtime: Runtime,
      room: Cell<Room>,
      slot: string,
      value: unknown,
    ): Promise<string | undefined> => {
      const argument = room.getArgumentCell<Room>()!;
      expect(argument.schema).toBeUndefined();
      const tx = runtime.edit();
      argument.withTx(tx).key(slot).set(value);
      return (await tx.commit().settled).error?.message;
    };

    // `NAMED_SOURCE` with `titles` beside its fields: a list whose entries only
    // `rename` may write, defaulting to `defaultTitles`, as a FabriChat room's
    // `titles` is.
    const withList = (defaultTitles = "[]"): string => {
      const source = NAMED_SOURCE
        .replace(
          "interface Input {",
          `const rename = handler<{ title: string }, { titles: TitlesCell }>(
  ({ title }, { titles }) => {
    const record = titles.elementById("title");
    record.set({ title });
    titles.addUnique(record);
  },
);

type TitlesCell = Writable<
  WriteAuthorizedBy<About, typeof rename>[] | Default<${defaultTitles}>
>;

interface Input {
  titles?: TitlesCell;`,
        )
        .replace(
          "  roster: Roster;\n",
          "  roster: Roster;\n  titles: About[];\n",
        )
        .replace(
          "({ about, roster }) => ({",
          "({ about, roster, titles }) => ({\n  titles,\n  rename: rename({ titles }),",
        )
        .replace(
          "  join: Stream<{ name: string }>;\n",
          "  join: Stream<{ name: string }>;\n  rename: Stream<{ title: string }>;\n",
        );
      expect(source).toContain("titles?: TitlesCell;");
      expect(source).toContain("titles: About[];");
      expect(source).toContain("rename: rename({ titles })");
      expect(source).toContain("rename: Stream<");
      return source;
    };

    // `NAMED_SOURCE` with `label` beside its fields: a record only `relabel`
    // may write, defaulting to an empty title.
    const withRecord = (): string => {
      const source = NAMED_SOURCE
        .replace(
          "interface Input {",
          `const relabel = handler<{ title: string }, { label: Writable<About> }>(
  ({ title }, { label }) => {
    label.set({ title });
  },
);

interface Input {
  label?: Default<WriteAuthorizedBy<About, typeof relabel>, { title: "" }>;`,
        )
        .replace("  roster: Roster;\n", "  roster: Roster;\n  label: About;\n")
        .replace(
          "({ about, roster }) => ({",
          "({ about, roster, label }) => ({\n  label,\n  relabel: relabel({ label }),",
        )
        .replace(
          "  join: Stream<{ name: string }>;\n",
          "  join: Stream<{ name: string }>;\n  relabel: Stream<{ title: string }>;\n",
        );
      expect(source).toContain("label?: Default<");
      expect(source).toContain("label: About;");
      expect(source).toContain("relabel: relabel({ label })");
      expect(source).toContain("relabel: Stream<");
      return source;
    };

    it("adopts a release that adds a list whose entries a writer guards, and keeps what the other fields hold", async () => {
      await reconcileRelease(
        "added-list-release",
        NAMED_SOURCE,
        withList(),
        prime,
        ({ outcome, room, recorded, currentIdentity }) => {
          expect(recorded?.detail).toBeUndefined();
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().roster).toEqual({ items: ["ada"] });
          expect(room.get().titles).toEqual([]);
        },
      );
    });

    it("stores the added list's policy, and its writers and the other fields' write after the release", async () => {
      await reconcileRelease(
        "added-list-writes",
        NAMED_SOURCE,
        withList(),
        prime,
        async ({ outcome, room, runtime }) => {
          expect(outcome).toBe("updated");
          expect(
            await refusalOfDirectWrite(runtime, room, "titles", [{
              title: "forged",
            }]),
          ).toContain("writeAuthorizedBy");
          expect(
            await refusalOfDirectWrite(runtime, room, "about", {
              title: "forged",
            }),
          ).toContain("writeAuthorizedBy");
          await send(runtime, room, "rename", { title: "tea" });
          await send(runtime, room, "join", { name: "bo" });
          await send(
            runtime,
            room,
            "describeRoom",
            trustedEvent("Describe", { title: "dinner" }),
          );
          expect(room.get().titles).toEqual([{ title: "tea" }]);
          expect(room.get().roster).toEqual({ items: ["ada", "bo"] });
          expect(room.get().about).toEqual({ title: "dinner" });
        },
      );
    });

    it("adopts a release that adds a record a writer guards, holding its default, and stores its policy", async () => {
      await reconcileRelease(
        "added-record-release",
        NAMED_SOURCE,
        withRecord(),
        prime,
        async ({ outcome, room, recorded, currentIdentity, runtime }) => {
          expect(recorded?.detail).toBeUndefined();
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().roster).toEqual({ items: ["ada"] });
          expect(room.get().label).toEqual({ title: "" });
          expect(
            await refusalOfDirectWrite(runtime, room, "label", {
              title: "forged",
            }),
          ).toContain("writeAuthorizedBy");
          await send(runtime, room, "relabel", { title: "tea" });
          expect(room.get().label).toEqual({ title: "tea" });
        },
      );
    });

    it("refuses a release that adds a list whose default holds an entry, and keeps the fields as they were", async () => {
      // An entry of the list is a value only `rename` may write, and no
      // initialization reaches a list's entries.
      await reconcileRelease(
        "added-list-entry-release",
        NAMED_SOURCE,
        withList('[{ title: "first" }]'),
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain(
            "writeAuthorizedBy requires a trusted verified binding identity " +
              "at /titles/*",
          );
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().titles).toBeUndefined();
        },
      );
    });

    it("refuses a release that adds a slot and changes a guarded field, and keeps the field as it was", async () => {
      // The release gives `About` a member with a default, which the setup
      // fills into what `about` holds: a write there only `describeRoom` may
      // make, whatever the release adds beside it.
      const current = withList().replace(
        "interface About {\n  title: string;\n}",
        'interface About {\n  title: string;\n  color?: Default<string, "red">;\n}',
      );
      expect(current).toContain("color?: Default<string");
      await reconcileRelease(
        "added-list-changing-release",
        NAMED_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain("at /about");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
        },
      );
    });

    it("refuses a release that adds a guarded member to a guarded record, and keeps the record as it was", async () => {
      // `about` holds no `note`, and the setup writes none, but the release
      // changes what writing `about` requires, and the setup restates it.
      const current = NAMED_SOURCE.replace(
        "interface About {\n  title: string;\n}",
        "interface About {\n  title: string;\n  note?: WriteAuthorizedBy<string, typeof describeRoom>;\n}",
      );
      expect(current).toContain("note?: WriteAuthorizedBy<string");
      await reconcileRelease(
        "added-member-release",
        NAMED_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain("at /about");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
        },
      );
    });

    it("refuses a release that adds a policy at a guarded slot the document does not hold yet, and keeps the fields as they were", async () => {
      // The stored envelope already guards `label`, so a UI contract the
      // release adds there joins a declared policy rather than a new field's.
      const guarded = (policy: string) =>
        withRecord()
          .replace(
            'label?: Default<WriteAuthorizedBy<About, typeof relabel>, { title: "" }>;',
            `label?: ${policy};`,
          )
          .replace("  label: About;\n", "  label?: About;\n")
          .replace(
            "{ label: Writable<About> }",
            "{ label: Writable<About | undefined> }",
          );
      const previous = guarded("WriteAuthorizedBy<About, typeof relabel>");
      const current = guarded(
        'TrustedActionWrite<About, typeof relabel, "Relabel", "GuardedRoom">',
      );
      expect(previous).toContain(
        "label?: WriteAuthorizedBy<About, typeof relabel>;",
      );
      expect(current).toContain("label?: TrustedActionWrite<About");
      expect(current).toContain("{ label: Writable<About | undefined> }");
      await reconcileRelease(
        "unheld-policy-release",
        previous,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(room.get().label).toBeUndefined();
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
        },
      );
    });

    it("refuses a release that adds a guarded list where the document holds `undefined`, and keeps the slot as it was", async () => {
      // A slot holding `undefined` holds a value, which no initialization
      // replaces and no new policy may adopt.
      await reconcileRelease(
        "undefined-slot-release",
        NAMED_SOURCE,
        withList(),
        async (runtime, room) => {
          await prime(runtime, room);
          const argument = room.getArgumentCell<Room>()!;
          const tx = runtime.edit();
          argument.withTx(tx).key("titles").setRaw(undefined);
          expect((await tx.commit().settled).error).toBeUndefined();
          await argument.pull();
          const stored = argument.getRaw() as Room;
          expect(Object.hasOwn(stored, "titles")).toBe(true);
          expect(stored.titles).toBeUndefined();
        },
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          const stored = room.getArgumentCell<Room>()!.getRaw() as Room;
          expect(Object.hasOwn(stored, "titles")).toBe(true);
          expect(stored.titles).toBeUndefined();
        },
      );
    });

    it("refuses a release that guards a slot the document already holds, and keeps the slot as it was", async () => {
      // Before the release, `titles` is a list anyone may write, and holds an
      // entry; guarding it would adopt what it holds.
      const previous = withList().replace(
        "WriteAuthorizedBy<About, typeof rename>[]",
        "About[]",
      );
      expect(previous).not.toContain("WriteAuthorizedBy<About");
      await reconcileRelease(
        "held-list-release",
        previous,
        withList(),
        async (runtime, room) => {
          await prime(runtime, room);
          await send(runtime, room, "rename", { title: "tea" });
          expect(room.get().titles).toEqual([{ title: "tea" }]);
        },
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().titles).toEqual([{ title: "tea" }]);
        },
      );
    });
  });
});
