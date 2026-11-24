/**
 * Tests of the runners page's board in a real browser: the legend and the
 * tooltip a `RunnersView` keeps, the balls it draws and sends off the board,
 * the socket `followRunners()` follows, and the circles `BallRenderer` draws
 * with WebGL and with the 2D context. They run under deno-web-test, which
 * registers tests through `Deno.test`, so the functions from
 * `@std/testing/bdd` are not available here.
 */

import { expect } from "@std/expect";
import { type Board, buildBoard, type Runner, type RunnersMessage, RunPalette } from "./runner-board.ts";
import { BallRenderer, type Clip } from "./runner-gl.ts";
import type { ActiveJob, JobNews, Outcome } from "./runner-jobs.ts";
import {
  BOARD_WIDTH,
  followRunners,
  openedSocket,
  OUTCOME_COLORS,
  type PageSocket,
  type RunnersElements,
  RunnersView,
  SOCKET_CHECK_MS,
} from "./runner-view.ts";

// The page's layout, as runners-page.ts sets it out, with the board away from
// the window's corner so that a point on the board and the same point in the
// window differ.
const style = document.createElement("style");
style.textContent = `
  :root{--text:#202020;--text-muted:#606060;--text-faint:#909090;--divider:#d0d0d0}
  .test-board{position:fixed;left:20px;top:30px;width:780px;height:600px;overflow:hidden}
  .test-board.bordered{border:9px solid #888888}
  .test-board.double{width:1560px;height:1200px}
  .test-board canvas{position:absolute;left:0;top:0;width:100%;height:100%}
  .test-board .layer{pointer-events:none}
  .test-board .tooltip{position:absolute;white-space:pre;font-size:10px}
`;
document.head.append(style);

// The page's elements, with the page's IDs, added to the document, the board
// laid out at its own width, or with a thick border when `bordered`, or shown
// at twice its width when `double`, and what removes them.
function mount(look: "" | "bordered" | "double" = ""): { elements: RunnersElements; remove: () => void } {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string, className = "") => {
    const made = document.createElement(tag);
    made.id = id;
    made.className = className;
    return made;
  };
  const board = element("div", "board", `test-board ${look}`);
  const chrome = element("canvas", "chrome");
  const balls = element("canvas", "balls", "layer");
  const effects = element("canvas", "effects", "layer");
  const tooltip = element("div", "tooltip", "tooltip");
  tooltip.hidden = true;
  board.append(chrome, balls, effects, tooltip);
  const legend = element("div", "legend");
  // The badge as the page's markup, `LIVE_PAGE_BADGE`, starts it.
  const badge = element("div", "live-badge", "live-badge");
  badge.textContent = "● LIVE";
  document.body.append(badge, board, legend);
  return {
    elements: { board, chrome, balls, effects, legend, tooltip, badge },
    remove: () => {
      badge.remove();
      board.remove();
      legend.remove();
    },
  };
}

// What the badge says, and whether it is marked offline.
function badgeOf(elements: RunnersElements): [string, boolean] {
  return [elements.badge.textContent ?? "", elements.badge.classList.contains("offline")];
}

// What the page tells a socket while a reader can see it, as headless pages
// always are.
const VISIBLE = { type: "visible", visible: true };

const LIVE: [string, boolean] = ["● LIVE", false];
const OFFLINE: [string, boolean] = ["● OFFLINE", true];

// Resolves with the first `type` event at `target`.
function once(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

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

// Resolves with the next frame, after the callbacks asked for before it.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

// A runner of machine `ci-mac-01`, which takes the jobs labeled `labs`.
function runner(name: string): Runner {
  return { owner: "acme", name, labels: ["self-hosted", "macOS", "ci-mac-01", "labs"], online: true };
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

// The 2D context of `canvas`, which a canvas that has no other kind always has.
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the canvas has a context of another kind");
  return context;
}

// What is drawn on `canvas`, read through a copy, as WebGL's pixels cannot be
// read through the 2D context.
function pixels(canvas: HTMLCanvasElement): ImageData {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = context2d(copy);
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, copy.width, copy.height);
}

// The color and opacity of the pixel at `x`, `y` of `image`.
function rgba(image: ImageData, x: number, y: number): number[] {
  const at = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [...image.data.subarray(at, at + 4)];
}

// The red, green, and blue of a `#rrggbb` color.
function rgb(color: string): number[] {
  const value = parseInt(color.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
}

// Whether some opaque pixel of `image` is within a few steps of `color`.
function shows(image: ImageData, color: string): boolean {
  const [r, g, b] = rgb(color);
  const data = image.data;
  for (let at = 0; at < data.length; at += 4) {
    if (
      data[at + 3] === 255 && Math.abs(data[at] - r) <= 8 && Math.abs(data[at + 1] - g) <= 8 &&
      Math.abs(data[at + 2] - b) <= 8
    ) {
      return true;
    }
  }
  return false;
}

// Where in the window the ink on `canvas` centers, or `undefined` with none,
// as the canvas shows on the page.
function inkCenter(canvas: HTMLCanvasElement): { x: number; y: number } | undefined {
  const image = pixels(canvas);
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  let count = 0;
  let x = 0;
  let y = 0;
  for (let row = 0; row < image.height; row++) {
    for (let column = 0; column < image.width; column++) {
      if (image.data[(row * image.width + column) * 4 + 3] < 128) continue;
      count++;
      x += column + 0.5;
      y += row + 0.5;
    }
  }
  return count === 0 ? undefined : { x: rect.left + x / count / scale, y: rect.top + y / count / scale };
}

// How wide and how tall, in pixels, the ink on `canvas` spreads.
function inkExtent(canvas: HTMLCanvasElement): { width: number; height: number } {
  const image = pixels(canvas);
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let row = 0; row < image.height; row++) {
    for (let column = 0; column < image.width; column++) {
      if (image.data[(row * image.width + column) * 4 + 3] < 128) continue;
      left = Math.min(left, column);
      right = Math.max(right, column + 1);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row + 1);
    }
  }
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  return { width: Math.max(0, right - left) / scale, height: Math.max(0, bottom - top) / scale };
}

// The center of the only ball drawn on the board, in the window.
function ballCenter(elements: RunnersElements): { x: number; y: number } {
  const center = inkCenter(elements.balls);
  if (center === undefined) throw new Error("no ball was drawn");
  return center;
}

// The color and opacity `canvas` shows at `x`, `y` in the window.
function colorAt(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  return rgba(pixels(canvas), Math.floor((x - rect.left) * scale), Math.floor((y - rect.top) * scale));
}

