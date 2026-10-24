/**
 * One browser's pass through a seeded FabriChat room, signed in as the member
 * who started it, in the steps the FabriChat room benchmarks measure
 * separately.
 *
 * Each step waits on the thing it is waiting for — a routed view, a settled
 * runtime, rendered text, a rendered control — so a step's duration is the
 * latency a person would have seen, with no polling interval added to it.
 */

import { debugStr } from "@commonfabric/data-model";
import type { DID, Identity } from "@commonfabric/identity";
import {
  Browser,
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { login, SHELL_VIEWPORT } from "@commonfabric/integration/shell-utils";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import {
  clickMarked,
  clickTrustedAction,
  fillCfInput,
  markTargetsArgs,
  settleAndMarkTargets,
  settleView,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import {
  type FabrichatRoomFixture,
  memberIdentity,
  messageHeading,
  replyBody,
  SEEDED_REACTION,
} from "./fabrichat-room-fixture.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

/** The room's main conversation, which holds one row per message. */
const MESSAGES = "#fabrichat-messages";

/** The thread pane, which holds the rows of the session's open thread. */
const THREAD = "#fabrichat-thread";

/** The main composer's field. */
const COMPOSER = "#fabrichat-message";

/** The reviewed action the main composer's send is admitted from. */
const SEND_ACTION = "ChatSend";

/** The reviewed action a reaction is admitted from. */
const REACT_ACTION = "ChatReact";

/** Worker diagnostics collected over one operation. */
export interface ReadSample {
  /** Completed reactive bodies carrying a read sample. */
  runs: number;

  /** Sum of reactive-body proxy accesses. */
  accesses: number;

  /** Largest reactive-body proxy-access count. */
  maxAccesses: number;

  /** Sum of reactive-body stored-link traversal attempts. */
  linkHops: number;

  /** Successful event-commit markers, including nested handlers. */
  eventCommits: number;

  /** Failed event-commit markers. */
  eventCommitErrors: number;
}

/** Browser runtime handle and the current diagnostic sample. */
type DiagnosticGlobal = typeof globalThis & {
  /** Shell's exposed runtime client. */
  commonfabric?: { rt?: RuntimeClient };

  /** Sample mutated by worker telemetry notifications. */
  fabrichatReadSample?: ReadSample;
};

/**
 * The rows of the main conversation whose text holds `heading`, and within
 * each, the controls `select` picks. Serialized into the page, so it closes
 * over nothing and reads only what it is passed.
 */
const findInRow = (
  probe: ProbeApi,
  heading: string,
  selector: string,
  text: string | null,
): readonly HTMLElement[] | undefined => {
  // Whether `node` lies within `ancestor`, crossing shadow roots on the way.
  const within = (node: Node, ancestor: Node): boolean => {
    for (
      let at: Node | null = node;
      at;
      at = at.parentNode ?? (at as ShadowRoot).host ?? null
    ) {
      if (at === ancestor) return true;
    }
    return false;
  };
  const messages = probe.collect("#fabrichat-messages")[0];
  if (!messages) return undefined;
  const row = probe.collect("cf-hover-reveal").find((candidate) =>
    within(candidate, messages) && probe.deepText(candidate).includes(heading)
  );
  if (!row) return undefined;
  for (const host of probe.collect(selector)) {
    if (!within(host, row)) continue;
    if (
      text !== null &&
      probe.deepText(host).replace(/\s+/g, " ").trim() !== text
    ) continue;
    const control = (host.shadowRoot?.querySelector("[data-cf-button]") ??
      host) as HTMLElement;
    // The host carries the mark: a click on the control inside it passes
    // through the host on its way, and the aim measures the host's box.
    if (
      probe.isRendered(control) && !probe.isDisabled(host) &&
      !probe.isDisabled(control)
    ) {
      return [host as HTMLElement];
    }
  }
  return undefined;
};

/**
 * Clicks the control `selector` picks in the row of the main conversation
 * whose text holds `heading`, with a trusted click, once it has rendered and
 * survived a settle. `text`, when given, is the control's whole text, its
 * white space collapsed.
 */
async function clickInRow(
  page: Page,
  heading: string,
  selector: string,
  text: string | null = null,
): Promise<void> {
  const token = `fabrichat-row-${crypto.randomUUID()}`;
  const args = markTargetsArgs(findInRow, [heading, selector, text], [token]);
  await waitForCondition(page, settleAndMarkTargets, { args });
  await clickMarked(page, {
    token,
    remark: { predicate: settleAndMarkTargets, args },
  });
}

/**
 * Whether every name in `names` is the whole text of a profile badge, which
 * is what a participant chip shows once its profile, in a space of its own,
 * has arrived.
 */
const badgesShow = (probe: ProbeApi, names: readonly string[]): boolean => {
  const shown = new Set(
    probe.collect("cf-profile-badge").map((badge) =>
      probe.deepText(badge).trim()
    ),
  );
  return names.every((name) => shown.has(name));
};

/**
 * Whether the row whose text holds `heading` shows a tally of `count` for
 * `emoji`.
 */
const rowTallies = async (
  probe: ProbeApi,
  heading: string,
  emoji: string,
  count: number,
): Promise<boolean> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;
  await settle();
  const within = (node: Node, ancestor: Node): boolean => {
    for (
      let at: Node | null = node;
      at;
      at = at.parentNode ?? (at as ShadowRoot).host ?? null
    ) {
      if (at === ancestor) return true;
    }
    return false;
  };
  const messages = probe.collect("#fabrichat-messages")[0];
  if (!messages) return false;
  const row = probe.collect("cf-hover-reveal").find((candidate) =>
    within(candidate, messages) && probe.deepText(candidate).includes(heading)
  );
  if (!row) return false;
  return probe.collect('cf-button[data-ui-action="ChatReact"]').some((host) =>
    within(host, row) &&
    probe.deepText(host).replace(/\s+/g, " ").trim() === `${emoji} ${count}`
  );
};

/** One browser, signed in as a seeded room's starter, on that room. */
export class RoomSession {
  #browser: Browser;
  #page: Page;
  #fixture: FabrichatRoomFixture;
  #identity: Identity;
  #pageErrors: string[] = [];

  private constructor(
    browser: Browser,
    page: Page,
    fixture: FabrichatRoomFixture,
    identity: Identity,
  ) {
    this.#browser = browser;
    this.#page = page;
    this.#fixture = fixture;
    this.#identity = identity;
    // A step that threw in the page may well be fast, and would be
    // meaningless. Collect the exceptions and fail the run at teardown.
    page.addEventListener("pageerror", (event) => {
      this.#pageErrors.push(event.detail.message);
    });
  }

  /** A browser with a blank page, ready for {@link load}. */
  static async open(fixture: FabrichatRoomFixture): Promise<RoomSession> {
    // Always headless: a benchmark is measured, not watched, and a visible
    // window would put compositing for a real display in the numbers.
    // The viewport is pinned as `ShellIntegration` pins it, so the room lays
    // out the same on every machine, and in its wide layout, where a row's
    // reaction picker has room beside the message.
    const browser = await Browser.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize(SHELL_VIEWPORT);
    return new RoomSession(
      browser,
      page,
      fixture,
      await memberIdentity(fixture.passphrase, 0),
    );
  }

  get page(): Page {
    return this.#page;
  }

  get fixture(): FabrichatRoomFixture {
    return this.#fixture;
  }

  /** Cold page load: the shell boots and routes to the room. */
  async load(): Promise<void> {
    const { roomSpace, roomId } = this.#fixture;
    await this.#page.goto(`${env.FRONTEND_URL}${roomSpace}/${roomId}`);
    await waitForPieceView(this.#page, roomSpace as DID, roomId);
  }

  /** Sign in, and wait for the runtime the room's data arrives through. */
  async signIn(): Promise<void> {
    await login(this.#page, this.#identity);
    await waitForRuntimeIdle(this.#page);
  }

  /**
   * Wait for the room: its last message, and a badge naming every member,
   * each read from a profile in a space of its own. The messages arrive in
   * order, so the last one rendering means every earlier one has.
   */
  async showMessages(): Promise<void> {
    const { messageCount, members } = this.#fixture;
    await waitForSettledText(
      this.#page,
      MESSAGES,
      messageHeading(messageCount - 1),
    );
    await waitForCondition(this.#page, badgesShow, {
      args: [members.map((member) => member.name)],
    });
    await settleView(this.#page);
  }

  /**
   * Types `body` into the main composer and returns the operation that sends
   * it and waits for its row. Typing writes the draft of its own accord, and
   * that write is not what the send is timed for.
   */
  async draft(body: string): Promise<() => Promise<void>> {
    await fillCfInput(this.#page, COMPOSER, body);
    await waitForRuntimeIdle(this.#page);
    return async () => {
      await clickTrustedAction(this.#page, SEND_ACTION);
      // The conversation's own rows: the same text was typed into the
      // composer before the interval started.
      await waitForSettledText(this.#page, MESSAGES, body);
    };
  }

  /**
   * Returns the operation that adds the viewer's {@link SEEDED_REACTION} to
   * the message at `index`, through the tally another member's reaction put
   * under it, and waits for the tally to count both. The message must be one
   * of the fixture's `reacted`, which no reaction of the viewer's has reached
   * yet.
   */
  reaction(index: number): () => Promise<void> {
    const heading = messageHeading(index);
    return async () => {
      await clickInRow(
        this.#page,
        heading,
        `cf-button[data-ui-action="${REACT_ACTION}"]`,
        `${SEEDED_REACTION} 1`,
      );
      await waitForCondition(this.#page, rowTallies, {
        args: [heading, SEEDED_REACTION, 2],
      });
    };
  }

  /**
   * Opens the fixture's thread at `thread` from its root's reply count, and
   * waits for every reply in the thread pane.
   */
  async openThread(thread: number): Promise<void> {
    const { root, replies } = this.#fixture.threads[thread];
    const heading = messageHeading(root);
    await clickInRow(
      this.#page,
      heading,
      "cf-button",
      replies === 1 ? "1 reply" : `${replies} replies`,
    );
    for (let reply = 0; reply < replies; reply++) {
      await waitForSettledText(this.#page, THREAD, replyBody(thread, reply));
    }
    await settleView(this.#page);
  }

  /**
   * Runs `operation` with the worker's read accounting and telemetry on, and
   * returns what they recorded. The accounting costs time, so a sample is
   * taken apart from any timed interval.
   *
   * @throws If the operation ran nothing in the worker, or an event it fired
   *   failed to commit.
   */
  async sampleReads(operation: () => Promise<void>): Promise<ReadSample> {
    await this.#page.evaluate(async () => {
      const scope = globalThis as DiagnosticGlobal;
      const rt = scope.commonfabric?.rt;
      if (!rt) throw new Error("No browser runtime");
      scope.fabrichatReadSample = {
        runs: 0,
        accesses: 0,
        maxAccesses: 0,
        linkHops: 0,
        eventCommits: 0,
        eventCommitErrors: 0,
      };
      rt.on("telemetry", (marker) => {
        const sample = scope.fabrichatReadSample!;
        if (marker.type === "scheduler.event.commit") {
          if (marker.error) sample.eventCommitErrors++;
          else sample.eventCommits++;
        }
        if (marker.type !== "scheduler.run.complete" || !marker.reads) return;
        sample.runs++;
        sample.accesses += marker.reads.proxyAccesses;
        sample.linkHops += marker.reads.linkResolutions;
        sample.maxAccesses = Math.max(
          sample.maxAccesses,
          marker.reads.proxyAccesses,
        );
      });
      await rt.setTelemetryEnabled(true);
      await rt.setReadStatsEnabled(true);
    });
    await operation();
    const sample = await this.#page.evaluate(async () => {
      const scope = globalThis as DiagnosticGlobal;
      await scope.commonfabric!.rt!.setReadStatsEnabled(false);
      await scope.commonfabric!.rt!.setTelemetryEnabled(false);
      return scope.fabrichatReadSample!;
    });
    if (sample.runs === 0) {
      throw new Error("The sampled operation ran nothing in the worker");
    }
    if (sample.eventCommitErrors !== 0) {
      throw new Error(
        debugStr`The sampled operation failed a commit: $quote,long${sample}`,
      );
    }
    return sample;
  }

  async close(): Promise<void> {
    await this.#browser.close();
    if (this.#pageErrors.length > 0) {
      throw new Error(
        `Uncaught browser exception(s) in the room:\n${
          this.#pageErrors.map((message) => `  ${message}`).join("\n")
        }`,
      );
    }
  }
}
