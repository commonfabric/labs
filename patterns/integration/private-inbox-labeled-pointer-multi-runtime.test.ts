/**
 * The multi-runtime harness driving the system private inbox for a Home in its
 * owner's home space, as a person's Home is. The Home holds an inbox shaped as
 * a loom daemon's, and its profile points at that inbox through a pointer the
 * fixture declares confidential to the owner, so Home's holder, written by a
 * run that read that pointer, and every run that reads it or the profile,
 * carries the owner's label too. Ensuring the Home's inbox creates one of its
 * own in that one's place, in a step that reads neither, retains that one, and
 * points the profile at its own, with nothing refused by the CFC write gate
 * and no event dropped. It does so for a Home with the `createOwnPrivateInbox`
 * stream, which the host has create the inbox first, and for one without it,
 * whose ensure hands the creation on itself. The fixture is
 * `private-inbox-multi-runtime.test.ts`'s.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
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

/**
 * The DID the fixture's `OWNER_LABEL` names as the owner, which has to be the
 * DID the harness derives for {@link OWNER}: a label naming any other space's
 * owner would leave the write gate nothing to refuse.
 */
const LABELED_OWNER =
  "did:key:z6MkksB58J3VAuKbsxLKa5WoUxcUfcVfU1JdeaX3x2QfVeja";

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

  /** The fixture's fields for one labeled Home. */
  type LabeledHome = {
    home: string;
    inbox: string;
    createProfile: string;
    createInbox: string;
    pointProfile: string;
    holdInbox: string;
  };

  /**
   * Has the Home `names.home` hold `names.inbox`'s inbox, which its profile
   * points at through the labeled pointer, ensures its inbox as the host
   * does, and checks that it created its own in that one's place, retained
   * that one and pointed the profile at its own, with nothing refused by the
   * write gate and no event dropped.
   */
  async function replacesTheLabeledInbox(names: LabeledHome): Promise<void> {
    expect(harness.spaceDid).toBe(LABELED_OWNER);
    await owner.send(names.createProfile);
    await owner.send(names.createInbox);
    await harness.settle();
    await owner.send(names.pointProfile, { index: 0 });
    const held = [names.home, "privateInbox", "piece"];
    const pointer = [names.home, "profiles", 0, "inbox", "piece"];
    const loom = await owner.link([names.inbox, "piece"]);
    await harness.settleUntil(async () =>
      (await owner.read(pointer)) !== undefined &&
      (await owner.link(pointer)).id === loom.id
    );
    await owner.send(names.holdInbox);
    await harness.settleUntil(async () =>
      (await owner.read(held)) !== undefined &&
      (await owner.link(held)).id === loom.id
    );
    const refusedBefore = await refusals();
    const droppedBefore = await dropped();

    const ensured = await owner.client().call("ensurePrivateInbox", {
      path: [names.home],
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
      (await owner.link([names.home, "ownPrivateInbox", "piece"]))
        .id,
    ).toBe(own.id);
    expect((await owner.link(pointer)).id).toBe(own.id);
    const retained = [names.home, "retainedPrivateInboxes"];
    expect(((await owner.readRaw(retained)) as unknown[]).length).toBe(1);
    expect((await owner.link([...retained, 0])).id).toBe(loom.id);
  }

  it("creates its own inbox in place of the one it holds, retains that one, and points the profile at its own", async () => {
    await replacesTheLabeledInbox({
      home: "labeledHoldingHome",
      inbox: "labeledHoldingInbox",
      createProfile: "createLabeledHoldingProfile",
      createInbox: "createLabeledHoldingInbox",
      pointProfile: "pointLabeledHoldingProfile",
      holdInbox: "holdLabeledHoldingInbox",
    });
  });

  it("creates its own inbox in place of the one it holds through the ensure's hand-off, for a Home without the creating stream", async () => {
    // The host creates no inbox first for this Home, so its ensure, in a run
    // that has read the labeled holder, sends the creating step its event.
    // That holds only while an event carries no label of the run that sent
    // it.

    expect(await owner.readRaw(["labeledHandOffHome", "createOwnPrivateInbox"]))
      .toBeUndefined();
    await replacesTheLabeledInbox({
      home: "labeledHandOffHome",
      inbox: "labeledHandOffInbox",
      createProfile: "createLabeledHandOffProfile",
      createInbox: "createLabeledHandOffInbox",
      pointProfile: "pointLabeledHandOffProfile",
      holdInbox: "holdLabeledHandOffInbox",
    });
  });
});