// How far from its left edge, in pixels, `canvas` shows anything in `color`.
function rightmost(canvas: HTMLCanvasElement, color: string): number {
  const image = pixels(canvas);
  const [r, g, b] = rgb(color);
  let right = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const d = image.data;
    if (d[at + 3] < 64 || Math.abs(d[at] - r) > 12 || Math.abs(d[at + 1] - g) > 12 || Math.abs(d[at + 2] - b) > 12) {
      continue;
    }
    right = Math.max(right, (at / 4) % image.width + 1);
  }
  return right * canvas.getBoundingClientRect().width / canvas.width;
}

// How far from the board's left edge the ink of `problem` reaches, drawn as
// the board draws a problem: in its detail font, between insets of 18 pixels
// on each side of a board laid out `BOARD_WIDTH` wide, cut short with an ellipsis to as
// much of it as fits.
function problemRight(problem: string): number {
  const measure = context2d(document.createElement("canvas"));
  measure.font = "10px -apple-system,Segoe UI,Roboto,sans-serif";
  const room = BOARD_WIDTH - 2 * 18;
  let line = problem;
  if (measure.measureText(line).width > room) {
    let kept = problem.length;
    while (kept > 0 && measure.measureText(`${problem.slice(0, kept)}…`).width > room) kept--;
    line = `${problem.slice(0, kept)}…`;
  }
  return 18 + measure.measureText(line).actualBoundingBoxRight;
}

// Clears the balls' WebGL canvas to magenta, which stays until the view next
// draws the balls.
function paintOver(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext("webgl2");
  if (gl === null) throw new Error("the balls are not drawn with WebGL");
  gl.clearColor(1, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

const MAGENTA = [255, 0, 255, 255];

// How wide the stretch of the board is, along a row through it, where the
// tooltip says `words`, or 0 where it says them nowhere.
function widthNamed(elements: RunnersElements, words: string): number {
  const { board, tooltip } = elements;
  const rect = board.getBoundingClientRect();
  const says = (x: number, y: number) => {
    pointAt(board, x, y);
    return !tooltip.hidden && tooltip.textContent === words;
  };
  for (let y = rect.top; y < rect.bottom; y += 2) {
    for (let x = rect.left; x < rect.right; x += 2) {
      if (!says(x, y)) continue;
      let left = x;
      while (says(left - 1, y)) left--;
      let right = x;
      while (says(right + 1, y)) right++;
      return right - left + 1;
    }
  }
  return 0;
}

// Points at `x`, `y` in the window, over the board.
function pointAt(board: HTMLElement, x: number, y: number): void {
  board.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
}

// What the tooltip says at each point of the board four pixels apart, each
// text once.
function namesOnBoard(elements: RunnersElements): Set<string> {
  const { board, tooltip } = elements;
  const rect = board.getBoundingClientRect();
  const names = new Set<string>();
  for (let y = 0; y < rect.height; y += 4) {
    for (let x = 0; x < rect.width; x += 4) {
      pointAt(board, rect.left + x, rect.top + y);
      if (!tooltip.hidden) names.add(tooltip.textContent ?? "");
    }
  }
  return names;
}

// The legend's lines, each its title and job count.
function legendLines(legend: HTMLElement): string[][] {
  return [...legend.querySelectorAll(".run")].map((line) => [
    line.querySelector(".title")?.textContent ?? "",
    line.querySelector(".jobs")?.textContent ?? "",
  ]);
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

  /** Delivers `message`, as JSON. */
  deliver(message: RunnersMessage): void {
    this.deliverText(JSON.stringify(message));
  }

  /** Delivers `data` as a message. */
  deliverText(data: string): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.#listeners.get("message") ?? []) listener(event);
  }

  /** What the page has sent on the socket, each message read as JSON. */
  get sent(): readonly unknown[] {
    return this.#sent;
  }

  /** Takes `data` from the page. */
  send(data: string): void {
    this.#sent.push(JSON.parse(data));
  }

  /** Resolves once the page has closed the socket. */
  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  /** How many times the page has closed the socket. */
  get closes(): number {
    return this.#closes;
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
  { problems = [], runners = RUNNERS, outcomes = [] }: {
    problems?: readonly string[];
    runners?: readonly Runner[];
    outcomes?: readonly (readonly [number, Outcome])[];
  } = {},
): RunnersMessage {
  return {
    type: "snapshot",
    version: "v1",
    tracker: { jobs, runs: [], pullRequests: [[4, 12]], outcomes },
    runners,
    larger: [],
    problems,
  };
}

// News that job `id` of run `runId` is queued.
function queuedNews(id: number, runId: number, repository: string): JobNews {
  return {
    kind: "job",
    id,
    runId,
    attempt: 1,
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

const PROBLEM = "GitHub did not list the organization's runners.";

Deno.test("RunnersView.show() lists each run in the legend alphabetically, numbers in order, with how many of its jobs show", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
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
    await nextFrame();
  } finally {
    remove();
  }
});

Deno.test("RunnersView draws a running job's ball in its run's color, names the job there, and names the idle runner beside it", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    const board = boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]);
    view.show(board, noOutcome, true);
    await nextFrame();

    const center = ballCenter(elements);
    const rect = elements.board.getBoundingClientRect();
    expect(center.x).toBeGreaterThan(rect.left);
    expect(center.x).toBeLessThan(rect.right);
    expect(center.y).toBeGreaterThan(rect.top);
    expect(center.y).toBeLessThan(rect.bottom);
    const palette = new RunPalette();
    palette.update(board.runs);
    expect(colorAt(elements.balls, center.x, center.y)).toEqual([...rgb(palette.color("7")), 255]);

    const description = "labs · CI on main @ aaaaaaa\nbuild\nRunning on ci-mac-01-1";
    pointAt(elements.board, center.x, center.y);
    expect(elements.tooltip.hidden).toBe(false);
    expect(elements.tooltip.textContent).toBe(description);
    expect(elements.board.style.cursor).toBe("pointer");

    const names = namesOnBoard(elements);
    expect([...names]).toContain(description);
    expect([...names]).toContain("ci-mac-01-2: idle");
    expect([...names]).not.toContain("ci-mac-01-1: idle");

    elements.board.dispatchEvent(new PointerEvent("pointerleave"));
    expect(elements.tooltip.hidden).toBe(true);
  } finally {
    remove();
  }
});

Deno.test("RunnersView sets the pointer cursor over a job's ball and not over an empty slot", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const center = ballCenter(elements);
    pointAt(elements.board, center.x, center.y);
    expect(elements.board.style.cursor).toBe("pointer");

    // The idle runner's slot is somewhere else on the board.
    const rect = elements.board.getBoundingClientRect();
    let idle: { x: number; y: number } | undefined;
    for (let y = 0; y < rect.height && idle === undefined; y += 4) {
      for (let x = 0; x < rect.width && idle === undefined; x += 4) {
        pointAt(elements.board, rect.left + x, rect.top + y);
        if (elements.tooltip.textContent === "ci-mac-01-2: idle") idle = { x, y };
      }
    }
    expect(idle).toBeDefined();
    expect(elements.board.style.cursor).toBe("");
  } finally {
    remove();
  }
});

