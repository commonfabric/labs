/**
 * Scope isolation of drafts across runtimes.
 *
 * Opens one drafted chat piece in three runtimes backed by one shared
 * in-memory storage server: Alice, Bob (distinct identities), and a second
 * session for Alice. A `PerUser` draft must follow its user into another
 * session and reach no other user; a `PerSession` draft must stay in the
 * session that wrote it.
 *
 * No toolshed or browser required.
 */

import { assert } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "drafted-chat",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

describe("drafted chat scopes across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    const aliceId = await Identity.fromPassphrase("drafted-chat alice", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: aliceId },
        { label: "bob" },
        // Same user as alice, separate runtime session (≈ second browser tab).
        { label: "alice-tab2", identity: aliceId },
      ],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
    aliceTab2 = harness.session("alice-tab2");
  });

  afterAll(async () => {
    await harness?.dispose();
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
      `PerUser profileDraft leaked across users: ` +
        debugStr`bob sees $quote,long${bobDraft}`,
    );
  });

  it("keeps PerSession drafts isolated between sessions of one user", async () => {
    await alice.send("setSessionDraft", "tab-local draft");

    // The control for the two assertions below: nothing else here reads the
    // draft where it is supposed to be, so a write that never happened would
    // otherwise satisfy both of them.
    await harness.waitFor(
      "alice's own session holds the session draft",
      async () => (await alice.read(["sessionDraft"])) === "tab-local draft",
    );
    await harness.settle();

    const tab2Draft = await aliceTab2.read(["sessionDraft"]);
    assert(
      tab2Draft !== "tab-local draft",
      `PerSession sessionDraft leaked across sessions: ` +
        debugStr`tab2 sees $quote,long${tab2Draft}`,
    );
    const bobDraft = await bob.read(["sessionDraft"]);
    assert(
      bobDraft !== "tab-local draft",
      `PerSession sessionDraft leaked across users: ` +
        debugStr`bob sees $quote,long${bobDraft}`,
    );
  });
});
