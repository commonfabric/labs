/**
 * Multi-runtime tests for the CFC group chat demo.
 *
 * Each test opens the same piece in several runtimes (Alice, Bob — distinct
 * identities — plus a second session for Alice) backed by one shared
 * in-memory storage server. This exercises what neither the single-runtime
 * pattern test nor the single-page browser test can: PerUser/PerSession
 * isolation between concurrently-active users, and live propagation of
 * PerSpace state between them.
 *
 * No toolshed or browser required.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

// Trusted surface/action names from cfc-group-chat-demo/trusted.tsx (inlined
// so the test does not compile the pattern module into the test process).
const PROFILE_SURFACE = "TrustedGroupChatProfileSurface";
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const SEND_SURFACE = "TrustedGroupChatSendSurface";
const SEND_ACTION = "TrustedGroupChatSendMessage";
const ADMIN_SURFACE = "TrustedGroupChatAdminSurface";
const SET_ADMIN_ACTION = "TrustedGroupChatSetAdmin";
const ROOM_SURFACE = "TrustedGroupChatRoomSurface";
const ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "cfc-group-chat-demo",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

async function createGroupChatHarness(): Promise<MultiRuntimeHarness> {
  const alice = await Identity.fromPassphrase("group-chat alice", {
    implementation: "noble",
  });
  const apiUrl = Deno.env.get("MULTI_RUNTIME_API_URL");
  return await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    ...(apiUrl ? { apiUrl: new URL(apiUrl) } : {}),
    sessions: [
      { label: "alice", identity: alice },
      { label: "bob" },
      // Same user as alice, separate runtime session (≈ second browser tab).
      { label: "alice-tab2", identity: alice },
    ],
  });
}

let harness: MultiRuntimeHarness;
let alice: MultiRuntimeSession;
let bob: MultiRuntimeSession;
let aliceTab2: MultiRuntimeSession;

// Each helper below chains TWO events: a draft write, then a trusted
// action whose served handler reads that draft — and silently no-ops
// when it reads it empty (`prepareTrustedMessageSend` and friends
// return null on a blank draft). Events on DIFFERENT streams have no
// cross-stream serve-order guarantee (events.md §2: per stream,
// commit-seq order; across streams, no claim), so under ON a loaded
// serving loop can serve the trusted action against a pre-draft view —
// the action terminalizes cleanly as a no-op, and a downstream arrival
// wait then times out on a write that never happened (the 2026-08-22
// ON-lane flake: runs 32543810077 and 32547606642, quiescence clean,
// zero errors, next step healthy). The real UI forbids that
// interleaving — the trusted control stays disabled until the SERVED
// draft state round-trips (the browser test waits `waitForDisabled`,
// OW47 S-G) — so these helpers gate the same way: fire the trusted
// action only after the draft event's terminal consequence has arrived
// back at this session (`awaitEventConsequences`), which puts the
// draft's commit in the space's history before the action is served.
/**
 * Saves `name` as this session's profile, and waits until the session reads
 * it back.
 *
 * A user with no saved profile is inert: `prepareTrustedMessageSend` and
 * `prepareTrustedAdminToggle` each read the caller's saved profile and return
 * null without one, so that user's trusted sends and admin toggles are silent
 * no-ops. Every test below that needs a named user saves that name itself
 * rather than relying on a test above having saved it, because a lane may
 * select one test out of this file and register the rest as ignored. A save
 * updates the same profile entity every time and `registerProfile` dedupes, so
 * saving again costs a round trip and changes nothing.
 */
async function saveProfile(
  session: MultiRuntimeSession,
  name: string,
): Promise<void> {
  await session.send("setProfileDraft", name);
  await session.awaitEventConsequences();
  await session.send("saveProfile", {}, {
    surface: PROFILE_SURFACE,
    action: SAVE_PROFILE_ACTION,
  });
  await harness.waitFor(
    `${session.label} sees the profile name ${JSON.stringify(name)}`,
    async () => (await session.read(["currentProfileName"])) === name,
  );
}