Deno.test("RunnersView clears the pointer cursor once the pointer moves off a ball to empty board, or off the board", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const center = ballCenter(elements);
    const rect = elements.board.getBoundingClientRect();

    pointAt(elements.board, center.x, center.y);
    expect(elements.board.style.cursor).toBe("pointer");
    pointAt(elements.board, rect.left + 2, rect.bottom - 2);
    expect(elements.tooltip.hidden).toBe(true);
    expect(elements.board.style.cursor).toBe("");

    pointAt(elements.board, center.x, center.y);
    expect(elements.board.style.cursor).toBe("pointer");
    elements.board.dispatchEvent(new PointerEvent("pointerleave"));
    expect(elements.board.style.cursor).toBe("");
  } finally {
    remove();
  }
});

Deno.test("RunnersView opens the page of a job whose ball is clicked, and none for a click on empty board", async () => {
  const { elements, remove } = mount();
  try {
    const opened: string[] = [];
    const view = new RunnersView(elements, (url) => opened.push(url));
    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const center = ballCenter(elements);
    const rect = elements.board.getBoundingClientRect();

    elements.board.dispatchEvent(
      new MouseEvent("click", { clientX: rect.left + 2, clientY: rect.bottom - 2, bubbles: true }),
    );
    expect(opened).toEqual([]);
    elements.board.dispatchEvent(new MouseEvent("click", { clientX: center.x, clientY: center.y, bubbles: true }));
    expect(opened).toEqual(["https://github.com/acme/labs/actions/runs/7/job/1"]);
  } finally {
    remove();
  }
});

Deno.test("RunnersView opens no page for a ball whose job's address is not on GitHub", async () => {
  const { elements, remove } = mount();
  try {
    const opened: string[] = [];
    const view = new RunnersView(elements, (url) => opened.push(url));
    for (const url of ["https://example.com/acme/labs/actions/runs/7/job/1", "javascript:alert(1)"]) {
      view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1", url })]), noOutcome, true);
      await nextFrame();
      const center = ballCenter(elements);
      elements.board.dispatchEvent(new MouseEvent("click", { clientX: center.x, clientY: center.y, bubbles: true }));
    }
    expect(opened).toEqual([]);
  } finally {
    remove();
  }
});

Deno.test("RunnersView places its balls, the pointer, and what leaves the board within a border around the board", async () => {
  const { elements, remove } = mount("bordered");
  try {
    const opened: string[] = [];
    const view = new RunnersView(elements, (url) => opened.push(url));
    view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const center = ballCenter(elements);
    const rect = elements.board.getBoundingClientRect();
    expect(center.x).toBeGreaterThan(rect.left + 9);
    expect(center.y).toBeGreaterThan(rect.top + 9);

    pointAt(elements.board, center.x, center.y);
    expect(elements.tooltip.textContent).toBe("labs · CI on main @ aaaaaaa\nbuild\nRunning on ci-mac-01-1");
    elements.board.dispatchEvent(new MouseEvent("click", { clientX: center.x, clientY: center.y, bubbles: true }));
    expect(opened).toEqual(["https://github.com/acme/labs/actions/runs/7/job/1"]);

    // The ball starts leaving from where it was.
    view.show(boardOf([]), () => "passed", false);
    await nextFrame();
    const leaving = inkCenter(elements.effects);
    if (leaving === undefined) throw new Error("nothing was drawn leaving");
    expect(Math.abs(leaving.x - center.x)).toBeLessThan(2);
    expect(Math.abs(leaving.y - center.y)).toBeLessThan(2);
  } finally {
    remove();
  }
});

Deno.test("RunnersView labels the board with its summary, and gives each line of the legend the role of a list item", () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
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
  } finally {
    remove();
  }
});

Deno.test("RunnersView draws a problem too long for the board cut short with an ellipsis, keeping as much of it as fits", () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    for (const problem of ["Short", "W".repeat(120)]) {
      view.show(boardOf([], { problems: [problem] }), noOutcome, true);
      expect(Math.abs(rightmost(elements.chrome, OUTCOME_COLORS.failed) - problemRight(problem))).toBeLessThan(2);
    }
  } finally {
    remove();
  }
});

Deno.test("RunnersView.show() lets the balls grow again when asked to regrow, and only then", () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(boardOf([], { runners: MANY_RUNNERS }), noOutcome, true);
    const crowded = widthNamed(elements, "ci-mac-01-2: idle");
    view.show(boardOf([]), noOutcome, false);
    expect(widthNamed(elements, "ci-mac-01-2: idle")).toBe(crowded);
    view.show(boardOf([]), noOutcome, false, true);
    const roomy = widthNamed(elements, "ci-mac-01-2: idle");
    expect(crowded).toBeGreaterThan(0);
    expect(roomy).toBeGreaterThan(crowded + 3);
    view.show(boardOf([]), noOutcome, true);
    expect(widthNamed(elements, "ci-mac-01-2: idle")).toBe(roomy);
  } finally {
    remove();
  }
});

Deno.test("RunnersView draws no more frames after showing a board that changes nothing, and goes on drawing while a ball moves", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, false);
    await nextFrame();
    paintOver(elements.balls);
    await nextFrame();
    await nextFrame();
    expect(rgba(pixels(elements.balls), 0, 0)).toEqual(MAGENTA);
    expect(view.counts).toEqual({ shown: 1, leaving: 0 });

    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-2" })]), noOutcome, false);
    await nextFrame();
    paintOver(elements.balls);
    await nextFrame();
    expect(rgba(pixels(elements.balls), 0, 0)).toEqual([0, 0, 0, 0]);
  } finally {
    remove();
  }
});

Deno.test("RunnersView draws its balls again once the browser restores a WebGL context it lost", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const center = ballCenter(elements);
    const losing = elements.balls.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!losing) throw new Error("the browser cannot lose a WebGL context on purpose");
    const lost = once(elements.balls, "webglcontextlost");
    losing.loseContext();
    await lost;
    // The browser allows a restore only once it has finished telling every
    // listener of the loss.
    await nextFrame();
    const restored = once(elements.balls, "webglcontextrestored");
    losing.restoreContext();
    await restored;
    await nextFrame();
    expect(inkCenter(elements.balls)).toEqual(center);
    expect(view.counts.shown).toBe(1);
  } finally {
    remove();
  }
});

