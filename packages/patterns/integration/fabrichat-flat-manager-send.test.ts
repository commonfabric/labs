/**
 * A production room over flat bindings in a synthetic Home wrapper chain: a
 * send, and an add that asks the viewer's manager to tell the person added of
 * the room. The manager is public, or root-private: its core document declares
 * the viewer's `PersonalSpace` label over all of it, in their home space, as a
 * real Home's manager can. The room lives in another space, so every labeled
 * read the room makes of a root-private manager comes from outside the room's
 * space, and writer-fit (§8.12.4) measures each room document such a read
 * reaches, `computed:` documents included.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import {
  type Cell,
  isCell,
  type JSONSchema,
  Runtime,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const owner = await Identity.fromPassphrase("fabrichat-manager-roles");
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

// A stand-in for a principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

// The reviewed actions a start and an add are admitted from, as
// `../fabrichat/schemas.tsx` names them.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };
const ADD_MEMBER_ACTION = {
  surface: "ChatAddMemberSurface",
  action: "ChatAddMember",
};

/**
 * `event` as a click on a control of `action` delivers it: carrying the
 * reviewed action, and marked as the renderer marks a click it delivers.
 */
const trustedClick = (
  action: { surface: string; action: string },
  event: Record<string, unknown>,
): Record<string, unknown> => {
  const click = {
    type: "click",
    ...event,
    provenance: reviewedActionProvenance("dom", action),
  };
  markRendererTrustedEvent(click);
  return click;
};

/**
 * The id an add to the room in `space` keys its offer by, as
 * `addMemberOfferId()` in `../fabrichat/schemas.tsx` composes it.
 */
const addMemberOfferId = (space: string, requestId: string): string =>
  JSON.stringify(["addMember", space, requestId]);

// Reads a manager's room entries with each room as a link, not a copy.
const roomEntriesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { room: { type: "unknown", asCell: ["cell"] } },
    required: ["room"],
  },
} as const satisfies JSONSchema;

/** A refusal CFC prepare reported. */
type Refusal = Extract<RuntimeTelemetryMarker, { type: "cfc.prepare-reject" }>;

/**
 * Reads what a renderer reads of `piece`'s view: the view, through
 * `rendererVDOMSchema`, and every cell it binds, each once.
 */
const render = async (piece: Cell<unknown>): Promise<void> => {
  const read = new Set<string>();
  const visit = async (value: unknown): Promise<void> => {
    if (isCell(value)) {
      const { space, id, scope, path } = value.getAsNormalizedFullLink();
      const address = JSON.stringify([space, id, scope, path]);
      if (read.has(address)) return;
      read.add(address);
      await value.pull();
      return visit(value.get());
    }
    if (Array.isArray(value)) {
      for (const member of value) await visit(member);
    } else if (value !== null && typeof value === "object") {
      for (const member of Object.values(value)) await visit(member);
    }
  };
  await visit(piece.key("$UI").asSchema(rendererVDOMSchema));
};

