/**
 * A member of a FabriChat room who has only watched it acts for the first time
 * through a message's row: a reaction to another member's message, then a
 * reply in that message's thread. The room records each under the member who
 * acted, with server execution on or off.
 *
 * The row and the thread's composer are instances the room's lists build, and
 * their handlers read the viewer's profile, which the room finds with its
 * `#profile` wish. The member's browser is the only client of the room while
 * they act: the member who started the room and wrote the message has closed
 * theirs.
 *
 * The posture is the one the run's servers are in. `deno task integration`
 * passes `EXPERIMENTAL_SERVER_EXECUTION` to the servers, the shell and this
 * process alike, so one run covers one posture.
 */

import { expect } from "@std/expect";

import { ConsoleEvent } from "@astral/astral";
import type { DID, Identity } from "@commonfabric/identity";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import type { Cell } from "@commonfabric/runner";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import {
  afterEach,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  fillCfInput,
  readCfInputValue,
  submitViaEnter,
  waitForDisabled,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import {
  closeMember,
  createRoom,
  enterRoom,
  memberIdentity,
  type MemberSession,
  openMember,
  writeAs,
} from "./fabrichat-room-fixture.ts";
import { clickInRow, rowTallies } from "./fabrichat-room-session.ts";
import { PieceController } from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const MESSAGES = "#fabrichat-messages";
const THREAD = "#fabrichat-thread";
const THREAD_INPUT = "#fabrichat-thread-message";

/** What the room's starter writes, which the watching member acts on. */
const MESSAGE = "Shall we meet at noon?";

/**
 * The reaction the watching member adds: the last of the picker's quick
 * reactions, which the open picker leaves clear of the message's badge.
 */
const REACTION = "🎉";

/** What the watching member replies in the message's thread. */
const REPLY = "Noon works for me.";

/** What a refusal says, wherever a runtime or a page reports one. */
const REFUSAL =
  /profile hasn't loaded|no profile|refus|reject|not[- ]permitted|write-policy-gate/i;

/** A document's address: its space and its id. */
interface Address {
  space: string;
  id: string;
}

/** The address of the document the link `cell` holds leads to. */
async function targetOf(cell: Cell<unknown>): Promise<Address> {
  const target = await cell.asSchema<Cell<unknown>>({ asCell: ["cell"] })
    .pull();
  const { space, id } = target.resolveAsCell().getAsNormalizedFullLink();
  return { space, id };
}

/**
 * Logger counts as a runtime reports them: per logger, per message key, the
 * messages logged at each level.
 */
type LoggerCounts = Record<string, unknown>;

/**
 * The messages `counts` holds as one count per `logger/key`: those at `warn`
 * or `error`, or with `every`, those at every level.
 */
function countsOf(
  counts: LoggerCounts | undefined,
  every = false,
): Map<string, number> {
  const found = new Map<string, number>();
  for (const [logger, keys] of Object.entries(counts ?? {})) {
    if (typeof keys !== "object" || keys === null) continue;
    for (const [key, levels] of Object.entries(keys)) {
      if (typeof levels !== "object" || levels === null) continue;
      const { warn, error, total } = levels as Record<string, number>;
      found.set(
        `${logger}/${key}`,
        every ? total ?? 0 : (warn ?? 0) + (error ?? 0),
      );
    }
  }
  return found;
}

/** The entries of `after` that count more than `before` did, as `key +n`. */
function grew(
  before: Map<string, number>,
  after: Map<string, number>,
): string[] {
  return [...after]
    .filter(([key, total]) => total > (before.get(key) ?? 0))
    .map(([key, total]) => `${key} +${total - (before.get(key) ?? 0)}`)
    .sort();
}

/**
 * The serving loop's logger counts, or `undefined` from a server that runs no
 * serving loop, which is one with server execution off.
 */
async function servingLoopCounts(): Promise<LoggerCounts | undefined> {
  const response = await fetch(
    new URL("api/health/serving-loop-realm", API_URL),
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`The serving loop's realm returned ${response.status}`);
  }
  return (await response.json() as { loggerCounts: LoggerCounts }).loggerCounts;
}

/** Whether the server runs a serving loop. */
async function serverServes(): Promise<boolean> {
  const response = await fetch(new URL("api/health/stats", API_URL));
  if (!response.ok) throw new Error(`Health stats returned ${response.status}`);
  return (await response.json() as { servingLoop?: unknown }).servingLoop !=
    null;
}