Deno.test("RunnersView names no queued job whose ball is still above its pool, and names it once it is in the heap", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(boardOf([job(1, 7, { running: false })]), noOutcome, true);
    const description = "labs · CI on main @ aaaaaaa\njob 1\nQueued\nfor a runner labeled self-hosted, labs";
    expect(view.counts.shown).toBe(1);
    expect([...namesOnBoard(elements)]).not.toContain(description);

    // The ball drops into its heap within a few hundred frames.
    let named = false;
    for (let frame = 0; frame < 300 && !named; frame++) {
      await nextFrame();
      const center = inkCenter(elements.balls);
      if (center === undefined) continue;
      pointAt(elements.board, center.x, center.y);
      named = elements.tooltip.textContent === description;
    }
    expect(named).toBe(true);
  } finally {
    remove();
  }
});

Deno.test("RunnersView.show() lets a job that ends simply go while the view is to stay still, and sends it off otherwise", async () => {
  for (const still of [true, false]) {
    const { elements, remove } = mount();
    try {
      const view = new RunnersView(elements, () => {}, () => still);
      view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
      await nextFrame();
      view.show(boardOf([]), () => "passed", false);
      expect(view.counts).toEqual({ shown: 0, leaving: still ? 0 : 1 });
      await nextFrame();
      expect(shows(pixels(elements.effects), OUTCOME_COLORS.passed)).toBe(!still);
    } finally {
      remove();
    }
  }
});

Deno.test("RunnersView.show() puts a running job in its new place at once while the view is to stay still, and moves it there otherwise", async () => {
  for (const still of [true, false]) {
    const { elements, remove } = mount();
    try {
      const view = new RunnersView(elements, () => {}, () => still);
      view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })]), noOutcome, true);
      await nextFrame();
      const before = ballCenter(elements);
      view.show(boardOf([job(1, 7, { runner: "ci-mac-01-2" })]), noOutcome, false);
      await nextFrame();
      const after = ballCenter(elements);
      paintOver(elements.balls);
      await nextFrame();
      if (still) {
        // The ball is where a board shown afresh puts it, and nothing moves.
        expect(rgba(pixels(elements.balls), 0, 0)).toEqual(MAGENTA);
        view.show(boardOf([job(1, 7, { runner: "ci-mac-01-2" })]), noOutcome, true);
        await nextFrame();
        expect(ballCenter(elements)).toEqual(after);
        expect(after).not.toEqual(before);
      } else {
        expect(rgba(pixels(elements.balls), 0, 0)).toEqual([0, 0, 0, 0]);
      }
    } finally {
      remove();
    }
  }
});

Deno.test("RunnersView.show() sets queued jobs out at rest in a row on their heap's floor at once while the view is to stay still, and pours them in otherwise", async () => {
  const queued = [1, 2, 3, 4, 5].map((id) => job(id, 7, { running: false }));
  const descriptions = queued.map((queuedJob) =>
    `labs · CI on main @ aaaaaaa\n${queuedJob.name}\nQueued\nfor a runner labeled self-hosted, labs`
  );
  for (const still of [true, false]) {
    const { elements, remove } = mount();
    try {
      const view = new RunnersView(elements, () => {}, () => still);
      view.show(boardOf([]), noOutcome, true);
      await nextFrame();
      view.show(boardOf(queued), noOutcome, false);
      const names = [...namesOnBoard(elements)];
      await nextFrame();
      if (still) {
        expect(descriptions.filter((description) => !names.includes(description))).toEqual([]);
        const { width, height } = inkExtent(elements.balls);
        expect(height).toBeGreaterThan(0);
        expect(height).toBeLessThan(width / 3);
        paintOver(elements.balls);
        await nextFrame();
        expect(rgba(pixels(elements.balls), 0, 0)).toEqual(MAGENTA);
      } else {
        expect(descriptions.filter((description) => names.includes(description))).toEqual([]);
        paintOver(elements.balls);
        await nextFrame();
        expect(rgba(pixels(elements.balls), 0, 0)).toEqual([0, 0, 0, 0]);
      }
    } finally {
      remove();
    }
  }
});

Deno.test("RunnersView draws the same board at twice the size on a board shown twice as wide, at the device's pixels", async () => {
  const drawn = [];
  for (const look of ["", "double"] as const) {
    const { elements, remove } = mount(look);
    try {
      const view = new RunnersView(elements);
      view.show(boardOf([job(1, 7, { runner: "ci-mac-01-1" })], { problems: ["Short"] }), noOutcome, true);
      await nextFrame();
      const rect = elements.board.getBoundingClientRect();
      const center = ballCenter(elements);
      const shown = [elements.board.clientWidth, elements.board.clientHeight];
      for (const canvas of [elements.chrome, elements.balls]) {
        expect([canvas.width, canvas.height]).toEqual(shown.map((size) => Math.round(size * devicePixelRatio)));
      }
      drawn.push({
        x: center.x - rect.left,
        y: center.y - rect.top,
        across: inkExtent(elements.balls).width,
        problem: rightmost(elements.chrome, OUTCOME_COLORS.failed),
      });
    } finally {
      remove();
    }
  }
  const [single, double] = drawn;
  expect(Math.abs(double.x - 2 * single.x)).toBeLessThan(1);
  expect(Math.abs(double.y - 2 * single.y)).toBeLessThan(1);
  expect(Math.abs(double.across - 2 * single.across)).toBeLessThan(2);
  expect(Math.abs(double.problem - 2 * single.problem)).toBeLessThan(3);
});

Deno.test("RunnersView names a ball pointed at on a board shown twice as wide, with the tooltip beside the pointer", async () => {
  const { elements, remove } = mount("double");
  try {
    const opened: string[] = [];
    const view = new RunnersView(elements, (url) => opened.push(url));
    view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const center = ballCenter(elements);
    pointAt(elements.board, center.x, center.y);
    expect(elements.tooltip.textContent).toBe("labs · CI on main @ aaaaaaa\nbuild\nRunning on ci-mac-01-1");
    const tip = elements.tooltip.getBoundingClientRect();
    expect(Math.abs(tip.left - (center.x + 12))).toBeLessThan(1);
    expect(Math.abs(tip.top - (center.y + 16))).toBeLessThan(1);
    elements.board.dispatchEvent(new MouseEvent("click", { clientX: center.x, clientY: center.y, bubbles: true }));
    expect(opened).toEqual(["https://github.com/acme/labs/actions/runs/7/job/1"]);
  } finally {
    remove();
  }
});

Deno.test("RunnersView.show() sends a job whose end is known off the board marked as it ended, and lets one without an end simply go", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(
      boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 8, { runner: "ci-mac-01-2" })]),
      noOutcome,
      true,
    );
    await nextFrame();
    expect(view.counts).toEqual({ shown: 2, leaving: 0 });
    expect(shows(pixels(elements.effects), OUTCOME_COLORS.passed)).toBe(false);

    view.show(boardOf([]), (id) => id === 1 ? "passed" : undefined, false);
    expect(view.counts).toEqual({ shown: 0, leaving: 1 });
    await nextFrame();
    expect(shows(pixels(elements.effects), OUTCOME_COLORS.passed)).toBe(true);
    expect(shows(pixels(elements.effects), OUTCOME_COLORS.failed)).toBe(false);
  } finally {
    remove();
  }
});