describe("FabriChat flat manager sends", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let observation: AbortController;
  let refusals: Refusal[];

  beforeEach(() => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    observation = new AbortController();
    refusals = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (
        event instanceof RuntimeTelemetryEvent &&
        event.marker.type === "cfc.prepare-reject"
      ) refusals.push(event.marker);
    }, { signal: observation.signal });
  });

  afterEach(async () => {
    await runtime?.idle();
    await storage?.synced();
    observation?.abort();
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  /** Writes a profile named `name`, under `cause`, in a space of its own. */
  const writeProfile = async (cause: string, name: string) => {
    const space = await runtime.createSpace({});
    const tx = runtime.edit();
    const profile = runtime.getCell(space, cause, {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { addIntegrity: ["fabrichat-test-profile"] },
    }, tx);
    profile.set({ name });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return profile;
  };

  /**
   * Writes the viewer's Home in their home space: their manager's core, which
   * lists `people`, behind the wrapper and document-valued link Home keeps to
   * it, and Home's root, which names the wrapper as `chatManager` beside
   * `profile`. The wrapper's `[UI]` links the core's, as Home's manager does,
   * and is the slot a `#chatManager` wish reads for its view. A `labeled` core
   * declares the viewer's `PersonalSpace` label over all of it. Returns the
   * wrapper and the core's `offerRoom`.
   */
  const writeHome = async (
    labeled: boolean,
    profile: Cell<unknown>,
    people: Record<string, Cell<unknown>[]>,
  ) => {
    const home = owner.did();
    const tx = runtime.edit();
    const endpoint = (name: string) => {
      const cell = runtime.getCell(home, name, undefined, tx);
      cell.set({ $stream: true });
      return cell;
    };
    const offerRoom = endpoint("offerRoom");
    const joinRoom = endpoint("joinRoom");
    const openDirect = endpoint("openDirect");
    const managerSchema = {
      type: "object",
      properties: {
        $UI: { asCell: ["cell"] },
        offerRoom: { asCell: ["stream"] },
        joinRoom: { asCell: ["stream"] },
        openDirect: { asCell: ["stream"] },
        requests: { type: "object", additionalProperties: true },
        people: { type: "object", additionalProperties: true },
      },
      ...(labeled
        ? {
          ifc: {
            confidentiality: [{
              type: "https://commonfabric.org/cfc/atom/PersonalSpace",
              owner: home,
            }],
          },
        }
        : {}),
    } as const satisfies JSONSchema;
    const view = runtime.getCell(home, "manager view", undefined, tx);
    view.set({ type: "vnode", name: "div", props: {}, children: [] });
    const manager = runtime.getCell(home, "manager core", managerSchema, tx);
    manager.set({
      $UI: view,
      offerRoom,
      joinRoom,
      openDirect,
      requests: { privateRequest: { status: "pending" } },
      people,
    });
    // The fixture models Home's wrapper and document-valued link to the core.
    // Only the room's manager discovery runs production Home access.
    const mid = runtime.getCell(home, "manager mid", undefined, tx);
    mid.set(manager);
    const wrapper = runtime.getCell(home, "manager wrapper", undefined, tx);
    wrapper.set({
      $UI: mid.key("$UI"),
      offerRoom: mid.key("offerRoom"),
      joinRoom: mid.key("joinRoom"),
      openDirect: mid.key("openDirect"),
      requests: mid.key("requests"),
      people: mid.key("people"),
    });
    const homeRoot = runtime.getCell(home, "Home root", undefined, tx);
    homeRoot.set({ chatManager: wrapper, profiles: [profile] });
    runtime.getSpaceCell(home, undefined, tx).key("defaultPattern").set(
      homeRoot,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return { wrapper, offerRoom };
  };

  /**
   * Creates a group room as the root of a space of its own, from a production
   * manager of the viewer's that `profile` starts chats as, and returns the
   * room. That manager only creates the room: Home's root names another as the
   * one the room's `#chatManager` wish reaches.
   */
  const createGroup = async (profile: Cell<unknown>) => {
    const home = owner.did();
    const program = {
      ...await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL("../fabrichat/manager.tsx", import.meta.url),
          ),
          root: PATTERNS,
        },
      ),
      mainExport: "FabriChatManagerCore",
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const creator = runtime.run(
      tx,
      pattern,
      { myProfile: profile },
      runtime.getCell(home, "group creator", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await creator.pull();
    const startTx = runtime.edit();
    creator.withTx(startTx).key("createGroup").send(
      trustedClick(START_ACTION, {
        requestId: "g-team",
        title: "Team",
        members: [],
      }),
    );
    expect((await startTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    const entries = await creator.key("rooms").asSchema(roomEntriesSchema)
      .pull();
    expect(entries?.length).toBe(1);
    const room = entries![0].room.resolveAsCell();
    await room.pull();
    await runtime.idle();
    return room;
  };

  /**
   * Adds Bob to a group room whose viewer's manager is `labeled` or not, and
   * lists Bob among its people, rendering the room as a viewer would before and
   * after the add, and reports what came of it: the offers the manager's
   * `offerRoom` received, the room's `addRequests`, and whom the room's space
   * grants.
   */
  const addBob = async (labeled: boolean) => {
    const profile = await writeProfile("viewer profile", "Viewer");
    const bobProfile = await writeProfile("bob profile", "Bob");
    const { offerRoom } = await writeHome(labeled, profile, {
      [BOB]: [bobProfile],
    });
    const offers: Record<string, unknown>[] = [];
    runtime.scheduler.addEventHandler((_tx, event) => {
      offers.push(event);
    }, offerRoom.getAsNormalizedFullLink());
    const room = await createGroup(profile);
    const space = room.getAsNormalizedFullLink().space;
    await render(room);
    await runtime.idle();

    const addTx = runtime.edit();
    room.withTx(addTx).key("addMember").send(
      trustedClick(ADD_MEMBER_ACTION, {
        requestId: "add-bob",
        target: { value: BOB },
      }),
    );
    expect((await addTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await render(room);
    await runtime.idle();
    const addRequests = await room.key("addRequests").asSchema({
      type: "object",
      additionalProperties: true,
    }).pull();
    const acl = (await server.readDocument(
      space as Parameters<typeof server.readDocument>[0],
      aclDocId(space) as Parameters<typeof server.readDocument>[1],
    ))?.value;
    return { space, offers, addRequests, acl };
  };

  for (const discovered of [false, true]) {
    for (const labeled of [false, true]) {
      it(`stores a shared message through a ${labeled ? "root-private" : "public"} manager's ${discovered ? "discovered" : "supplied"} flat bindings`, async () => {
        expect(runtime.cfcEnforcementMode).toBe("enforce-strict");
        const social = await runtime.createSpace({});
        const profile = await writeProfile("viewer profile", "Viewer");
        const { wrapper } = await writeHome(labeled, profile, {});

        const program = await resolveLocalProgram(
          (resolver) => runtime.harness.resolve(resolver),
          {
            main: fromFileUrl(
              new URL(
                discovered
                  ? "../fabrichat/room.tsx"
                  : "./fixtures/fabrichat-flat-manager-send/main.tsx",
                import.meta.url,
              ),
            ),
            root: PATTERNS,
          },
        );
        const roomTx = runtime.edit();
        const pattern = await runtime.patternManager.compilePattern(program, {
          space: social,
          tx: roomTx,
        });
        const room = runtime.run(
          roomTx,
          pattern,
          discovered ? {} : { profile, manager: wrapper },
          runtime.getCell(social, "room", undefined, roomTx),
        );
        runtime.prepareTxForCommit(roomTx);
        expect((await roomTx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        await room.pull();
        expect(refusals).toEqual([]);
        const click = {
          type: "click",
          requestId: "flat-manager-send",
          target: { value: "A shared message" },
          provenance: reviewedActionProvenance("dom", {
            surface: "ChatSendSurface",
            action: "ChatSend",
          }),
        };
        markRendererTrustedEvent(click);
        const sendTx = runtime.edit();
        room.withTx(sendTx).key("sendMessage").send(click);
        expect((await sendTx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        await room.pull();
        expect(await room.key("messages").key("count").pull()).toBe(1);
        expect(
          await room.key("messages").key("latest").key("messages").key(0).key(
            "body",
          ).pull(),
        ).toBe("A shared message");
        expect(refusals).toEqual([]);
      });
    }
  }

  it("offers a room to a member added through a public manager's discovered flat bindings", async () => {
    const { space, offers, addRequests, acl } = await addBob(false);

    expect(acl).toMatchObject({ [BOB]: "OWNER" });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      requestId: addMemberOfferId(space, "add-bob"),
      member: BOB,
      room: { "/": { "link@1": { space } } },
    });
    expect(addRequests).toEqual({ "add-bob": { status: "done" } });
    expect(refusals).toEqual([]);
  });

  it("offers a room to a member added through a root-private manager's discovered flat bindings", async () => {
    const { space, offers, addRequests, acl } = await addBob(true);

    expect(acl).toMatchObject({ [BOB]: "OWNER" });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      requestId: addMemberOfferId(space, "add-bob"),
      member: BOB,
      room: { "/": { "link@1": { space } } },
    });

    // Everything the room stores of the manager's data lands in the viewer's
    // own documents: the picker's list of the people `candidatesForUser`
    // reads from the manager, and the `outcomes` that merge the manager's
    // verdicts into `addRequests`, both in their per-user ones. A user or
    // session document may hold its own principal's personal data
    // (§8.12.4), so the add refuses nothing and is listed as done, as it is
    // through a public manager.
    expect(addRequests).toEqual({ "add-bob": { status: "done" } });
    expect(refusals).toEqual([]);
  });
});
