/**
 * The multi-runtime harness driving the system private inbox for a Home in its
 * owner's home space, as a person's Home is. The Home holds an inbox shaped as
 * a loom daemon's, and its profile points at that inbox through a pointer the
 * fixture declares confidential to the owner, so Home's holder, written by a
 * run that read that pointer, and every run that reads it or the profile,
 * carries the owner's label too. Ensuring the Home's inbox creates one of its own in that one's place,
 * in a step that reads neither, retains that one, and points the profile at
 * its own, with nothing refused by the CFC write gate and no event dropped. The fixture is
 * `private-inbox-multi-runtime.test.ts`'s.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "private-inbox",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/**
 * The owner's session, whose DID the fixture's label names, and whose home
 * space the harness's space is.
 */
const OWNER = "private-inbox-owner";

/** One runtime's logger counts, by logger and then by key. */
type LoggerCounts = Record<
  string,
  Record<string, { total: number; warn?: number }> | number
>;

/** The CFC write gate's refusals, out of one runtime's logger counts. */
const writeRefusals = (counts: LoggerCounts): number => {
  const cfc = counts.cfc;
  return typeof cfc === "object" ? cfc["write-policy-gate"]?.total ?? 0 : 0;
};

/**
 * The events dropped for want of a handler to take them, out of one runtime's
 * logger counts: the scheduler warns under its `scheduler` key for each one,
 * and for nothing else.
 */
const droppedEvents = (counts: LoggerCounts): number => {
  const scheduler = counts.scheduler;
  return typeof scheduler === "object" ? scheduler.scheduler?.warn ?? 0 : 0;
};

/** What the host found when it ensured a Home's inbox. */
type HostEnsure = {
  outcome: string;
  inboxes?: { id: string; space: string }[];
};

describe("private inbox through a labeled pointer across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;

  /**
   * How many commits the CFC write gate has refused, in the owner's runtime and
   * where the serving loop runs.
   */
  const refusals = async (): Promise<number> =>
    writeRefusals(await owner.loggerCounts()) +
    writeRefusals((await harness.servingDiagnostics()).loggerCounts);

  /**
   * How many events have been dropped for want of a handler, in the owner's
   * runtime and where the serving loop runs.
   */
  const dropped = async (): Promise<number> =>
    droppedEvents(await owner.loggerCounts()) +
    droppedEvents((await harness.servingDiagnostics()).loggerCounts);

  beforeAll(async () => {
    const home = (await Identity.fromPassphrase(
      `multi-runtime-harness ${OWNER}`,
      { implementation: "noble" },
    )).did();
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [OWNER],
      spaceDid: home,
    });
    [owner] = harness.sessions;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("creates its own inbox in place of the one it holds, retains that one, and points the profile at its own", async () => {
    await owner.send("createLabeledHoldingProfile");
    await owner.send("createLabeledHoldingInbox");
    await harness.settle();
    await owner.send("pointLabeledHoldingProfile", { index: 0 });
    const held = ["labeledHoldingHome", "privateInbox", "piece"];
    const pointer = ["labeledHoldingHome", "profiles", 0, "inbox", "piece"];
    const loom = await owner.link(["labeledHoldingInbox", "piece"]);
    await harness.settleUntil(async () =>
      (await owner.read(pointer)) !== undefined &&
      (await owner.link(pointer)).id === loom.id
    );
    await owner.send("holdLabeledHoldingInbox");
    await harness.settleUntil(async () =>
      (await owner.read(held)) !== undefined &&
      (await owner.link(held)).id === loom.id
    );
    const refusedBefore = await refusals();
    const droppedBefore = await dropped();

    const ensured = await owner.client().call("ensurePrivateInbox", {
      path: ["labeledHoldingHome"],
    }) as HostEnsure;
    // A refusal ends the wait too, so that a refused creation fails the
    // assertions below rather than leaving the wait to time out.
    await harness.settleUntil(async () =>
      (await refusals()) > refusedBefore ||
      (await owner.link(pointer)).id !== loom.id
    );

    expect(ensured.outcome).toBe("replace");
    expect(ensured.inboxes?.[0].space).toBe(loom.space);
    expect(await refusals()).toBe(refusedBefore);
    expect(await dropped()).toBe(droppedBefore);
    const own = await owner.link(held);
    expect(own.space).not.toBe(loom.space);
    expect(own.space).not.toBe(harness.spaceDid);
    expect(
      (await owner.link(["labeledHoldingHome", "ownPrivateInbox", "piece"]))
        .id,
    ).toBe(own.id);
    expect((await owner.link(pointer)).id).toBe(own.id);
    const retained = ["labeledHoldingHome", "retainedPrivateInboxes"];
    expect(((await owner.readRaw(retained)) as unknown[]).length).toBe(1);
    expect((await owner.link([...retained, 0])).id).toBe(loom.id);
  });
});