/**
 * Leaves "everyone is admin" off, with alice an admin and bob not one.
 *
 * The toggle fires only where the lockdown is not already in place.
 * `currentUserAdminRole` reads `everyoneIsAdmin` to establish the caller's
 * authority only while that flag is what grants it; once alice holds an admin
 * role of her own it takes the shorter path, and the handler then writes the
 * flag without having read it, which the write policy refuses.
 */
async function lockDownAdmin(): Promise<void> {
  const registry = (await alice.read(["adminRegistry"])) as
    | { everyoneIsAdmin?: boolean }
    | undefined;
  if (registry?.everyoneIsAdmin !== false) {
    await alice.send("toggleEveryoneAdmin", { everyoneIsAdmin: false }, {
      surface: ADMIN_SURFACE,
      action: SET_ADMIN_ACTION,
    });
  }
  await harness.waitFor(
    "alice is an admin under the lockdown",
    async () => (await alice.read(["currentUserIsAdmin"])) === true,
  );
  await harness.waitFor(
    "bob is not an admin under the lockdown",
    async () => (await bob.read(["currentUserIsAdmin"])) === false,
  );
}

async function sendMessage(
  session: MultiRuntimeSession,
  body: string,
): Promise<void> {
  await session.send("setMessageDraft", body);
  await session.awaitEventConsequences();
  await session.send("sendTrustedMessage", {}, {
    surface: SEND_SURFACE,
    action: SEND_ACTION,
  });
}

async function addRoom(
  session: MultiRuntimeSession,
  name: string,
): Promise<void> {
  await session.send("setRoomDraft", name);
  await session.awaitEventConsequences();
  await session.send("addTrustedRoom", {}, {
    surface: ROOM_SURFACE,
    action: ADD_ROOM_ACTION,
  });
}

async function messages(session: MultiRuntimeSession): Promise<any[]> {
  return ((await session.read(["messages"])) as any[]) ?? [];
}

async function rooms(session: MultiRuntimeSession): Promise<any[]> {
  return ((await session.read(["rooms", "list"])) as any[] | undefined) ?? [];
}