/** The page's runtime, and the event commits it has been told of. */
type Diagnostics = typeof globalThis & {
  commonfabric?: { rt?: RuntimeClient };
  rowFirstActCommits?: { committed: number; failed: string[] };
};

/** Starts counting the event commits `page`'s worker reports. */
async function countEventCommits(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const scope = globalThis as Diagnostics;
    const rt = scope.commonfabric?.rt;
    if (!rt) throw new Error("No browser runtime");
    const commits = { committed: 0, failed: [] as string[] };
    scope.rowFirstActCommits = commits;
    rt.on("telemetry", (marker) => {
      if (marker.type !== "scheduler.event.commit") return;
      if (marker.error) commits.failed.push(String(marker.error));
      else commits.committed++;
    });
    await rt.setTelemetryEnabled(true);
  });
}

/** The event commits counted since {@link countEventCommits}. */
async function eventCommits(
  page: Page,
): Promise<{ committed: number; failed: string[] }> {
  return await page.evaluate(async () => {
    const scope = globalThis as Diagnostics;
    await scope.commonfabric!.rt!.setTelemetryEnabled(false);
    return scope.rowFirstActCommits!;
  });
}

/** The logger counts of `page`'s worker. */
async function workerCounts(page: Page): Promise<LoggerCounts> {
  const { counts } = await page.evaluate(async () =>
    await (globalThis as Diagnostics).commonfabric!.rt!.getLoggerCounts()
  );
  return counts;
}

