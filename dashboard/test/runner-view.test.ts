import { expect } from "@std/expect";
import { type Board, buildBoard, type Runner, type RunnersMessage, RunPalette } from "../runner-board.ts";
import type { ActiveJob, JobNews, Outcome } from "../runner-jobs.ts";
import { BOARD_INSET } from "../runner-layout.ts";
import {
  BOARD_WIDTH,
  followRunners,
  openedSocket,
  OUTCOME_COLORS,
  type PageSocket,
  type RunnersElements,
  RunnersView,
  SOCKET_CHECK_MS,
} from "../runner-view.ts";
import { type Circle, context2dOf, installBrowser, type Mark, webglOf } from "./fake-browser.ts";
import { afterEach, beforeEach, describe, it } from "@commonfabric/test-support/test";

// The page's elements, with the page's IDs, added to the document, the board
// shown at the size it is laid out, at the window's corner.
function mount(): RunnersElements {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string) => {
    const made = document.createElement(tag);
    made.id = id;
    return made;
  };
  const board = element("div", "board");
  const chrome = element("canvas", "chrome");
  const balls = element("canvas", "balls");
  const effects = element("canvas", "effects");
  const tooltip = element("div", "tooltip");
  tooltip.hidden = true;
  board.append(chrome, balls, effects, tooltip);
  const legend = element("div", "legend");
  const badge = element("div", "live-badge");
  badge.textContent = "● LIVE";
  document.body.append(badge, board, legend);
  return { board, chrome, balls, effects, legend, tooltip, badge };
}

// Shows `board` `width` by `height` pixels of the page inside a border
// `border` pixels wide, its outer edge at `left`, `top` in the window.
function place(
  board: HTMLElement,
  { left = 0, top = 0, border = 0, width = BOARD_WIDTH, height = 600 } = {},
): void {
  Object.defineProperties(board, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
    clientLeft: { configurable: true, value: border },
    clientTop: { configurable: true, value: border },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left, top, width: width + 2 * border, height: height + 2 * border }),
    },
  });
}

// Makes `tooltip` take `width` by `height` pixels wherever it is.
function sizeTooltip(tooltip: HTMLElement, width: number, height: number): void {
  Object.defineProperty(tooltip, "getBoundingClientRect", { configurable: true, value: () => ({ width, height }) });
}

// Points at `x`, `y` in the window, over the board.
function pointAt(board: HTMLElement, x: number, y: number): void {
  board.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }));
}

// Clicks at `x`, `y` in the window, over the board.
function clickAt(board: HTMLElement, x: number, y: number): void {
  board.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y }));
}

// What the tooltip says, or `null` while it is hidden.
function named(elements: RunnersElements): string | null {
  return elements.tooltip.hidden ? null : elements.tooltip.textContent;
}

// The balls of jobs on the board, as last drawn.
function shown(elements: RunnersElements): readonly Circle[] {
  return webglOf(elements.balls).shown;
}

// The one ball on the board.
function onlyBall(elements: RunnersElements): Circle {
  const balls = shown(elements);
  if (balls.length !== 1) throw new Error(`${balls.length} balls were drawn, not one`);
  return balls[0];
}

// The circles stroked on `canvas`, each with its color and opacity.
function outlines(canvas: HTMLCanvasElement): { x: number; y: number; r: number; color: string; alpha: number }[] {
  return context2dOf(canvas).marks.flatMap((mark) => {
    const [shape] = mark.kind === "stroke" && mark.shapes.length === 1 ? mark.shapes : [];
    return shape?.kind === "circle" && mark.kind === "stroke"
      ? [{ x: shape.x, y: shape.y, r: shape.r, color: mark.color, alpha: mark.alpha }]
      : [];
  });
}

// The lines of text on `canvas`, each with its color.
function texts(canvas: HTMLCanvasElement): { text: string; color: string }[] {
  return context2dOf(canvas).marks.flatMap((mark) => mark.kind === "text" ? [{ text: mark.text, color: mark.color }] : []);
}

// The marks on the effects canvas.
function effects(elements: RunnersElements): readonly Mark[] {
  return context2dOf(elements.effects).marks;
}

// The legend's lines, each its title and job count.
function legendLines(legend: HTMLElement): string[][] {
  return [...legend.querySelectorAll(".run")].map((line) => [
    line.querySelector(".title")?.textContent ?? "",
    line.querySelector(".jobs")?.textContent ?? "",
  ]);
}

// A job running, or with `running: false` queued, in repository `labs`.
function job(id: number, runId: number, fields: Partial<ActiveJob> = {}): ActiveJob {
  return {
    id,
    runId,
    attempt: 1,
    owner: "acme",
    repository: "labs",
    workflow: "CI",
    branch: "main",
    sha: "a".repeat(40),
    name: `job ${id}`,
    running: true,
    since: null,
    labels: ["self-hosted", "labs"],
    runner: null,
    runnerGroup: "Default",
    url: `https://github.com/acme/labs/actions/runs/${runId}/job/${id}`,
    ...fields,
  };
}

// A job running on one of GitHub's own runners, which the board gives a
// place in a box of places.
function hostedJob(id: number, runId: number): ActiveJob {
  return job(id, runId, { runner: "GitHub Actions 5", runnerGroup: "GitHub Actions", labels: ["ubuntu-latest"] });
}

// A runner of machine `ci-mac-01`, which takes the jobs labeled `labs`.
function runner(name: string, online = true): Runner {
  return { owner: "acme", name, labels: ["self-hosted", "macOS", "ci-mac-01", "labs"], online };
}

const RUNNERS = [runner("ci-mac-01-1"), runner("ci-mac-01-2")];

// So many runners that their slots fit on the board only made smaller.
const MANY_RUNNERS = Array.from({ length: 600 }, (_, i) => runner(`ci-mac-01-${i + 1}`));

// The board of `jobs` on `runners`, with the pull requests `pulls` names and
// `problems`.
function boardOf(
  jobs: readonly ActiveJob[],
  { pulls = new Map(), runners = RUNNERS, problems = [] }: {
    pulls?: ReadonlyMap<number, number>;
    runners?: readonly Runner[];
    problems?: readonly string[];
  } = {},
): Board {
  return buildBoard(jobs, runners, [], (runId) => pulls.get(runId), problems);
}

const noOutcome = (): Outcome | undefined => undefined;

// The color of run `runId` on `board`, as a view showing only it gives it.
function runColor(board: Board, runId: string): string {
  const palette = new RunPalette();
  palette.update(board.runs);
  return palette.color(runId);
}

// A view of `elements` that moves what it shows unless `still`, and the
// pages it opens.
function viewOf(elements: RunnersElements, still = false): { view: RunnersView; opened: string[] } {
  const opened: string[] = [];
  return { view: new RunnersView(elements, (url) => opened.push(url), () => still), opened };
}

const DESCRIPTION = "labs · CI on main @ aaaaaaa\nbuild\nRunning on ci-mac-01-1";

// A promise, and what settles it.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve = (_value: T) => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// A socket that delivers what the test says, as the server's would.
class FakeSocket implements PageSocket {
  #listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  #listening = deferred<void>();
  #closed = deferred<void>();
  #closes = 0;
  #sent: unknown[] = [];

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    if (this.#listeners.has("message") && this.#listeners.has("close")) this.#listening.resolve();
  }

  /** Resolves once something listens for both the socket's messages and its closing. */
  get listening(): Promise<void> {
    return this.#listening.promise;
  }

  /** What the page has sent on the socket, each message read as JSON. */
  get sent(): readonly unknown[] {
    return this.#sent;
  }

  /** Resolves once the page has closed the socket. */
  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  /** How many times the page has closed the socket. */
  get closes(): number {
    return this.#closes;
  }