Deno.test("RunnersView.show() sends nothing off a board shown afresh, whatever the jobs' ends, and stops what was leaving", async () => {
  const { elements, remove } = mount();
  try {
    const view = new RunnersView(elements);
    view.show(
      boardOf([job(1, 7, { runner: "ci-mac-01-1" }), job(2, 8, { runner: "ci-mac-01-2" })]),
      noOutcome,
      true,
    );
    await nextFrame();
    view.show(boardOf([job(2, 8, { runner: "ci-mac-01-2" })]), () => "failed", false);
    expect(view.counts).toEqual({ shown: 1, leaving: 1 });
    await nextFrame();
    expect(shows(pixels(elements.effects), OUTCOME_COLORS.failed)).toBe(true);

    view.show(boardOf([]), () => "failed", true);
    expect(view.counts).toEqual({ shown: 0, leaving: 0 });
    await nextFrame();
    expect(shows(pixels(elements.effects), OUTCOME_COLORS.failed)).toBe(false);
  } finally {
    remove();
  }
});

Deno.test("RunnersView.describe() returns a job's run, its name, and where and how long it has run, or waited and for what", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const board = boardOf(
    [
      job(1, 7, { name: "build", runner: "ci-mac-01-1", since: now - 4 * 60_000 }),
      job(2, 7, { name: "test", running: false, since: now - 40_000 }),
    ],
    { pulls: new Map([[7, 12]]) },
  );
  const tokens = board.pools.flatMap((pool) => [
    ...pool.queue,
    ...pool.boxes.flatMap((box) => (box.slots ?? []).flatMap((slot) => slot.job ? [slot.job] : [])),
  ]);
  expect(tokens.map((token) => RunnersView.describe(token, now)).sort()).toEqual([
    "labs PR #12 · CI @ aaaaaaa\nbuild\nRunning on ci-mac-01-1 for 4m",
    "labs PR #12 · CI @ aaaaaaa\ntest\nQueued for 40s\nfor a runner labeled self-hosted, labs",
  ]);
});

Deno.test("RunnersView.duration() returns a length of time in its largest unit, rounded down", () => {
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

Deno.test("followRunners() shows no jobs until its socket opens with a snapshot, and then the snapshot's", async () => {
  const { elements, remove } = mount();
  try {
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
    await nextFrame();
  } finally {
    remove();
  }
});

Deno.test("followRunners() shows the news its socket delivers with the next frame, together", async () => {
  const { elements, remove } = mount();
  try {
    const { view, opened } = await follow(elements);
    const socket = opened[0][1];
    socket.deliver(snapshot([job(1, 3, { repository: "beta", running: false })]));
    socket.deliver({ type: "news", news: queuedNews(2, 5, "alpha") });
    socket.deliver({ type: "news", news: queuedNews(3, 6, "gamma") });
    expect(legendLines(elements.legend)).toEqual([["beta · CI on main @ aaaaaaa", "1 job"]]);
    expect(view.counts.shown).toBe(1);

    await nextFrame();
    expect(legendLines(elements.legend)).toEqual([
      ["alpha · CI on main @ ccccccc", "1 job"],
      ["beta · CI on main @ aaaaaaa", "1 job"],
      ["gamma · CI on main @ ccccccc", "1 job"],
    ]);
    expect(view.counts.shown).toBe(3);
  } finally {
    remove();
  }
});

Deno.test("followRunners() shows no jobs and a badge saying OFFLINE once its socket closes, and opens another at once", async () => {
  const { elements, remove } = mount();
  try {
    const { view, opened } = await follow(elements);
    opened[0][1].deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
    await nextFrame();
    expect(view.counts.shown).toBe(1);
    expect(badgeOf(elements)).toEqual(LIVE);

    opened[0][1].drop();
    expect(view.counts).toEqual({ shown: 0, leaving: 0 });
    expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
    expect(badgeOf(elements)).toEqual(OFFLINE);
    // The board itself names no problem; the badge says what is wrong.
    expect(shows(pixels(elements.chrome), OUTCOME_COLORS.failed)).toBe(false);
    expect(opened.map(([url]) => url)).toEqual(["ws://runners.test/socket", "ws://runners.test/socket"]);

    // The socket opened again starts with its own snapshot.
    await opened[1][1].listening;
    expect(badgeOf(elements)).toEqual(OFFLINE);
    opened[1][1].deliver(snapshot([job(2, 4, { running: false })]));
    expect(legendLines(elements.legend)).toEqual([["labs PR #12 · CI @ aaaaaaa", "1 job"]]);
    expect(badgeOf(elements)).toEqual(LIVE);
    await nextFrame();
  } finally {
    remove();
  }
});

Deno.test("followRunners() shows the problems a snapshot names in red", async () => {
  const { elements, remove } = mount();
  try {
    const { opened } = await follow(elements);
    opened[0][1].deliver(snapshot([]));
    expect(shows(pixels(elements.chrome), OUTCOME_COLORS.failed)).toBe(false);
    opened[0][1].deliver(snapshot([], { problems: [PROBLEM] }));
    expect(shows(pixels(elements.chrome), OUTCOME_COLORS.failed)).toBe(true);
    await nextFrame();
  } finally {
    remove();
  }
});

Deno.test("followRunners() shows the first snapshot afresh, and animates later ones, sending off the jobs they end", async () => {
  const { elements, remove } = mount();
  try {
    const { view, opened } = await follow(elements);
    const socket = opened[0][1];
    // The board is shown afresh when its size is first observed, which
    // happens by the time an observer made after the page's own hears of it.
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(elements.board);
    });
    await nextFrame();
    socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
    await nextFrame();
    paintOver(elements.balls);
    await nextFrame();
    expect(rgba(pixels(elements.balls), 0, 0)).toEqual(MAGENTA);

    socket.deliver(snapshot([job(2, 4, { runner: "ci-mac-01-2" })], { outcomes: [[1, "passed"]] }));
    expect(view.counts).toEqual({ shown: 1, leaving: 1 });
    await nextFrame();
    paintOver(elements.balls);
    await nextFrame();
    expect(rgba(pixels(elements.balls), 0, 0)).toEqual([0, 0, 0, 0]);
  } finally {
    remove();
  }
});

Deno.test("followRunners() lets the balls grow again with each snapshot, but not with a change of runners", async () => {
  const { elements, remove } = mount();
  try {
    const { opened } = await follow(elements);
    const socket = opened[0][1];
    socket.deliver(snapshot([], { runners: MANY_RUNNERS }));
    const crowded = widthNamed(elements, "ci-mac-01-2: idle");
    socket.deliver({ type: "runners", runners: RUNNERS, larger: [], problems: [] });
    await nextFrame();
    expect(widthNamed(elements, "ci-mac-01-2: idle")).toBe(crowded);
    socket.deliver(snapshot([]));
    expect(widthNamed(elements, "ci-mac-01-2: idle")).toBeGreaterThan(crowded + 3);
  } finally {
    remove();
  }
});