describe("fabrichat-row-first-act", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let starter: Identity;
  let watcher: Identity;
  let roomSpace: DID;
  let roomId: string;
  let room: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
  let starterProfile: Address;
  let watcherProfile: Address;
  let serving: boolean;

  // What the watching member's page writes to its console.
  const consoleLines: string[] = [];
  const recordConsole = (event: Event): void => {
    if (event instanceof ConsoleEvent) consoleLines.push(event.detail.text);
  };

  beforeAll(async () => {
    const apiUrl = new URL(API_URL);
    const passphrase = `fabrichat-row-first-act ${crypto.randomUUID()}`;
    starter = await memberIdentity(passphrase, 0);
    watcher = await memberIdentity(passphrase, 1);

    // The watching member has a Home and a profile, as anyone who has signed
    // in has, and their runtime here never opens the room.
    const watching = await openMember(apiUrl, watcher, 1);
    try {
      watcherProfile = await targetOf(watching.home.key("profiles").key(0));
    } finally {
      await closeMember(watching);
    }

    const starting = await openMember(apiUrl, starter, 0);
    try {
      serving = starting.controller.runtime.experimental.serverExecution ??
        SERVER_EXECUTION_DEFAULT_ENABLED;
      starterProfile = await targetOf(starting.home.key("profiles").key(0));
      const created = await createRoom(starting, [watcher]);
      roomSpace = created.space as DID;
      roomId = new PieceController(starting.controller, created).id;
      room = created.getAsNormalizedFullLink();
      await enterRoom(starting, created);
      await writeAs(starting, "the message", { target: { value: MESSAGE } }, 1);
    } finally {
      await closeMember(starting);
    }
  });

  afterEach(() => {
    shell.page().removeEventListener("console", recordConsole);
  });

  it("records a watching member's first reaction and first thread reply as that member's", async () => {
    // The servers, the shell and this process are in one posture, or the run
    // is in neither.
    expect(await serverServes()).toBe(serving);
    expect(starterProfile).not.toEqual(watcherProfile);

    const page = shell.page();
    page.addEventListener("console", recordConsole);
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: roomSpace, pieceId: roomId },
      identity: watcher,
    });
    await waitForSettledText(page, MESSAGES, MESSAGE);

    await countEventCommits(page);
    const workerBefore = countsOf(await workerCounts(page));
    const servedCountsBefore = await servingLoopCounts();
    const servedBefore = countsOf(servedCountsBefore);

    // The reaction, from the picker the row's own control opens.
    await clickInRow(page, MESSAGE, 'cf-button[aria-label="Add reaction"]');
    await clickInRow(
      page,
      MESSAGE,
      'cf-button[data-ui-action="ChatReact"]',
      REACTION,
    );
    await waitForCondition(page, rowTallies, {
      args: [MESSAGE, REACTION, 1],
    });

    // The reply, from the composer of the thread the row's control opens.
    await clickInRow(page, MESSAGE, "cf-button", "Thread");
    await waitForSettledText(page, `${THREAD} cf-heading`, MESSAGE);
    await waitForDisabled(page, THREAD_INPUT, false);
    await fillCfInput(page, THREAD_INPUT, REPLY);
    await submitViaEnter(page, THREAD_INPUT);
    await waitForSettledText(page, THREAD, REPLY);
    expect(await readCfInputValue(page, THREAD_INPUT)).toBe("");

    const commits = await eventCommits(page);
    const workerGrew = grew(workerBefore, countsOf(await workerCounts(page)));
    const servedCountsAfter = await servingLoopCounts();
    const servedGrew = grew(servedBefore, countsOf(servedCountsAfter));
    // What the serving loop logged at any level while the member acted, which
    // says whether it did anything.
    const servedActivity = grew(
      countsOf(servedCountsBefore, true),
      countsOf(servedCountsAfter, true),
    );
    const workerErrors = await page.evaluate(async () =>
      await (globalThis as Diagnostics).commonfabric!.rt!
        .getLoggerErrorMessages()
    );
    const refusedLines = consoleLines.filter((line) => REFUSAL.test(line));
    console.log(
      `fabrichat-row-first-act posture=${serving ? "on" : "off"} ` +
        `eventCommits=${commits.committed} ` +
        `eventCommitErrors=${commits.failed.length} ` +
        `consoleLines=${consoleLines.length} ` +
        `refusedConsoleLines=${refusedLines.length}`,
    );
    console.log(
      `fabrichat-row-first-act workerLoggersGrew=${JSON.stringify(workerGrew)}`,
    );
    console.log(
      `fabrichat-row-first-act servedLoggersGrew=${JSON.stringify(servedGrew)}`,
    );
    console.log(
      `fabrichat-row-first-act servedActivity=${
        JSON.stringify(servedActivity)
      }`,
    );
    console.log(
      `fabrichat-row-first-act workerErrors=${JSON.stringify(workerErrors)}`,
    );

    // The room as it is stored, read by the starter's runtime, which opens
    // the room only now that the watching member has acted.
    const reading: MemberSession = await openMember(
      new URL(API_URL),
      starter,
      0,
    );
    try {
      const runtime = reading.controller.runtime;
      const stored = await reading.controller.getPieceCell(
        runtime.getCellFromLink(room),
        true,
      );
      const messages = stored.key("messages");
      await waitForCellValue<number>(
        runtime,
        messages.key("count"),
        (count) => count === 2,
        { stuckLabel: "the stored room counts the message and the reply" },
      );

      const message = messages.key("latest").key("messages").key(0);
      const reactions = await waitForCellValue<{ emoji?: string }[]>(
        runtime,
        message.key("reactions"),
        (list) => (list ?? []).length > 0,
        { stuckLabel: "the stored message holds a reaction" },
      );
      expect(reactions.map((reaction) => reaction.emoji)).toEqual([
        REACTION,
      ]);
      expect(await targetOf(message.key("authorProfile"))).toEqual(
        starterProfile,
      );
      expect(
        await targetOf(message.key("reactions").key(0).key("reactorProfile")),
      ).toEqual(watcherProfile);

      const thread = messages.key("threads").key(0).key("messages");
      const bodies = await waitForCellValue<{ body?: unknown }[]>(
        runtime,
        thread,
        (list) => (list ?? []).some((entry) => entry?.body === REPLY),
        { stuckLabel: "the stored thread holds the reply" },
      );
      const replies = bodies.flatMap((entry, index) =>
        entry?.body === REPLY ? [index] : []
      );
      expect(replies).toHaveLength(1);
      expect(await targetOf(thread.key(replies[0]).key("authorProfile")))
        .toEqual(watcherProfile);
    } finally {
      await closeMember(reading);
    }

    // Nothing refused either act: no event the page fired failed to commit,
    // no write gate of the page's worker or of the serving loop counted a
    // refusal, and the page reported none.
    expect(commits.failed).toEqual([]);
    expect(refusedLines).toEqual([]);
    const refusals = (line: string) => REFUSAL.test(line);
    expect(workerGrew.filter(refusals)).toEqual([]);
    expect(servedGrew.filter(refusals)).toEqual([]);
  });
});