  /** Delivers `message`, as JSON. */
  deliver(message: RunnersMessage): void {
    this.deliverText(JSON.stringify(message));
  }

  /** Delivers `data` as a message. */
  deliverText(data: string): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.#listeners.get("message") ?? []) listener(event);
  }

  /** Takes `data` from the page. */
  send(data: string): void {
    this.#sent.push(JSON.parse(data));
  }

  /** Closes the socket, as the page does, which then tells what listens. */
  close(): void {
    this.#closes++;
    this.#closed.resolve();
    this.drop();
  }

  /** Closes the socket from the server's end, which tells what listens. */
  drop(): void {
    for (const listener of this.#listeners.get("close") ?? []) listener(new MessageEvent("close"));
  }
}

// What never checks the page's socket, for the tests that do not.
const never = (): void => {};

// The runners page following fake sockets, each one it opened, by URL, once
// it listens to the first, its sockets checked by `every` and timed by `now`.
async function follow(
  elements: RunnersElements,
  every: (check: () => void) => void = never,
  now: () => number = Date.now,
): Promise<{ view: RunnersView; opened: [string, FakeSocket][] }> {
  const opened: [string, FakeSocket][] = [];
  const view = followRunners("ws://runners.test/socket", "v1", elements, (url) => {
    const socket = new FakeSocket();
    opened.push([url, socket]);
    return socket;
  }, every, now);
  await opened[0][1].listening;
  return { view, opened };
}

// A clock the test moves, and the page's check of its socket, once the page
// has given it.
function checkedClock(): {
  every: (check: () => void) => void;
  now: () => number;
  check: () => void;
  advance: (milliseconds: number) => void;
} {
  let time = 1_000_000;
  let registered: (() => void) | undefined;
  return {
    every: (check) => {
      registered = check;
    },
    now: () => time,
    check: () => {
      if (registered === undefined) throw new Error("the page never asked to check its socket");
      registered();
    },
    advance: (milliseconds) => {
      time += milliseconds;
    },
  };
}

// The snapshot a socket opens with, holding `jobs` on `runners`, and the
// jobs' ends `outcomes`.
function snapshot(
  jobs: readonly ActiveJob[],
  { problems = [], runners = RUNNERS, outcomes = [], version = "v1", runs = [] }: {
    problems?: readonly string[];
    runners?: readonly Runner[];
    outcomes?: readonly (readonly [number, Outcome])[];
    version?: string;
    runs?: readonly (readonly [number, number, number])[];
  } = {},
): RunnersMessage {
  return {
    type: "snapshot",
    version,
    tracker: { jobs, runs, pullRequests: [[4, 12]], outcomes },
    runners,
    larger: [],
    problems,
  };
}

// News that job `id` of attempt `attempt` of run `runId` is queued.
function queuedNews(id: number, runId: number, repository: string, attempt = 1): JobNews {
  return {
    kind: "job",
    id,
    runId,
    attempt,
    owner: "acme",
    repository,
    workflow: "CI",
    branch: "main",
    sha: "c".repeat(40),
    name: `job ${id}`,
    status: "queued",
    conclusion: null,
    labels: ["self-hosted", "labs"],
    runner: null,
    runnerGroup: null,
    createdAt: null,
    startedAt: null,
    url: `https://github.com/acme/${repository}/actions/runs/${runId}/job/${id}`,
  };
}

// What the badge says, and whether it is marked offline.
function badgeOf(elements: RunnersElements): [string, boolean] {
  return [elements.badge.textContent ?? "", elements.badge.classList.contains("offline")];
}

const LIVE: [string, boolean] = ["● LIVE", false];
const OFFLINE: [string, boolean] = ["● OFFLINE", true];