Deno.test("followRunners() waits for a socket that opens later, and shows it is not connected when one cannot open, trying again later", async () => {
  for (
    const refuse of [
      (): Promise<PageSocket> => Promise.reject(new Error("refused")),
      (): PageSocket => {
        throw new Error("refused");
      },
    ]
  ) {
    const { elements, remove } = mount();
    try {
      let opens = 0;
      followRunners("ws://runners.test/socket", "v1", elements, () => {
        opens++;
        return refuse();
      }, never);
      await nextFrame();
      expect(opens).toBe(1);
      expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
      expect(badgeOf(elements)).toEqual(OFFLINE);
    } finally {
      remove();
    }
  }

  const { elements, remove } = mount();
  try {
    const later = deferred<PageSocket>();
    const view = followRunners("ws://runners.test/socket", "v1", elements, () => later.promise, never);
    const socket = new FakeSocket();
    later.resolve(socket);
    await socket.listening;
    socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" })]));
    expect(view.counts.shown).toBe(1);
    expect(badgeOf(elements)).toEqual(LIVE);
  } finally {
    remove();
  }
});

Deno.test("followRunners() takes a ping as hearing from the server, and opens another socket at once only after a socket it heard from closes", async () => {
  const { elements, remove } = mount();
  try {
    const { opened } = await follow(elements);
    opened[0][1].drop();
    expect(opened).toHaveLength(1);
  } finally {
    remove();
  }

  const { elements: others, remove: removeOthers } = mount();
  try {
    const { view, opened } = await follow(others);
    expect(() => opened[0][1].deliver({ type: "ping" })).not.toThrow();
    expect(others.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
    expect(view.counts.shown).toBe(0);
    opened[0][1].drop();
    expect(opened).toHaveLength(2);
  } finally {
    removeOthers();
  }
});

Deno.test("followRunners() gives up on an open socket silent for more than three checks' time, closing it and opening another at once, and hears nothing more from it", async () => {
  const { elements, remove } = mount();
  try {
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
    expect(elements.legend.querySelector(".empty")?.textContent).toBe("No jobs on the board.");
    expect(badgeOf(elements)).toEqual(OFFLINE);
    expect(opened).toHaveLength(2);

    // What the socket given up on says after is not heard, and its closing
    // opens no other.
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
  } finally {
    remove();
  }
});

Deno.test("followRunners() opens a socket on the next check when it has none, and none while one is open", async () => {
  const { elements, remove } = mount();
  try {
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
  } finally {
    remove();
  }
});

Deno.test("followRunners() keeps a socket that goes on carrying pings", async () => {
  const { elements, remove } = mount();
  try {
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
  } finally {
    remove();
  }
});

Deno.test("followRunners() gives up on a socket that never finishes opening, trying another at once, and closes it should it open after", async () => {
  const { elements, remove } = mount();
  try {
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

    // The socket given up on opens while the next is still opening.
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
  } finally {
    remove();
  }
});

Deno.test("followRunners() sets the badge to LIVE when a socket carries a message, to OFFLINE when it loses the socket, and to LIVE again when a new one is heard", async () => {
  const { elements, remove } = mount();
  try {
    const clock = checkedClock();
    // The page's markup says LIVE before anything is heard; marked offline, a
    // first message must say LIVE for itself.
    elements.badge.textContent = "● OFFLINE";
    elements.badge.classList.add("offline");
    const { opened } = await follow(elements, clock.every, clock.now);
    expect(badgeOf(elements)).toEqual(OFFLINE);
    opened[0][1].deliver({ type: "ping" });
    expect(badgeOf(elements)).toEqual(LIVE);

    // Heard from, the socket is opened again at once when it closes, and the
    // badge stays OFFLINE until the new one carries something.
    opened[0][1].drop();
    expect(badgeOf(elements)).toEqual(OFFLINE);
    expect(opened).toHaveLength(2);
    await opened[1][1].listening;
    expect(badgeOf(elements)).toEqual(OFFLINE);
    opened[1][1].deliver(snapshot([]));
    expect(badgeOf(elements)).toEqual(LIVE);

    // One that closes unheard leaves it OFFLINE through the check that opens
    // the next, until that one is heard.
    opened[1][1].drop();
    await opened[2][1].listening;
    opened[2][1].drop();
    expect(badgeOf(elements)).toEqual(OFFLINE);
    clock.check();
    expect(opened).toHaveLength(4);
    await opened[3][1].listening;
    expect(badgeOf(elements)).toEqual(OFFLINE);
    opened[3][1].deliver({ type: "ping" });
    expect(badgeOf(elements)).toEqual(LIVE);
  } finally {
    remove();
  }
});

Deno.test("followRunners() first tells each socket it opens that the page is visible", async () => {
  const { elements, remove } = mount();
  try {
    const clock = checkedClock();
    const { opened } = await follow(elements, clock.every, clock.now);
    expect(opened[0][1].sent).toEqual([VISIBLE]);

    // One opened at once after a socket heard from closes, and one opened by
    // a check.
    opened[0][1].deliver({ type: "ping" });
    opened[0][1].drop();
    await opened[1][1].listening;
    expect(opened[1][1].sent).toEqual([VISIBLE]);
    opened[1][1].drop();
    clock.check();
    await opened[2][1].listening;
    expect(opened[2][1].sent).toEqual([VISIBLE]);
    expect(opened[0][1].sent).toEqual([VISIBLE]);
  } finally {
    remove();
  }
});

Deno.test("followRunners() tells its open socket whether the page is visible each time that changes, and no socket while one is opening or none is open", async () => {
  const { elements, remove } = mount();
  try {
    const clock = checkedClock();
    const openings: { resolve: (socket: PageSocket) => void; promise: Promise<PageSocket> }[] = [];
    followRunners("ws://runners.test/socket", "v1", elements, () => {
      const opening = deferred<PageSocket>();
      openings.push(opening);
      return opening.promise;
    }, clock.every, clock.now);
    const changeVisibility = () => document.dispatchEvent(new Event("visibilitychange"));

    changeVisibility();
    const first = new FakeSocket();
    openings[0].resolve(first);
    await first.listening;
    expect(first.sent).toEqual([VISIBLE]);
    changeVisibility();
    expect(first.sent).toEqual([VISIBLE, VISIBLE]);

    first.drop();
    changeVisibility();
    expect(first.sent).toEqual([VISIBLE, VISIBLE]);

    clock.check();
    expect(openings).toHaveLength(2);
    changeVisibility();
    const second = new FakeSocket();
    openings[1].resolve(second);
    await second.listening;
    expect(second.sent).toEqual([VISIBLE]);
    expect(first.sent).toEqual([VISIBLE, VISIBLE]);
  } finally {
    remove();
  }
});

Deno.test("openedSocket() rejects for a socket whose server will not take it, and does not resolve", async () => {
  // The test's server serves files, and takes no socket.
  let resolved = false;
  const opening = openedSocket(`ws://${location.host}/runners/socket`).then((socket) => {
    resolved = true;
    return socket;
  });
  await expect(opening).rejects.toThrow("closed before it opened");
  expect(resolved).toBe(false);
});

Deno.test("followRunners() on real sockets shows OFFLINE once one cannot open, leaving no rejection unhandled", async () => {
  const { elements, remove } = mount();
  const unhandled: unknown[] = [];
  const noteUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
  addEventListener("unhandledrejection", noteUnhandled);
  try {
    const offline = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (elements.badge.classList.contains("offline")) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(elements.badge, { attributes: true, childList: true, characterData: true, subtree: true });
    });
    const view = followRunners(`ws://${location.host}/runners/socket`, "v1", elements, undefined, never);
    expect(badgeOf(elements)).toEqual(LIVE);
    await offline;
    expect(badgeOf(elements)).toEqual(OFFLINE);
    expect(view.counts.shown).toBe(0);
    // A rejection left unhandled is reported in a task of its own.
    await nextFrame();
    await nextFrame();
    expect(unhandled).toEqual([]);
  } finally {
    removeEventListener("unhandledrejection", noteUnhandled);
    remove();
  }
});