describe("cfc group chat demo across runtimes", () => {
  beforeAll(async () => {
    harness = await createGroupChatHarness();
    alice = harness.session("alice");
    bob = harness.session("bob");
    aliceTab2 = harness.session("alice-tab2");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("shares PerSpace messages between users (harness sanity)", async () => {
    await saveProfile(alice, "Alice");

    await sendMessage(alice, "Hello from Alice");
    await harness.waitFor(
      "bob receives alice's message",
      async () =>
        (await messages(bob)).some((m) => m?.body === "Hello from Alice"),
    );
  });

  it("does not leak the profile name draft to another user", async () => {
    await alice.send("setProfileDraft", "Alice is typing");
    await harness.settle();

    // PerUser state SHOULD follow the same user into another session. This
    // also controls the assertion below: a draft that never left alice's
    // session reads at bob exactly as one that stayed put does.
    await harness.waitFor(
      "alice's second session sees her own draft",
      async () =>
        (await aliceTab2.read(["profileDraft"])) === "Alice is typing",
    );

    const bobDraft = await bob.read(["profileDraft"]);
    assert(
      bobDraft !== "Alice is typing",
      `PerUser profileDraft leaked across users: bob sees ${
        JSON.stringify(bobDraft)
      }`,
    );
  });

  it("keeps PerSession drafts isolated between sessions of one user", async () => {
    await alice.send("setHostMessageDraft", "tab-local host draft");

    // The control for the two assertions below: nothing else here reads the
    // draft where it is supposed to be, so a write that never happened would
    // otherwise satisfy both of them.
    await harness.waitFor(
      "alice's own session holds the host draft",
      async () =>
        (await alice.read(["hostMessageDraft"])) === "tab-local host draft",
    );
    await harness.settle();

    const tab2Draft = await aliceTab2.read(["hostMessageDraft"]);
    assert(
      tab2Draft !== "tab-local host draft",
      `PerSession hostMessageDraft leaked across sessions: tab2 sees ${
        JSON.stringify(tab2Draft)
      }`,
    );
    const bobDraft = await bob.read(["hostMessageDraft"]);
    assert(
      bobDraft !== "tab-local host draft",
      `PerSession hostMessageDraft leaked across users: bob sees ${
        JSON.stringify(bobDraft)
      }`,
    );
  });

  it("keeps each user's saved profile their own", async () => {
    await saveProfile(alice, "Alice");
    await saveProfile(bob, "Bob");
    await harness.settle();

    // Bob saving must not clobber Alice's PerUser profile.
    assertEquals(
      await alice.read(["currentProfileName"]),
      "Alice",
      "alice's profile was clobbered by bob saving his",
    );
    assertEquals(
      await aliceTab2.read(["currentProfileName"]),
      "Alice",
      "alice's profile (second session) was clobbered by bob saving his",
    );
  });

  it("shows other users' actual profile names, not unnamed placeholders", async () => {
    await saveProfile(alice, "Alice");
    await saveProfile(bob, "Bob");

    await sendMessage(bob, "Hi, this is Bob");
    await harness.waitFor(
      "alice receives bob's message",
      async () =>
        (await messages(alice)).some((m) => m?.body === "Hi, this is Bob"),
    );

    const aliceView = (await messages(alice)).find(
      (m) => m?.body === "Hi, this is Bob",
    );
    assertEquals(
      aliceView?.authorName,
      "Bob",
      "message author snapshot name wrong in alice's runtime",
    );
    // The live profile behind the message must resolve for OTHER users too —
    // this is what the participants list and admin panel display.
    assertEquals(
      aliceView?.authorProfile?.name,
      "Bob",
      "bob's profile does not resolve to his name in alice's runtime",
    );

    // The shared profile registry must expose both names to everyone.
    const profilesFromAlice = ((await alice.read(["profiles"])) as any[]) ?? [];
    const namesFromAlice = profilesFromAlice
      .map((entry) => entry?.profile?.name)
      .toSorted();
    expect(namesFromAlice, "alice cannot resolve all registered profile names")
      .toEqual(["Alice", "Bob"]);
  });

  it("admin lockdown gates room creation but never message sending", async () => {
    await saveProfile(alice, "Alice");
    await saveProfile(bob, "Bob");
    await lockDownAdmin();

    // Posting messages is NOT admin-gated: both users must still be able
    // to send.
    await sendMessage(bob, "Bob posts after lockdown");
    await harness.waitFor(
      "bob's post-lockdown message arrives at alice",
      async () =>
        (await messages(alice)).some(
          (m) => m?.body === "Bob posts after lockdown",
        ),
    );
    await sendMessage(alice, "Alice posts after lockdown");
    await harness.waitFor(
      "alice's post-lockdown message arrives at bob",
      async () =>
        (await messages(bob)).some(
          (m) => m?.body === "Alice posts after lockdown",
        ),
    );

    // Room creation IS admin-gated: bob's attempt must be rejected…
    await addRoom(bob, "Bob's room");
    await harness.settle();
    expect(
      (await rooms(alice)).map((room) => room?.name),
      "non-admin bob was able to add a room",
    ).toEqual([]);

    // …while admin alice's succeeds.
    await addRoom(alice, "Ops");
    await harness.waitFor(
      "bob sees the room alice added",
      async () => (await rooms(bob)).some((room) => room?.name === "Ops"),
    );
  });

  it("admins can grant admin to another user by name", async () => {
    await saveProfile(alice, "Alice");
    await saveProfile(bob, "Bob");
    await lockDownAdmin();

    await alice.send("toggleParticipantAdmin", { name: "Bob" }, {
      surface: ADMIN_SURFACE,
      action: SET_ADMIN_ACTION,
    });
    await harness.waitFor(
      "bob becomes admin after alice grants it",
      async () => (await bob.read(["currentUserIsAdmin"])) === true,
    );

    await addRoom(bob, "Bob's own room");
    await harness.waitFor(
      "bob can add a room once admin",
      async () =>
        (await rooms(alice)).some((room) => room?.name === "Bob's own room"),
    );
  });
});
