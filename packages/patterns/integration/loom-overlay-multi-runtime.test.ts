/**
 * A Loom's per-user overlay across runtimes, under an enforced access list.
 *
 * Alice owns the Loom's space and Bob is a member. A hide follows its user into
 * a runtime started after the one that wrote it closed, and survives its user
 * losing access to the Loom and regaining it; meanwhile nobody else's view
 * changes. Each case starts its runtimes late with `addSession()`, so what they
 * read comes from storage rather than from a runtime that saw it written.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "loom-overlay-fixture",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** The gesture the fixture's `grant` and `revoke` require. */
const CHANGE_ACCESS = { surface: "MembersSurface", action: "ChangeAccess" };

/** The number of entries `value` holds, or `-1` when it is not a list. */
const count = (value: unknown): number =>
  Array.isArray(value) ? value.length : -1;

describe("loom overlay across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  /** A harness of Alice, who owns the space, and Bob, a member. */
  async function aliceAndBob() {
    const alice = await Identity.fromPassphrase("loom overlay alice", {
      implementation: "noble",
    });
    const bob = await Identity.fromPassphrase("loom overlay bob", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: alice },
        { label: "bob", identity: bob },
      ],
      aclMode: "enforce",
    });
    return { harness, alice, bob };
  }

  it("keeps a hide for its user in a runtime started after the one that wrote it closed", async () => {
    const { harness, alice } = await aliceAndBob();
    const writer = harness.session("alice");
    const panel = await writer.createCell("loom-overlay-shared", {
      kind: "url",
      url: "https://example.com/shared",
    });
    await writer.send("addPanel", { panel });
    await writer.send("hidePanel", { panel });
    await harness.settle();
    await harness.closeSession("alice");

    const later = await harness.addSession({
      label: "alice-later",
      identity: alice,
    });
    await harness.waitFor(
      "alice's later runtime reads the shared panel",
      async () => count(await later.read(["panels"])) === 1,
    );
    expect(count(await later.read(["viewerPanels"]))).toBe(0);
    expect(count(await harness.session("bob").read(["viewerPanels"]))).toBe(1);
  });

  it("keeps a hide for its user through losing access to the Loom and regaining it", async () => {
    const { harness, bob } = await aliceAndBob();
    const owner = harness.session("alice");
    const member = harness.session("bob");
    const panel = await owner.createCell("loom-overlay-shared", {
      kind: "url",
      url: "https://example.com/shared",
    });
    await owner.send("addPanel", { panel });
    await harness.waitFor(
      "bob reads the shared panel",
      async () => count(await member.read(["panels"])) === 1,
    );
    await member.send("hidePanel", { panel });
    await harness.settle();
    expect(count(await member.read(["viewerPanels"]))).toBe(0);

    await owner.send(
      "revoke",
      { principal: bob.did() },
      CHANGE_ACCESS,
    );
    await harness.settle();
    await harness.closeSession("bob");
    // A runtime Bob starts while revoked cannot open the Loom at all.
    await expect(
      harness.addSession({ label: "bob-revoked", identity: bob }),
    ).rejects.toThrow("lacks READ on space");
    // Bob's hide was his alone: the owner's view still shows the panel.
    expect(count(await owner.read(["viewerPanels"]))).toBe(1);

    await owner.send(
      "grant",
      { principal: bob.did() },
      CHANGE_ACCESS,
    );
    await harness.settle();
    const returned = await harness.addSession({
      label: "bob-later",
      identity: bob,
    });
    await harness.waitFor(
      "bob's later runtime reads the shared panel",
      async () => count(await returned.read(["panels"])) === 1,
    );
    expect(count(await returned.read(["viewerPanels"]))).toBe(0);
  });
});