Deno.test("followRunners() draws the board again at its new size when it is resized, leaving what moves on it moving", async () => {
  const { elements, remove } = mount();
  try {
    const { view, opened } = await follow(elements);
    const socket = opened[0][1];
    socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-1" }), job(2, 4, { runner: "ci-mac-01-2" })]));
    await nextFrame();
    // The later snapshot sends the second job off and moves the first.
    socket.deliver(snapshot([job(1, 3, { runner: "ci-mac-01-2" })], { outcomes: [[2, "passed"]] }));
    await nextFrame();
    expect(view.counts).toEqual({ shown: 1, leaving: 1 });

    // An observer made after the page's own hears of a change after it.
    const resized = new Promise<void>((resolve) => {
      const observer = new ResizeObserver((entries) => {
        if (entries.some((entry) => entry.contentRect.width === 2 * BOARD_WIDTH)) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(elements.board);
    });
    elements.board.classList.add("double");
    await resized;
    expect(view.counts).toEqual({ shown: 1, leaving: 1 });
    expect([elements.chrome.width, elements.chrome.height]).toEqual([
      Math.round(2 * BOARD_WIDTH * devicePixelRatio),
      Math.round(elements.board.clientHeight * devicePixelRatio),
    ]);
    await nextFrame();
    paintOver(elements.balls);
    await nextFrame();
    expect(rgba(pixels(elements.balls), 0, 0)).toEqual([0, 0, 0, 0]);
    expect([elements.balls.width, elements.balls.height]).toEqual([elements.chrome.width, elements.chrome.height]);
  } finally {
    remove();
  }
});

Deno.test("followRunners() throws for a message it does not understand", async () => {
  const { elements, remove } = mount();
  try {
    const { opened } = await follow(elements);
    expect(() => opened[0][1].deliverText(JSON.stringify({ type: "gossip" }))).toThrow(
      "the dashboard sent a message the runners page does not understand",
    );
    expect(() => opened[0][1].deliver(snapshot([]))).not.toThrow();
  } finally {
    remove();
  }
});

// The circle tests run once on a canvas that has WebGL 2, and once on one
// that has only the 2D context, which a canvas whose 2D context is already
// taken is.
for (const [kind, accelerated] of [["WebGL", true], ["2D", false]] as const) {
  const renderer = (): { canvas: HTMLCanvasElement; renderer: BallRenderer } => {
    const canvas = document.createElement("canvas");
    if (!accelerated) context2d(canvas);
    return { canvas, renderer: new BallRenderer(canvas) };
  };
  const RED = "#ff0000";
  const BLUE = "#0000ff";
  const CLEAR = [0, 0, 0, 0];

  Deno.test(`BallRenderer (${kind}) says whether it draws with WebGL`, () => {
    expect(renderer().renderer.accelerated).toBe(accelerated);
  });

  Deno.test(`BallRenderer (${kind}) draws each circle in its color, and nothing around it`, () => {
    const { canvas, renderer: balls } = renderer();
    balls.add(30, 40, 15, RED, null);
    balls.add(70, 40, 10, BLUE, null);
    balls.draw(100, 80, 1);
    expect([canvas.width, canvas.height]).toEqual([100, 80]);
    const image = pixels(canvas);
    expect(rgba(image, 30, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 22, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 70, 40)).toEqual([0, 0, 255, 255]);
    expect(rgba(image, 30, 60)).toEqual(CLEAR);
    expect(rgba(image, 50, 40)).toEqual(CLEAR);
    expect(rgba(image, 70, 55)).toEqual(CLEAR);
    expect(rgba(image, 5, 5)).toEqual(CLEAR);
  });

  Deno.test(`BallRenderer (${kind}) draws nothing of a clipped circle outside its rounded box`, () => {
    const { canvas, renderer: balls } = renderer();
    const clip: Clip = { x: 20, y: 20, width: 60, height: 40, radius: 15 };
    balls.add(50, 40, 100, RED, clip);
    balls.draw(100, 80, 1);
    const image = pixels(canvas);
    expect(rgba(image, 50, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 50, 22)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 22, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 50, 15)).toEqual(CLEAR);
    expect(rgba(image, 85, 40)).toEqual(CLEAR);
    // Within the box's corners, but outside its rounding.
    expect(rgba(image, 22, 22)).toEqual(CLEAR);
    expect(rgba(image, 78, 58)).toEqual(CLEAR);
  });

  Deno.test(`BallRenderer (${kind}) clears what it drew before, drawing only what was added since`, () => {
    const { canvas, renderer: balls } = renderer();
    balls.add(30, 40, 15, RED, null);
    balls.draw(100, 80, 1);
    balls.add(70, 40, 10, BLUE, null);
    balls.draw(100, 80, 1);
    let image = pixels(canvas);
    expect(rgba(image, 30, 40)).toEqual(CLEAR);
    expect(rgba(image, 70, 40)).toEqual([0, 0, 255, 255]);
    balls.draw(100, 80, 1);
    image = pixels(canvas);
    expect(rgba(image, 70, 40)).toEqual(CLEAR);
  });

  Deno.test(`BallRenderer (${kind}) draws at the scale it is given, on a canvas sized to match, with edges a device pixel sharp`, () => {
    const { canvas, renderer: balls } = renderer();
    balls.add(30, 20, 5, RED, null);
    balls.draw(50, 40, 2);
    expect([canvas.width, canvas.height]).toEqual([100, 80]);
    const image = pixels(canvas);
    expect(rgba(image, 60, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 68, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(image, 30, 20)).toEqual(CLEAR);
    expect(rgba(image, 74, 40)).toEqual(CLEAR);
    // The circle's edge, ten device pixels from its center, falls between
    // these two pixels, so the one inside is all but opaque and the one
    // outside all but clear.
    expect(rgba(image, 69, 40)[3]).toBeGreaterThanOrEqual(240);
    expect(rgba(image, 70, 40)[3]).toBeLessThanOrEqual(16);
  });

  Deno.test(`BallRenderer (${kind}) draws every circle of a frame with more than a few hundred`, () => {
    const { canvas, renderer: balls } = renderer();
    const centers = Array.from({ length: 600 }, (_, i) => [5 + (i % 30) * 10, 5 + Math.floor(i / 30) * 10]);
    for (const [x, y] of centers) balls.add(x, y, 3, RED, null);
    balls.draw(300, 200, 1);
    const image = pixels(canvas);
    expect(centers.filter(([x, y]) => rgba(image, x, y)[3] !== 255)).toEqual([]);
    expect(rgba(image, 10, 10)).toEqual(CLEAR);
  });
}

Deno.test("BallRenderer draws with WebGL again once the browser restores a context it lost", async () => {
  const canvas = document.createElement("canvas");
  const balls = new BallRenderer(canvas);
  const losing = canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context");
  if (!losing) throw new Error("the browser cannot lose a WebGL context on purpose");
  const lost = once(canvas, "webglcontextlost");
  losing.loseContext();
  await lost;
  // The browser allows a restore only once it has finished telling every
  // listener of the loss.
  await nextFrame();
  const restored = once(canvas, "webglcontextrestored");
  losing.restoreContext();
  await restored;
  balls.add(30, 40, 15, "#ff0000", null);
  balls.draw(100, 80, 1);
  expect(rgba(pixels(canvas), 30, 40)).toEqual([255, 0, 0, 255]);
  expect(rgba(pixels(canvas), 5, 5)).toEqual([0, 0, 0, 0]);
});

Deno.test("BallRenderer made on a lost WebGL context draws nothing until the context is restored, then draws", async () => {
  const canvas = document.createElement("canvas");
  const losing = canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context");
  if (!losing) throw new Error("the browser cannot lose a WebGL context on purpose");
  // Whatever held the context when it was lost asks for it back.
  canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
  const lost = once(canvas, "webglcontextlost");
  losing.loseContext();
  await lost;
  await nextFrame();

  const balls = new BallRenderer(canvas);
  expect(balls.accelerated).toBe(true);
  balls.add(30, 40, 15, "#ff0000", null);
  balls.draw(100, 80, 1);
  expect(rgba(pixels(canvas), 30, 40)).toEqual([0, 0, 0, 0]);

  const restored = once(canvas, "webglcontextrestored");
  losing.restoreContext();
  await restored;
  balls.add(30, 40, 15, "#ff0000", null);
  balls.draw(100, 80, 1);
  expect(rgba(pixels(canvas), 30, 40)).toEqual([255, 0, 0, 255]);
});

// A canvas whose WebGL 2 context refuses every shader, as some drivers do.
class RefusingCanvas extends HTMLCanvasElement {
  override getContext(contextId: "2d", options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D | null;
  override getContext(
    contextId: "bitmaprenderer",
    options?: ImageBitmapRenderingContextSettings,
  ): ImageBitmapRenderingContext | null;
  override getContext(contextId: "webgl", options?: WebGLContextAttributes): WebGLRenderingContext | null;
  override getContext(contextId: "webgl2", options?: WebGLContextAttributes): WebGL2RenderingContext | null;
  override getContext(contextId: string, options?: unknown): RenderingContext | null;
  override getContext(contextId: string, options?: unknown): RenderingContext | null {
    const context = super.getContext(contextId, options);
    if (!(context instanceof WebGL2RenderingContext)) return context;
    return new Proxy(context, {
      get(target, key) {
        if (key === "getShaderParameter") return () => false;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
customElements.define("refusing-canvas", RefusingCanvas, { extends: "canvas" });

// A canvas whose WebGL refuses its shaders, with an ID, a class, and a style.
function refusingCanvas(id: string, className: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas", { is: "refusing-canvas" });
  canvas.id = id;
  canvas.className = className;
  canvas.style.opacity = "0.9";
  return canvas;
}

Deno.test("BallRenderer whose WebGL cannot be set up draws with the 2D context, on a canvas that takes the first's place", () => {
  const holder = document.createElement("div");
  const canvas = refusingCanvas("refused", "layer");
  holder.append(canvas);
  document.body.append(holder);
  try {
    const balls = new BallRenderer(canvas);
    expect(balls.accelerated).toBe(false);
    const fresh = holder.firstElementChild;
    if (!(fresh instanceof HTMLCanvasElement)) throw new Error("no canvas took the first's place");
    expect(fresh).not.toBe(canvas);
    expect(holder.children).toHaveLength(1);
    expect([fresh.id, fresh.className, fresh.style.opacity]).toEqual(["refused", "layer", "0.9"]);

    balls.add(30, 40, 15, "#ff0000", null);
    balls.draw(100, 80, 1);
    expect([fresh.width, fresh.height]).toEqual([100, 80]);
    expect(rgba(pixels(fresh), 30, 40)).toEqual([255, 0, 0, 255]);
    expect(rgba(pixels(fresh), 5, 5)).toEqual([0, 0, 0, 0]);
  } finally {
    holder.remove();
  }
});

Deno.test("RunnersView whose WebGL cannot be set up draws its balls with the 2D context in the balls' place, where they can be pointed at", async () => {
  const { elements: mounted, remove } = mount();
  try {
    const balls = refusingCanvas("balls", "layer");
    mounted.balls.replaceWith(balls);
    const elements = { ...mounted, balls };
    const view = new RunnersView(elements);
    view.show(boardOf([job(1, 7, { name: "build", runner: "ci-mac-01-1" })]), noOutcome, true);
    await nextFrame();
    const drawn = elements.board.querySelector("#balls");
    if (!(drawn instanceof HTMLCanvasElement)) throw new Error("the balls have no canvas");
    expect(drawn).not.toBe(balls);
    expect(drawn.parentElement).toBe(elements.board);
    const center = inkCenter(drawn);
    if (center === undefined) throw new Error("no ball was drawn");
    pointAt(elements.board, center.x, center.y);
    expect(elements.tooltip.textContent).toBe("labs · CI on main @ aaaaaaa\nbuild\nRunning on ci-mac-01-1");
  } finally {
    remove();
  }
});