describe("runner-view", () => {
  let browser: ReturnType<typeof installBrowser>;
  beforeEach(() => {
    browser = installBrowser();
  });
  afterEach(() => browser.uninstall());

  describe("RunnersView", () => {
    describe("constructor()", () => {
      it("opens the page of a job whose ball is clicked in a tab of its own when given nothing else to open it with", () => {
        const elements = mount();
        new RunnersView(elements, undefined, () => false).show(
          boardOf([job(1, 7, { runner: "ci-mac-01-1" })]),
          noOutcome,
          true,
        );
        browser.frame();
        const ball = onlyBall(elements);
        clickAt(elements.board, ball.x, ball.y);
        expect(browser.opened).toEqual([["https://github.com/acme/labs/actions/runs/7/job/1", "_blank", "noopener"]]);
      });

      for (
        const [reason, still, set] of [
          ["while the reader asks for less motion", true, () => browser.reducedMotion = true],
          ["while the page is hidden", true, () => browser.setHidden(true)],
          ["while the page is shown to a reader who asks for nothing", false, () => {}],
        ] as const
      ) {
        it(`${still ? "keeps the board still" : "moves the board"} by default ${reason}`, () => {
          const elements = mount();
          set();
          const view = new RunnersView(elements);
          view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
          view.show(boardOf([]), () => "passed", false);
          expect(view.counts).toEqual({ shown: 0, leaving: still ? 0 : 1 });
        });
      }
    });

    describe("instance members", () => {
      describe("show()", () => {
        it("lists each run in the legend alphabetically, numbers in order, with how many of its jobs show", () => {
          const elements = mount();
          const { view } = viewOf(elements);
          view.show(
            boardOf(
              [
                job(1, 1, { repository: "beta", running: false }),
                job(2, 1, { repository: "beta", running: false }),
                job(3, 2, { repository: "alpha", running: false }),
                job(4, 3, { running: false }),
                job(5, 4, { running: false }),
              ],
              { pulls: new Map([[3, 10], [4, 9]]) },
            ),
            noOutcome,
            true,
          );
          expect(legendLines(elements.legend)).toEqual([
            ["alpha · CI on main @ aaaaaaa", "1 job"],
            ["beta · CI on main @ aaaaaaa", "2 jobs"],
            ["labs PR #9 · CI @ aaaaaaa", "1 job"],
            ["labs PR #10 · CI @ aaaaaaa", "1 job"],
          ]);
          expect(view.counts).toEqual({ shown: 5, leaving: 0 });
          expect(elements.legend.querySelector(".empty")).toBeNull();

          view.show(boardOf([]), noOutcome, true);
          expect(legendLines(elements.legend)).toEqual([]);
          expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
          expect(view.counts).toEqual({ shown: 0, leaving: 0 });
        });

        it("links each run in the legend to its page on GitHub in a tab of its own, beside a swatch of its color", () => {
          const elements = mount();
          const { view } = viewOf(elements);
          const board = boardOf([
            job(1, 7, { repository: "alpha", running: false }),
            job(2, 8, { repository: "beta", running: false }),
          ]);
          view.show(board, noOutcome, true);
          const lines = [...elements.legend.querySelectorAll(".run")];
          expect(lines.map((line) => {
            const title = line.querySelector("a");
            return [title?.href, title?.target, title?.rel, line.querySelector<HTMLElement>(".swatch")?.style.background];
          })).toEqual([
            ["https://github.com/acme/alpha/actions/runs/7", "_blank", "noopener", runColor(board, "7")],
            ["https://github.com/acme/beta/actions/runs/8", "_blank", "noopener", runColor(board, "8")],
          ]);
          expect(runColor(board, "7")).not.toBe(runColor(board, "8"));
        });

        it("labels the board with its summary, and gives each line of the legend the role of a list item", () => {
          const elements = mount();
          const { view } = viewOf(elements);
          view.show(
            boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 8, { repository: "beta", running: false })]),
            noOutcome,
            true,
          );
          expect(elements.board.getAttribute("aria-label")).toBe("1 running · 1 queued · 1 of 2 machine runners idle");
          expect([...elements.legend.querySelectorAll(".run")].map((line) => line.getAttribute("role")))
            .toEqual(["listitem", "listitem"]);

          view.show(boardOf([]), noOutcome, true);
          expect(elements.board.getAttribute("aria-label")).toBe("0 running · 0 queued · 2 of 2 machine runners idle");
          expect(elements.legend.querySelector(".empty")?.getAttribute("role")).toBe("listitem");
        });

        describe("the board", () => {
          it("draws each pool and each box, and the summary, headings, and details in the page's colors", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            const marks = context2dOf(elements.chrome).marks;
            const boxes = (alpha: number) =>
              marks.filter((mark) => mark.kind === "fill" && mark.alpha === alpha && mark.color === "#202020").length;
            expect([boxes(0.035), boxes(0.05)]).toEqual([1, 1]);
            expect(texts(elements.chrome)).toEqual(expect.arrayContaining([
              { text: "1 running · 0 queued · 1 of 2 machine runners idle", color: "#202020" },
              { text: "ci-mac-01", color: "#202020" },
              { text: "self-hosted macOS · labs", color: "#606060" },
            ]));
          });

          it("draws a problem in red, cut short with an ellipsis to as much of it as fits when too long", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            // The fake context measures each character of the board's 10
            // pixel detail font 6 pixels wide.
            const fits = Math.floor((BOARD_WIDTH - 2 * BOARD_INSET) / 6);
            const red = () => texts(elements.chrome).filter(({ color }) => color === OUTCOME_COLORS.failed);
            view.show(boardOf([], { problems: ["Short"] }), noOutcome, true);
            expect(red()).toEqual([{ text: "Short", color: OUTCOME_COLORS.failed }]);
            view.show(boardOf([], { problems: ["W".repeat(fits)] }), noOutcome, true);
            expect(red()).toEqual([{ text: "W".repeat(fits), color: OUTCOME_COLORS.failed }]);
            view.show(boardOf([], { problems: ["W".repeat(fits + 1)] }), noOutcome, true);
            expect(red()).toEqual([{ text: `${"W".repeat(fits - 1)}…`, color: OUTCOME_COLORS.failed }]);
          });

          it("outlines each runner's slot, labeling an idle one with its runner's name, or its first letter where that is too long", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(
              boardOf([job(1, 7, { runner: "ci-mac-01-1" })], {
                runners: [...RUNNERS, runner("ci-mac-01-builder")],
              }),
              noOutcome,
              true,
            );
            browser.frame();
            const ball = onlyBall(elements);
            const slots = outlines(elements.chrome);
            expect(slots.map(({ x, y, color }) => [x - ball.x, y - ball.y, color])).toEqual([
              [0, 0, "#909090"],
              [24, 0, "#909090"],
              [48, 0, "#909090"],
            ]);
            const labels = texts(elements.chrome).filter(({ text }) => ["1", "2", "b", "builder"].includes(text));
            expect(labels).toEqual([{ text: "2", color: "#909090" }, { text: "b", color: "#909090" }]);
          });

          it("outlines a place in a box of places only while it is empty", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([hostedJob(1, 7)], { runners: [] }), noOutcome, true);
            expect(outlines(elements.chrome)).toEqual([]);
            view.show(boardOf([], { runners: [] }), noOutcome, false);
            browser.frame();
            expect(outlines(elements.chrome)).toHaveLength(1);
          });

          it("outlines an offline runner's slot in red and crosses it out", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([], { runners: [runner("ci-mac-01-1", false)] }), noOutcome, true);
            const [slot] = outlines(elements.chrome);
            expect(slot.color).toBe(OUTCOME_COLORS.failed);
            const cross = context2dOf(elements.chrome).marks.filter((mark) =>
              mark.kind === "stroke" && mark.shapes.some((shape) => shape.kind === "line")
            );
            expect(cross).toHaveLength(1);
            expect(texts(elements.chrome).map(({ text }) => text)).not.toContain("1");
          });

          it("labels no slot once the slots are too small to hold a label", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            const runners = Array.from({ length: 1000 }, (_, i) => runner(`ci-mac-01-${i + 1}`));
            view.show(boardOf([], { runners: runners.slice(0, 600) }), noOutcome, true);
            expect(texts(elements.chrome).map(({ text }) => text)).toContain("2");
            view.show(boardOf([], { runners }), noOutcome, true);
            expect(outlines(elements.chrome)).toHaveLength(runners.length);
            expect(texts(elements.chrome).map(({ text }) => text)).not.toContain("2");
          });

          it("lets the slots grow again when asked to regrow, and only then", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            const size = () => outlines(elements.chrome)[0].r;
            view.show(boardOf([], { runners: MANY_RUNNERS }), noOutcome, true);
            const crowded = size();
            view.show(boardOf([]), noOutcome, false);
            expect(size()).toBe(crowded);
            view.show(boardOf([]), noOutcome, false, true);
            const roomy = size();
            expect(roomy).toBeGreaterThan(crowded + 2);
            view.show(boardOf([]), noOutcome, true);
            expect(size()).toBe(roomy);
          });

          it("keeps a pool that has gone empty while it fits, and forgets it once keeping it would make the circles smaller", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            const headings = () =>
              texts(elements.chrome).filter(({ text, color }) => text.startsWith("ci-mac") && color === "#202020")
                .map(({ text }) => text);
            const other = { ...runner("ci-mac-02-1"), labels: ["self-hosted", "macOS", "ci-mac-02", "labs"] };
            view.show(boardOf([], { runners: [runner("ci-mac-01-1"), other] }), noOutcome, true);
            expect(headings()).toEqual(["ci-mac"]);
            view.show(boardOf([], { runners: [runner("ci-mac-01-1")] }), noOutcome, false);
            expect(headings()).toEqual(["ci-mac", "ci-mac-01"]);
            view.show(boardOf([], { runners: MANY_RUNNERS }), noOutcome, false);
            expect(headings()).toEqual(["ci-mac-01"]);
          });
        });

        describe("the balls", () => {
          it("draws each running job's ball in its run's color in its runner's slot, and draws no more frames after", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            const board = boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 8, { runner: "ci-mac-01-2" })], {
              runners: [...RUNNERS, runner("ci-mac-01-3")],
            });
            view.show(board, noOutcome, true);
            const [first, second] = outlines(elements.chrome);
            browser.frame();
            expect(shown(elements)).toEqual([
              { x: first.x, y: first.y, r: 8, color: runColor(board, "7"), clip: null },
              { x: second.x, y: second.y, r: 8, color: runColor(board, "8"), clip: null },
            ]);
            expect(browser.framesAsked).toBe(0);
          });

          it("draws no frames for a board shown again unchanged, and draws frames while a ball moves to a new slot", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const before = onlyBall(elements);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, false);
            browser.frame();
            expect(browser.framesAsked).toBe(0);
            expect(onlyBall(elements)).toEqual(before);

            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-2" })]), noOutcome, false);
            browser.frame();
            browser.frame(1 / 30);
            const moving = onlyBall(elements);
            expect(moving.x).toBeGreaterThan(before.x);
            expect(browser.framesAsked).toBe(1);
            browser.frameUntil(() => browser.framesAsked === 0);
            const after = onlyBall(elements);
            expect(after.x).toBeGreaterThan(moving.x);
            expect([after.x - before.x, after.y - before.y, after.r]).toEqual([24, 0, 8]);
          });

          it("puts a running job in its new slot at once while the view is to stay still", () => {
            const elements = mount();
            const { view } = viewOf(elements, true);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const before = onlyBall(elements);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-2" })]), noOutcome, false);
            browser.frame();
            expect(onlyBall(elements).x - before.x).toBe(24);
            expect(browser.framesAsked).toBe(0);
          });

          it("grows a ball coming onto the board into sight, and puts it there whole while the view is to stay still", () => {
            for (const still of [false, true]) {
              const elements = mount();
              const { view } = viewOf(elements, still);
              view.show(boardOf([]), noOutcome, true);
              view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, false);
              browser.frame();
              const first = onlyBall(elements).r;
              browser.frameUntil(() => browser.framesAsked === 0);
              expect([first < 8, onlyBall(elements).r]).toEqual([!still, 8]);
            }
          });

          it("grows a ball to the size of its new place when the slots grow", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            const runners = [...MANY_RUNNERS.slice(0, 599), runner("ci-mac-01-x")];
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })], { runners }), noOutcome, true);
            browser.frame();
            const crowded = onlyBall(elements).r;
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, false, true);
            browser.frame(0.1);
            const growing = onlyBall(elements).r;
            browser.frameUntil(() => browser.framesAsked === 0);
            expect(crowded).toBeLessThan(growing);
            expect(growing).toBeLessThan(8);
            expect(onlyBall(elements).r).toBe(8);
          });

          it("draws its balls again once the browser restores a WebGL context it lost, and not before", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const ball = onlyBall(elements);
            const gl = webglOf(elements.balls);
            gl.lose();
            expect(browser.framesAsked).toBe(0);
            gl.restore();
            expect(browser.framesAsked).toBe(1);
            browser.frame();
            expect(shown(elements)).toEqual([ball]);
          });
        });

        describe("the jobs that end", () => {
          // Shows a running job on a board, then a board without it, its job
          // having ended with `outcome`, in a view that moves unless `still`.
          function ended(outcome: Outcome | undefined, still = false): { elements: RunnersElements; view: RunnersView; ball: Circle } {
            const elements = mount();
            const { view } = viewOf(elements, still);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const ball = onlyBall(elements);
            view.show(boardOf([]), () => outcome, false);
            return { elements, view, ball };
          }

          // The circles filled on the effects canvas, with their colors and opacity.
          function leaving(elements: RunnersElements): { x: number; y: number; r: number; color: string; alpha: number }[] {
            return effects(elements).flatMap((mark) =>
              mark.kind === "fill"
                ? mark.shapes.flatMap((shape) => shape.kind === "circle" ? [{ x: shape.x, y: shape.y, r: shape.r, color: mark.color, alpha: mark.alpha }] : [])
                : []
            );
          }

          // The marks the leaving balls carry.
          function signs(elements: RunnersElements): string[] {
            return effects(elements).flatMap((mark) => mark.kind === "text" ? [mark.text] : []);
          }

          it("sends a job that passed off the board from where it was, outlined in green with a check", () => {
            const { elements, view, ball } = ended("passed");
            expect(view.counts).toEqual({ shown: 0, leaving: 1 });
            browser.frame();
            expect(shown(elements)).toEqual([]);
            const [circle] = leaving(elements);
            expect([circle.x, circle.y, circle.color]).toEqual([ball.x, ball.y, ball.color]);
            expect(outlines(elements.effects).map(({ color }) => color)).toEqual([OUTCOME_COLORS.passed]);
            expect(signs(elements)).toEqual(["✓"]);
          });

          it("sends a job that failed off the board outlined in red with a cross, leaving a ring that spreads and fades where it ended", () => {
            const { elements, ball } = ended("failed");
            browser.frame();
            expect(signs(elements)).toEqual(["✕"]);
            expect(outlines(elements.effects).map(({ color }) => color)).toEqual([OUTCOME_COLORS.failed]);
            browser.frameUntil(() => outlines(elements.effects).length === 2);
            const ring = outlines(elements.effects)[1];
            expect([ring.x, ring.y, ring.color]).toEqual([ball.x, ball.y, OUTCOME_COLORS.failed]);
            browser.frame(0.2);
            const spread = outlines(elements.effects)[1];
            expect(spread.r).toBeGreaterThan(ring.r);
            expect(spread.alpha).toBeLessThan(ring.alpha);
          });

          it("lets a job that neither passed nor failed swell and fade where it was, marked with a dash", () => {
            const { elements, ball } = ended("neither");
            browser.frame();
            expect(signs(elements)).toEqual(["–"]);
            expect(outlines(elements.effects).map(({ color }) => color)).toEqual([OUTCOME_COLORS.neither]);
            browser.frameUntil(() => leaving(elements)[0].alpha < 1);
            browser.frame(0.3);
            const [fading] = leaving(elements);
            expect(fading.x).toBe(ball.x);
            expect(fading.r).toBeGreaterThan(ball.r);
            expect(fading.alpha).toBeLessThan(1);
          });

          it("clears the balls that left once they are gone, and draws no more frames after", () => {
            const { elements, view } = ended("passed");
            browser.frameUntil(() => view.counts.leaving === 0);
            const context = context2dOf(elements.effects);
            expect(context.marks).toEqual([]);
            const clears = context.clears;
            browser.frameUntil(() => browser.framesAsked === 0);
            view.show(boardOf([]), noOutcome, false);
            browser.frame();
            expect(context.clears).toBe(clears);
          });

          it("lets a job whose end is not known simply go", () => {
            const { elements, view } = ended(undefined);
            expect(view.counts).toEqual({ shown: 0, leaving: 0 });
            browser.frame();
            expect(context2dOf(elements.effects).clears).toBe(0);
          });

          it("lets a job that ends simply go while the view is to stay still", () => {
            const { view } = ended("passed", true);
            expect(view.counts).toEqual({ shown: 0, leaving: 0 });
          });

          it("stops what was leaving once the view is to stay still", () => {
            const elements = mount();
            let still = false;
            const view = new RunnersView(elements, () => {}, () => still);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            view.show(boardOf([]), () => "passed", false);
            expect(view.counts.leaving).toBe(1);
            view.show(boardOf([]), () => "passed", false);
            expect(view.counts.leaving).toBe(1);
            still = true;
            view.show(boardOf([]), () => "passed", false);
            expect(view.counts.leaving).toBe(0);
          });

          it("sends nothing off a board shown afresh, whatever the jobs' ends, and stops what was leaving", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(
              boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 8, { runner: "ci-mac-01-2" })]),
              noOutcome,
              true,
            );
            browser.frame();
            view.show(boardOf([job(2, 8, { runner: "ci-mac-01-2" })]), () => "failed", false);
            expect(view.counts).toEqual({ shown: 1, leaving: 1 });
            browser.frame();
            expect(signs(elements)).toEqual(["✕"]);

            view.show(boardOf([]), () => "failed", true);
            expect(view.counts).toEqual({ shown: 0, leaving: 0 });
            browser.frame();
            expect(signs(elements)).toEqual([]);
          });
        });

        describe("the queues", () => {
          const QUEUED = "labs · CI on main @ aaaaaaa\njob 1\nQueued\nfor a runner labeled self-hosted, labs";

          // How many balls drawn the tooltip names as queued jobs when pointed at.
          function namedQueued(elements: RunnersElements): number {
            return shown(elements).filter(({ x, y }) => {
              pointAt(elements.board, x, y);
              return named(elements)?.includes("\nQueued\n");
            }).length;
          }

          it("drops a queue shown afresh into its heap from just above, clipped to its pool, naming a ball only once it is in sight", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { running: false })]), noOutcome, true);
            browser.frame();
            const pools = context2dOf(elements.chrome).marks.flatMap((mark) =>
              mark.kind === "fill" && mark.alpha === 0.035 ? mark.shapes : []
            );
            expect(pools).toHaveLength(1);
            const [falling] = shown(elements);
            expect([falling.clip ? { kind: "box", ...falling.clip } : null]).toEqual(pools);
            expect(falling.y).toBeLessThan(pools[0].kind === "box" ? pools[0].y : 0);
            expect(namedQueued(elements)).toBe(0);
            browser.frameUntil(() => browser.framesAsked === 0);
            expect(shown(elements)[0].y).toBeGreaterThan(falling.y);
            expect(namedQueued(elements)).toBe(1);
            pointAt(elements.board, shown(elements)[0].x, shown(elements)[0].y);
            expect(named(elements)).toBe(QUEUED);
          });

          it("pours queued jobs into their heap from out of sight, and sets them out at rest on its floor at once while the view is to stay still", () => {
            for (const still of [false, true]) {
              const elements = mount();
              const { view } = viewOf(elements, still);
              view.show(boardOf([]), noOutcome, true);
              view.show(boardOf([1, 2, 3, 4, 5].map((id) => job(id, 7, { running: false }))), noOutcome, false);
              browser.frame();
              expect(shown(elements)).toHaveLength(still ? 5 : 0);
              expect(new Set(shown(elements).map(({ y }) => y)).size).toBe(still ? 1 : 0);
              expect(namedQueued(elements)).toBe(still ? 5 : 0);
              browser.frameUntil(() => browser.framesAsked === 0);
              expect(shown(elements)).toHaveLength(5);
              expect(namedQueued(elements)).toBe(5);
            }
          });

          it("pours jobs queued while others are still on their way in after them, every one coming to rest in the heap", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            const first = [1, 2, 3, 4, 5].map((id) => job(id, 7, { running: false }));
            const second = [6, 7, 8, 9, 10].map((id) => job(id, 8, { running: false }));
            view.show(boardOf([]), noOutcome, true);
            view.show(boardOf(first), noOutcome, false);
            browser.frame();
            view.show(boardOf([...first, ...second]), noOutcome, false);
            browser.frame();
            expect(shown(elements)).toEqual([]);
            browser.frameUntil(() => browser.framesAsked === 0);
            expect(namedQueued(elements)).toBe(10);
          });

          it("draws every ball its heaps hold in its run's color, and none for a job no longer queued", () => {
            const elements = mount();
            const { view } = viewOf(elements, true);
            const queued = [job(1, 7, { running: false }), job(2, 7, { running: false }), job(3, 8, { running: false })];
            const board = boardOf(queued);
            const [seven, eight] = [runColor(board, "7"), runColor(board, "8")];
            expect(seven).not.toBe(eight);
            view.show(board, noOutcome, true);
            browser.frame();
            expect(shown(elements).map(({ color }) => color).sort()).toEqual([seven, seven, eight].sort());
            view.show(boardOf(queued.slice(1)), noOutcome, false);
            browser.frame();
            expect(shown(elements).map(({ color }) => color).sort()).toEqual([seven, eight].sort());
            view.show(boardOf(queued.slice(0, 2)), noOutcome, false);
            browser.frame();
            expect(shown(elements).map(({ color }) => color)).toEqual([seven, seven]);
          });

          it("moves a queued job that starts running out of its heap to its runner's slot", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 7, { running: false })]), noOutcome, true);
            browser.frameUntil(() => browser.framesAsked === 0);
            const [heaped, running] = shown(elements);
            expect([heaped.clip === null, running.clip]).toEqual([false, null]);
            view.show(
              boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 7, { runner: "ci-mac-01-2" })]),
              noOutcome,
              false,
            );
            browser.frame();
            const [, freed] = shown(elements);
            expect(freed.clip).toBeNull();
            expect(Math.hypot(freed.x - heaped.x, freed.y - heaped.y)).toBeLessThan(10);
            browser.frameUntil(() => browser.framesAsked === 0);
            expect(shown(elements).map(({ x, y, clip }) => [x - running.x, y - running.y, clip])).toEqual([
              [0, 0, null],
              [24, 0, null],
            ]);
          });

          it("sends a queued job that ends off the board from its heap, and lets one still out of sight simply go", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { running: false })]), noOutcome, true);
            browser.frameUntil(() => browser.framesAsked === 0);
            const [heaped] = shown(elements);
            view.show(boardOf([job(2, 7, { running: false })]), () => "failed", false);
            expect(view.counts).toEqual({ shown: 1, leaving: 1 });
            browser.frame();
            const sent = effects(elements).find((mark) => mark.kind === "fill");
            const circle = sent?.kind === "fill" ? sent.shapes[0] : undefined;
            expect(circle?.kind === "circle" ? [circle.x, circle.y] : []).toEqual([
              expect.closeTo(heaped.x, 3),
              expect.closeTo(heaped.y, 3),
            ]);

            view.show(boardOf([]), () => "failed", false);
            expect(view.counts.shown).toBe(0);
            expect(view.counts.leaving).toBe(1);
          });
        });

        it("draws no ball for a job in a pool there is no room for on the board", () => {
          // Each pool takes the jobs of a label of its own.

          const elements = mount();
          const { view } = viewOf(elements);
          for (const [pools, drawn] of [[5, 5], [10, 8]]) {
            const runners = Array.from({ length: pools }, (_, i) => ({
              owner: "acme",
              name: `pool${i}-1`,
              labels: ["self-hosted", "Linux", `pool${i}`],
              online: true,
            }));
            view.show(
              boardOf(runners.map((pool, i) => job(i + 1, 7, { runner: pool.name, labels: ["self-hosted", `pool${i}`] })), {
                runners,
              }),
              noOutcome,
              true,
            );
            browser.frame();
            expect([view.counts.shown, shown(elements).length]).toEqual([drawn, drawn]);
          }
        });

        describe("pointing", () => {
          it("names a running job's ball pointed at, with the pointer cursor, and its slot's runner around it", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const ball = onlyBall(elements);
            pointAt(elements.board, ball.x, ball.y);
            expect([named(elements), elements.board.style.cursor]).toEqual([DESCRIPTION, "pointer"]);
            // The corner of the slot, outside the ball.
            pointAt(elements.board, ball.x - 7.5, ball.y - 7.5);
            expect([named(elements), elements.board.style.cursor]).toEqual(["ci-mac-01-1: running a job", ""]);
          });

          it("names an idle runner's slot, an offline runner's, and a free place, without the pointer cursor", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(
              boardOf([hostedJob(1, 7)], { runners: [runner("ci-mac-01-1"), runner("ci-mac-01-2", false)] }),
              noOutcome,
              true,
            );
            view.show(boardOf([], { runners: [runner("ci-mac-01-1"), runner("ci-mac-01-2", false)] }), noOutcome, false);
            const names = outlines(elements.chrome).map(({ x, y }) => {
              pointAt(elements.board, x, y);
              return [named(elements), elements.board.style.cursor];
            });
            expect(names).toEqual([
              ["ci-mac-01-1: idle", ""],
              ["ci-mac-01-2: offline", ""],
              [expect.stringMatching(/: free$/), ""],
            ]);
          });

          it("hides the tooltip, and clears the cursor, once the pointer moves off a ball to empty board, or off the board", () => {
            const elements = mount();
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const ball = onlyBall(elements);
            pointAt(elements.board, ball.x, ball.y);
            pointAt(elements.board, 2, 598);
            expect([named(elements), elements.board.style.cursor]).toEqual([null, ""]);
            pointAt(elements.board, ball.x, ball.y);
            elements.board.dispatchEvent(new PointerEvent("pointerleave"));
            expect([named(elements), elements.board.style.cursor]).toEqual([null, ""]);
          });

          it("places the tooltip below and right of the pointer, or above it and left where it would leave the board", () => {
            const elements = mount();
            place(elements.board);
            const { view } = viewOf(elements);
            view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const ball = onlyBall(elements);
            sizeTooltip(elements.tooltip, 100, 40);
            pointAt(elements.board, ball.x, ball.y);
            expect([elements.tooltip.style.left, elements.tooltip.style.top]).toEqual([`${ball.x + 12}px`, `${ball.y + 16}px`]);
            sizeTooltip(elements.tooltip, 700, 590);
            pointAt(elements.board, ball.x, ball.y);
            expect([elements.tooltip.style.left, elements.tooltip.style.top]).toEqual([
              `${BOARD_WIDTH - 700 - 4}px`,
              `${ball.y - 590 - 8}px`,
            ]);
          });

          it("finds the board's balls within a border, and on a board shown at twice its size", () => {
            for (const [border, width] of [[9, BOARD_WIDTH], [0, 2 * BOARD_WIDTH]]) {
              const elements = mount();
              const scale = width / BOARD_WIDTH;
              place(elements.board, { left: 20, top: 30, border, width, height: 600 * scale });
              const { view, opened } = viewOf(elements);
              view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
              browser.frame();
              const ball = onlyBall(elements);
              const x = 20 + border + ball.x * scale;
              const y = 30 + border + ball.y * scale;
              sizeTooltip(elements.tooltip, 10, 10);
              pointAt(elements.board, x, y);
              expect(named(elements)).toBe(DESCRIPTION);
              expect(elements.tooltip.style.left).toBe(`${ball.x * scale + 12}px`);
              clickAt(elements.board, x, y);
              clickAt(elements.board, x - 10 * scale, y);
              expect(opened).toEqual(["https://github.com/acme/labs/actions/runs/7/job/1"]);
            }
          });

          it("opens the page of a job whose ball is clicked, and none for a click on empty board or on a ball whose page is not on GitHub", () => {
            const elements = mount();
            const { view, opened } = viewOf(elements);
            for (const url of ["https://example.com/acme/labs/actions/runs/7/job/1", "javascript:alert(1)"]) {
              view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1", url })]), noOutcome, true);
              browser.frame();
              const ball = onlyBall(elements);
              clickAt(elements.board, ball.x, ball.y);
            }
            view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
            browser.frame();
            const ball = onlyBall(elements);
            clickAt(elements.board, 2, 598);
            expect(opened).toEqual([]);
            clickAt(elements.board, ball.x, ball.y);
            expect(opened).toEqual(["https://github.com/acme/labs/actions/runs/7/job/1"]);
          });
        });
      });

      describe("rescale()", () => {
        it("draws the board again at the size the page now shows it, without moving anything", () => {
          const elements = mount();
          place(elements.board);
          const { view } = viewOf(elements);
          view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })], { problems: ["Short"] }), noOutcome, true);
          browser.frame();
          const ball = onlyBall(elements);
          const chrome = context2dOf(elements.chrome);
          expect([elements.chrome.width, elements.chrome.height, chrome.scale]).toEqual([780, 600, 1]);

          place(elements.board, { width: 2 * BOARD_WIDTH, height: 1200 });
          view.rescale();
          expect([elements.chrome.width, elements.chrome.height, chrome.scale]).toEqual([1560, 1200, 2]);
          expect(texts(elements.chrome)).toContainEqual({ text: "Short", color: OUTCOME_COLORS.failed });
          browser.frame();
          expect([elements.balls.width, elements.balls.height]).toEqual([1560, 1200]);
          expect(shown(elements)).toEqual([ball]);
          expect(browser.framesAsked).toBe(0);
        });
      });

      it("draws nothing before it is shown a board", () => {
        const elements = mount();
        const { view } = viewOf(elements);
        view.rescale();
        browser.frame();
        expect(context2dOf(elements.chrome).clears).toBe(0);
        expect(shown(elements)).toEqual([]);
        view.show(boardOf([]), noOutcome, true);
        expect(context2dOf(elements.chrome).clears).toBe(1);
      });

      it("draws the board again each time the device's pixels change size", () => {
        const elements = mount();
        const { view } = viewOf(elements);
        view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
        browser.frame();
        expect(elements.chrome.width).toBe(780);
        browser.rescreen(2);
        expect([elements.chrome.width, browser.framesAsked]).toEqual([1560, 1]);
        browser.frame();
        expect(elements.balls.width).toBe(1560);
        browser.rescreen(3);
        expect(elements.chrome.width).toBe(2340);
      });
    });

    describe("static members", () => {
      describe("describe()", () => {
        it("returns a job's run, its name, and where and how long it has run, or waited and for what", () => {
          const now = Date.parse("2026-01-01T12:00:00Z");
          const board = boardOf(
            [
              job(1, 7, { name: "build", runner: "ci-mac-01-1", since: now - 4 * 60_000 }),
              job(2, 7, { name: "test", running: false, since: now - 40_000 }),
              job(3, 7, { name: "lint", running: false, labels: [], runnerGroup: null }),
            ],
            { pulls: new Map([[7, 12]]) },
          );
          const tokens = board.pools.flatMap((pool) => [
            ...pool.queue,
            ...pool.boxes.flatMap((box) => (box.slots ?? []).flatMap((slot) => slot.job ? [slot.job] : [])),
          ]);
          expect(tokens.map((token) => RunnersView.describe(token, now)).sort()).toEqual([
            "labs PR #12 · CI @ aaaaaaa\nbuild\nRunning on ci-mac-01-1 for 4m",
            "labs PR #12 · CI @ aaaaaaa\nlint\nQueued\nfor any runner",
            "labs PR #12 · CI @ aaaaaaa\ntest\nQueued for 40s\nfor a runner labeled self-hosted, labs",
          ]);
          const [running] = tokens.filter((token) => token.running);
          expect(RunnersView.describe({ ...running, runner: null }, now)).toBe(
            "labs PR #12 · CI @ aaaaaaa\nbuild\nRunning on a runner for 4m",
          );
        });
      });

      describe("duration()", () => {
        it("returns a length of time in its largest unit, rounded down", () => {
          expect([
            -5_000,
            0,
            59_999,
            60_000,
            3_599_999,
            3_600_000,
            86_399_999,
            3 * 86_400_000,
          ].map(RunnersView.duration)).toEqual(["0s", "0s", "59s", "1m", "59m", "1h", "23h", "3d"]);
        });
      });
    });
  });

  describe("followRunners()", () => {
    it("shows no jobs until its socket opens with a snapshot, and then the snapshot's", async () => {
      const elements = mount();
      const { view, opened } = await follow(elements);
      expect(opened.map(([url]) => url)).toEqual(["ws://runners.test/socket"]);
      expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");

      opened[0][1].deliver(snapshot([
        job(1, 3, { repository: "beta", running: false }),
        job(2, 4, { running: false }),
        job(3, 4, { runner: "ci-mac-01-1" }),
      ]));
      expect(legendLines(elements.legend)).toEqual([
        ["beta · CI on main @ aaaaaaa", "1 job"],
        ["labs PR #12 · CI @ aaaaaaa", "2 jobs"],
      ]);
      expect(view.counts).toEqual({ shown: 3, leaving: 0 });
    });

    it("shows the news its socket delivers with the next frame, together, and asks for no frame for news that changes nothing", async () => {
      const elements = mount();
      const { view, opened } = await follow(elements);
      const socket = opened[0][1];
      socket.deliver(snapshot([job(1, 3, { repository: "beta", running: false })], { runs: [[9, 2, 0]] }));
      browser.frameUntil(() => browser.framesAsked === 0);
      socket.deliver({ type: "news", news: queuedNews(4, 9, "delta") });
      expect(browser.framesAsked).toBe(0);

      socket.deliver({ type: "news", news: queuedNews(2, 5, "alpha") });
      socket.deliver({ type: "news", news: queuedNews(3, 6, "gamma") });
      expect(legendLines(elements.legend)).toEqual([["beta · CI on main @ aaaaaaa", "1 job"]]);
      expect(browser.framesAsked).toBe(1);
      browser.frame();
      expect(legendLines(elements.legend)).toEqual([
        ["alpha · CI on main @ ccccccc", "1 job"],
        ["beta · CI on main @ aaaaaaa", "1 job"],
        ["gamma · CI on main @ ccccccc", "1 job"],
      ]);
      expect(view.counts.shown).toBe(3);
    });

    it("shows a change of runners with the next frame", async () => {
      const elements = mount();
      const { opened } = await follow(elements);
      opened[0][1].deliver(snapshot([]));
      opened[0][1].deliver({ type: "runners", runners: [runner("ci-mac-01-1")], larger: [], problems: ["Gone"] });
      expect(elements.board.getAttribute("aria-label")).toBe("0 running · 0 queued · 2 of 2 machine runners idle");
      browser.frame();
      expect(elements.board.getAttribute("aria-label")).toBe("0 running · 0 queued · 1 of 1 machine runner idle");
      expect(texts(elements.chrome)).toContainEqual({ text: "Gone", color: OUTCOME_COLORS.failed });
    });

    it("reloads the page for a snapshot from another version of the server, showing nothing of it", async () => {
      const elements = mount();
      const { view, opened } = await follow(elements);
      opened[0][1].deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })], { version: "v2" }));
      expect(browser.reloads).toBe(1);
      expect(view.counts.shown).toBe(0);
      opened[0][1].deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      expect(browser.reloads).toBe(1);
      expect(view.counts.shown).toBe(1);
    });

    it("shows no jobs and a badge saying OFFLINE once its socket closes, and opens another at once", async () => {
      const elements = mount();
      const { view, opened } = await follow(elements);
      opened[0][1].deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })], { problems: ["Trouble"] }));
      expect(view.counts.shown).toBe(1);
      expect(badgeOf(elements)).toEqual(LIVE);

      opened[0][1].drop();
      expect(view.counts).toEqual({ shown: 0, leaving: 0 });
      expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
      expect(badgeOf(elements)).toEqual(OFFLINE);
      // The board itself names no problem; the badge says what is wrong.
      expect(texts(elements.chrome).filter(({ color }) => color === OUTCOME_COLORS.failed)).toEqual([]);
      expect(opened.map(([url]) => url)).toEqual(["ws://runners.test/socket", "ws://runners.test/socket"]);

      await opened[1][1].listening;
      expect(badgeOf(elements)).toEqual(OFFLINE);
      opened[1][1].deliver(snapshot([job(2, 4, { running: false })]));
      expect(legendLines(elements.legend)).toEqual([["labs PR #12 · CI @ aaaaaaa", "1 job"]]);
      expect(badgeOf(elements)).toEqual(LIVE);
    });

    it("shows the first snapshot afresh, and animates later ones, sending off the jobs they end", async () => {
      const elements = mount();
      const { view, opened } = await follow(elements);
      const socket = opened[0][1];
      socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      browser.frame();
      expect(browser.framesAsked).toBe(0);

      socket.deliver(snapshot([job(2, 4, { runner: "ci-mac-01-2" })], { outcomes: [[1, "passed"]] }));
      expect(view.counts).toEqual({ shown: 1, leaving: 1 });
      browser.frame();
      expect(browser.framesAsked).toBe(1);
    });

    it("lets the balls grow again with each snapshot, but not with a change of runners", async () => {
      const elements = mount();
      const { opened } = await follow(elements);
      const socket = opened[0][1];
      const size = () => outlines(elements.chrome)[0].r;
      socket.deliver(snapshot([], { runners: MANY_RUNNERS }));
      const crowded = size();
      socket.deliver({ type: "runners", runners: RUNNERS, larger: [], problems: [] });
      browser.frame();
      expect(size()).toBe(crowded);
      socket.deliver(snapshot([]));
      expect(size()).toBeGreaterThan(crowded + 2);
    });

    it("shows it is not connected when a socket cannot open, and tries again on the next check", async () => {
      for (
        const refuse of [
          (): Promise<PageSocket> => Promise.reject(new Error("refused")),
          (): PageSocket => {
            throw new Error("refused");
          },
        ]
      ) {
        const elements = mount();
        const clock = checkedClock();
        const offline = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (!elements.badge.classList.contains("offline")) return;
            observer.disconnect();
            resolve();
          });
          observer.observe(elements.badge, { attributes: true });
        });
        let opens = 0;
        followRunners("ws://runners.test/socket", "v1", elements, () => {
          opens++;
          return refuse();
        }, clock.every, clock.now);
        await offline;
        expect(opens).toBe(1);
        expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
        expect(badgeOf(elements)).toEqual(OFFLINE);
        clock.check();
        expect(opens).toBe(2);
      }
    });

    it("waits for a socket that opens later", async () => {
      const elements = mount();
      const later = deferred<PageSocket>();
      const view = followRunners("ws://runners.test/socket", "v1", elements, () => later.promise, never);
      const socket = new FakeSocket();
      later.resolve(socket);
      await socket.listening;
      socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      expect(view.counts.shown).toBe(1);
      expect(badgeOf(elements)).toEqual(LIVE);
    });

    it("takes a ping as hearing from the server, and opens another socket at once only after a socket it heard from closes", async () => {
      const first = await follow(mount());
      first.opened[0][1].drop();
      expect(first.opened).toHaveLength(1);

      const others = mount();
      const { view, opened } = await follow(others);
      expect(() => opened[0][1].deliver({ type: "ping" })).not.toThrow();
      expect(others.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
      expect(view.counts.shown).toBe(0);
      opened[0][1].drop();
      expect(opened).toHaveLength(2);
    });

    it("gives up on an open socket silent for more than three checks' time, closing it and opening another at once, and hears nothing more from it", async () => {
      const elements = mount();
      const clock = checkedClock();
      const { view, opened } = await follow(elements, clock.every, clock.now);
      const silent = opened[0][1];
      silent.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      clock.advance(3 * SOCKET_CHECK_MS);
      clock.check();
      expect(silent.closes).toBe(0);
      expect(view.counts.shown).toBe(1);

      clock.advance(1);
      clock.check();
      expect(silent.closes).toBe(1);
      expect(view.counts.shown).toBe(0);
      expect(badgeOf(elements)).toEqual(OFFLINE);
      expect(opened).toHaveLength(2);

      silent.deliver(snapshot([job(2, 4, { runner: "ci-mac-01-1" })]));
      silent.drop();
      expect(view.counts.shown).toBe(0);
      expect(badgeOf(elements)).toEqual(OFFLINE);
      expect(opened).toHaveLength(2);
      clock.check();
      expect(opened).toHaveLength(2);

      await opened[1][1].listening;
      opened[1][1].deliver(snapshot([job(2, 4, { runner: "ci-mac-01-1" })]));
      expect(view.counts.shown).toBe(1);
      expect(badgeOf(elements)).toEqual(LIVE);
    });

    it("opens a socket on the next check when it has none, and none while one is open", async () => {
      const elements = mount();
      const clock = checkedClock();
      const { opened } = await follow(elements, clock.every, clock.now);
      opened[0][1].deliver({ type: "ping" });
      clock.advance(SOCKET_CHECK_MS);
      clock.check();
      expect(opened).toHaveLength(1);

      // A socket that closes before carrying anything is not opened again at
      // once, but on the next check.
      opened[0][1].drop();
      expect(opened).toHaveLength(2);
      await opened[1][1].listening;
      opened[1][1].drop();
      expect(opened).toHaveLength(2);
      clock.check();
      expect(opened).toHaveLength(3);
    });

    it("keeps a socket that goes on carrying pings", async () => {
      const elements = mount();
      const clock = checkedClock();
      const { view, opened } = await follow(elements, clock.every, clock.now);
      const socket = opened[0][1];
      socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      for (let round = 0; round < 6; round++) {
        clock.advance(2 * SOCKET_CHECK_MS);
        socket.deliver({ type: "ping" });
        clock.check();
      }
      expect(socket.closes).toBe(0);
      expect(opened).toHaveLength(1);
      expect(view.counts.shown).toBe(1);

      clock.advance(3 * SOCKET_CHECK_MS + 1);
      clock.check();
      expect(socket.closes).toBe(1);
    });

    it("gives up on a socket that never finishes opening, trying another at once, and closes it should it open after", async () => {
      const elements = mount();
      const clock = checkedClock();
      const openings: { promise: Promise<PageSocket>; resolve: (socket: PageSocket) => void }[] = [];
      const view = followRunners("ws://runners.test/socket", "v1", elements, () => {
        const opening = deferred<PageSocket>();
        openings.push(opening);
        return opening.promise;
      }, clock.every, clock.now);
      clock.advance(3 * SOCKET_CHECK_MS);
      clock.check();
      expect(openings).toHaveLength(1);
      expect(badgeOf(elements)).toEqual(LIVE);

      clock.advance(1);
      clock.check();
      expect(openings).toHaveLength(2);
      expect(badgeOf(elements)).toEqual(OFFLINE);

      const late = new FakeSocket();
      openings[0].resolve(late);
      await late.closed;
      expect(late.closes).toBe(1);
      expect(view.counts.shown).toBe(0);
      clock.check();
      expect(openings).toHaveLength(2);

      const current = new FakeSocket();
      openings[1].resolve(current);
      await current.listening;
      current.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      expect(view.counts.shown).toBe(1);
      expect(current.closes).toBe(0);
    });

    it("pays no heed to a socket given up on that then fails to open", async () => {
      const elements = mount();
      const clock = checkedClock();
      const openings: { promise: Promise<PageSocket>; reject: (reason: unknown) => void }[] = [];
      followRunners("ws://runners.test/socket", "v1", elements, () => {
        const opening = deferred<PageSocket>();
        openings.push(opening);
        return opening.promise;
      }, clock.every, clock.now);
      clock.advance(3 * SOCKET_CHECK_MS + 1);
      clock.check();
      expect(openings).toHaveLength(2);
      openings[0].reject(new Error("refused"));
      // The page heard of the failure first, having waited for it first.
      await openings[0].promise.catch(() => {});
      clock.check();
      expect(openings).toHaveLength(2);

      openings[1].reject(new Error("refused"));
      await openings[1].promise.catch(() => {});
      clock.check();
      expect(openings).toHaveLength(3);
    });

    it("tells each socket it opens whether the page is visible, and its open socket each time that changes, but no socket while one is opening", async () => {
      const elements = mount();
      const clock = checkedClock();
      const openings: { resolve: (socket: PageSocket) => void; promise: Promise<PageSocket> }[] = [];
      followRunners("ws://runners.test/socket", "v1", elements, () => {
        const opening = deferred<PageSocket>();
        openings.push(opening);
        return opening.promise;
      }, clock.every, clock.now);

      browser.setHidden(true);
      const first = new FakeSocket();
      openings[0].resolve(first);
      await first.listening;
      expect(first.sent).toEqual([{ type: "visible", visible: false }]);
      browser.setHidden(false);
      expect(first.sent).toEqual([{ type: "visible", visible: false }, { type: "visible", visible: true }]);

      first.drop();
      browser.setHidden(true);
      expect(first.sent).toHaveLength(2);

      clock.check();
      expect(openings).toHaveLength(2);
      browser.setHidden(false);
      const second = new FakeSocket();
      openings[1].resolve(second);
      await second.listening;
      expect(second.sent).toEqual([{ type: "visible", visible: true }]);
      expect(first.sent).toHaveLength(2);
    });

    it("draws the board again at its new size when it is resized", async () => {
      const elements = mount();
      place(elements.board);
      const { opened } = await follow(elements);
      opened[0][1].deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
      expect(elements.chrome.width).toBe(BOARD_WIDTH);
      place(elements.board, { width: 2 * BOARD_WIDTH, height: 1200 });
      browser.resize(elements.board);
      expect([elements.chrome.width, elements.chrome.height]).toEqual([2 * BOARD_WIDTH, 1200]);
    });

    it("draws the board again with the next frame when the dashboard's theme changes, and not otherwise", async () => {
      const elements = mount();
      const { opened } = await follow(elements);
      opened[0][1].deliver(snapshot([]));
      browser.frameUntil(() => browser.framesAsked === 0);
      const chrome = context2dOf(elements.chrome);
      const clears = chrome.clears;
      browser.frame();
      expect(chrome.clears).toBe(clears);
      dispatchEvent(new Event("dashboardthemechange"));
      expect(chrome.clears).toBe(clears);
      browser.frame();
      expect(chrome.clears).toBe(clears + 1);
    });

    it("throws for a message it does not understand", async () => {
      const elements = mount();
      const { opened } = await follow(elements);
      expect(() => opened[0][1].deliverText(JSON.stringify({ type: "gossip" }))).toThrow(
        "the dashboard sent a message the runners page does not understand",
      );
      expect(() => opened[0][1].deliver(snapshot([]))).not.toThrow();
    });

    it("checks its socket every `SOCKET_CHECK_MS` by default", async () => {
      const intervals: [() => void, number][] = [];
      const saved = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
      Object.defineProperty(globalThis, "setInterval", {
        configurable: true,
        value: (check: () => void, milliseconds: number) => intervals.push([check, milliseconds]),
      });
      try {
        const opened: FakeSocket[] = [];
        followRunners("ws://runners.test/socket", "v1", mount(), () => {
          opened.push(new FakeSocket());
          return opened.at(-1)!;
        });
        expect(intervals.map(([, milliseconds]) => milliseconds)).toEqual([SOCKET_CHECK_MS]);
        await opened[0].listening;
        opened[0].drop();
        expect(opened).toHaveLength(1);
        intervals[0][0]();
        expect(opened).toHaveLength(2);
      } finally {
        if (saved) Object.defineProperty(globalThis, "setInterval", saved);
      }
    });
  });

  describe("openedSocket()", () => {
    // The sockets opened while a case runs, which open or close when it says.

    let sockets: FakeWebSocket[];
    let saved: PropertyDescriptor | undefined;

    class FakeWebSocket extends EventTarget {
      readonly url: string;
      readonly sent: string[] = [];
      readonly sending = deferred<void>();

      constructor(url: string) {
        super();
        this.url = url;
        sockets.push(this);
      }

      send(data: string): void {
        this.sent.push(data);
        this.sending.resolve();
      }

      close(): void {}
    }

    beforeEach(() => {
      sockets = [];
      saved = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
    });

    afterEach(() => {
      if (saved) Object.defineProperty(globalThis, "WebSocket", saved);
    });

    it("resolves with a WebSocket to the URL it is given once it opens", async () => {
      const opening = openedSocket("ws://runners.test/socket");
      expect(sockets.map(({ url }) => url)).toEqual(["ws://runners.test/socket"]);
      sockets[0].dispatchEvent(new Event("open"));
      expect(await opening).toBe(sockets[0]);
    });

    it("rejects for a socket that closes before it opens", async () => {
      const opening = openedSocket("ws://runners.test/socket");
      sockets[0].dispatchEvent(new Event("close"));
      await expect(opening).rejects.toThrow("the socket at ws://runners.test/socket closed before it opened");
    });

    it("gives `followRunners()` the sockets it opens by default", async () => {
      const elements = mount();
      const view = followRunners("ws://runners.test/socket", "v1", elements, undefined, never);
      sockets[0].dispatchEvent(new Event("open"));
      await sockets[0].sending.promise;
      expect(sockets[0].sent.map((data) => JSON.parse(data))).toEqual([{ type: "visible", visible: true }]);
      sockets[0].dispatchEvent(new MessageEvent("message", { data: JSON.stringify(snapshot([job(1, 3, { runner: "ci-mac-01-1" })])) }));
      expect(view.counts.shown).toBe(1);
    });
  });
});
