import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as runnerBoard from "./runner-board.ts";
import type { LargerRunner, Runner } from "./runner-board.ts";
import * as runnerGl from "./runner-gl.ts";
import * as runnerJobs from "./runner-jobs.ts";
import type { JobNews, News } from "./runner-jobs.ts";
import * as runnerLayout from "./runner-layout.ts";
import type { MeasureText } from "./runner-layout.ts";
import * as runnerPhysics from "./runner-physics.ts";
import type { Motion } from "./runner-physics.ts";
import * as runnerView from "./runner-view.ts";
import { LIVE_PAGE_BADGE, LIVE_PAGE_STYLES } from "./live-page.ts";
import { runnersPage, runnersScript } from "./runners-page.ts";
import { RUNNERS_KEY_PATH, RUNNERS_SOCKET_PATH } from "./runners-paths.ts";

// The modules are imported whole, so that the case reading the script can
// range over everything they export.
const {
  abbreviateHashes,
  boardTokens,
  buildBoard,
  compareTuples,
  forgetBeyond,
  newSteadiness,
  remembersMore,
  runTitle,
  RunPalette,
  steadyBoard,
} = runnerBoard;
const { BallRenderer } = runnerGl;
const { JobTracker } = runnerJobs;
const { boxCount, layoutBoard } = runnerLayout;
const { heapDiameter, HeapWorld, leaveStep, startLeaving, steerStep } = runnerPhysics;
const { followRunners, RunnersView } = runnerView;

const VERSION = "page-test-version";

/**
 * The page script's copies of the runner modules' declarations, which have
 * the types of the originals since they are the originals' source.
 */
interface ScriptCopies {
  abbreviateHashes: typeof abbreviateHashes;
  BallRenderer: typeof BallRenderer;
  boardTokens: typeof boardTokens;
  boxCount: typeof boxCount;
  buildBoard: typeof buildBoard;
  followRunners: typeof followRunners;
  forgetBeyond: typeof forgetBeyond;
  heapDiameter: typeof heapDiameter;
  HeapWorld: typeof HeapWorld;
  JobTracker: typeof JobTracker;
  layoutBoard: typeof layoutBoard;
  leaveStep: typeof leaveStep;
  newSteadiness: typeof newSteadiness;
  remembersMore: typeof remembersMore;
  RunnersView: typeof RunnersView;
  RunPalette: typeof RunPalette;
  runTitle: typeof runTitle;
  startLeaving: typeof startLeaving;
  steadyBoard: typeof steadyBoard;
  steerStep: typeof steerStep;
}

/** The page script's own opener of its socket, beside its copies. */
interface PageScript extends ScriptCopies {
  openSocket(url: string): Promise<unknown>;
}

/** What the page script reads its key with. */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** What the page script opens its socket with. */
type SocketClass = new (url: string) => unknown;

/** Stands in for what a case does not expect the script to use. */
function unavailable(): never {
  throw new Error("not available to this case");
}

/**
 * Evaluates `script`'s declarations, everything before the call that starts
 * the page, in a function of their own, with `fetch` and `WebSocket` as the
 * browser's, and returns its copies and its socket opener. A function made by
 * `new Function` sees the global scope and not this module's, so a name the
 * copies use that the script does not declare is a `ReferenceError` there, as
 * it is in the browser.
 */
function evaluate(script: string, fetch: Fetch = unavailable, WebSocket: SocketClass = class {
  constructor() {
    unavailable();
  }
}): PageScript {
  const declarations = script.slice(0, script.lastIndexOf("followRunners("));
  const evaluated = new Function(
    "location",
    "fetch",
    "WebSocket",
    `${declarations}
return {
  abbreviateHashes, BallRenderer, boardTokens, boxCount, buildBoard, followRunners, forgetBeyond,
  heapDiameter, HeapWorld, JobTracker, layoutBoard, leaveStep, newSteadiness, openSocket, remembersMore,
  RunnersView, RunPalette, runTitle, startLeaving, steadyBoard, steerStep,
};
}`,
  );
  return evaluated({ protocol: "https:", host: "dashboard.test" }, fetch, WebSocket);
}

/** The names of every value the runner modules export. */
const EXPORTED = Object.keys({
  ...runnerBoard,
  ...runnerGl,
  ...runnerJobs,
  ...runnerLayout,
  ...runnerPhysics,
  ...runnerView,
});

/**
 * Returns the names the runner modules export that `script`'s declarations,
 * everything before the call that starts the page, use as a whole word but do
 * not declare at their top level, where each declaration starts a line, as a
 * constant, a function, or a class.
 */
function undeclared(script: string): string[] {
  const declarations = script.slice(0, script.lastIndexOf("followRunners("));
  return EXPORTED.filter((name) =>
    new RegExp(`\\b${name}\\b`).test(declarations) &&
    !new RegExp(`^(?:const|function|class|async function)\\s+${name}\\b`, "m").test(declarations)
  );
}

/** The real modules, under the same names as the copies. */
const ORIGINALS: ScriptCopies = {
  abbreviateHashes,
  BallRenderer,
  boardTokens,
  boxCount,
  buildBoard,
  followRunners,
  forgetBeyond,
  heapDiameter,
  HeapWorld,
  JobTracker,
  layoutBoard,
  leaveStep,
  newSteadiness,
  remembersMore,
  RunnersView,
  RunPalette,
  runTitle,
  startLeaving,
  steadyBoard,
  steerStep,
};

/** A job of the organization `example`'s repository `repo`, queued. */
function job(id: number, runId: number, fields: Partial<JobNews> = {}): JobNews {
  return {
    kind: "job",
    id,
    runId,
    attempt: 1,
    owner: "example",
    repository: "repo",
    workflow: "CI",
    branch: "topic",
    sha: "0123456789abcdef0123456789abcdef01234567",
    name: `job ${id} (0123456789abcdef0123456789abcdef01234567)`,
    status: "queued",
    conclusion: null,
    labels: ["self-hosted", "mac"],
    runner: null,
    runnerGroup: null,
    createdAt: "2026-11-24T00:00:00Z",
    startedAt: null,
    url: `https://github.com/example/repo/actions/runs/${runId}/job/${id}`,
    ...fields,
  };
}

/** Jobs queued and running on every kind of pool the board has. */
const NEWS: readonly News[] = [
  { kind: "run", id: 1, attempt: 1, status: "in_progress", conclusion: null, pullRequest: 42 },
  job(11, 1),
  job(12, 1, {
    status: "in_progress",
    labels: ["self-hosted", "macOS", "mac"],
    runner: "ci-mac-01-2",
    runnerGroup: "Default",
    startedAt: "2026-11-24T00:01:00Z",
  }),
  job(13, 2, { labels: ["big-linux"] }),
  job(14, 2, {
    status: "in_progress",
    labels: ["ubuntu-latest"],
    runner: "GitHub Actions 3",
    runnerGroup: "GitHub Actions",
  }),
  job(15, 3, { labels: ["self-hosted", "gpu"] }),
  job(16, 3, { status: "in_progress", labels: ["self-hosted", "spare"], runner: "spare-1" }),
  job(17, 3, { status: "completed", conclusion: "failure" }),
];

const RUNNERS: readonly Runner[] = [
  { owner: "example", name: "ci-mac-01-1", labels: ["self-hosted", "macOS", "ci-mac-01", "mac"], online: true },
  { owner: "example", name: "ci-mac-01-2", labels: ["self-hosted", "macOS", "ci-mac-01", "mac"], online: true },
  { owner: "example", name: "ci-mac-02-1", labels: ["self-hosted", "macOS", "ci-mac-02", "mac"], online: false },
  { owner: "example", name: "spare-1", labels: ["self-hosted", "linux", "spare"], online: true },
];

const LARGER: readonly LargerRunner[] = [
  { owner: "example", name: "big-linux", maximum: 4, cores: 8, memory: 32 },
];

/** Measures text as six pixels a character, eight in a heading. */
const measure: MeasureText = (text, style) => text.length * (style === "heading" ? 8 : 6);

/**
 * Runs the board through `use`, from `NEWS` to the board laid out, then a
 * job's end, then the heap, a ball steered to a place, and balls leaving,
 * and returns what each step made.
 */
function exercise(use: ScriptCopies) {
  const tracker = new use.JobTracker();
  for (const news of NEWS) tracker.take(news);
  const board = () =>
    use.buildBoard(tracker.jobs.values(), RUNNERS, LARGER, (runId) => tracker.pullRequest(runId), ["a problem"]);
  const memory = use.newSteadiness();
  const first = board();
  const steadied = use.steadyBoard(first, memory);
  const palette = new use.RunPalette();
  palette.update(steadied.runs);
  const layout = use.layoutBoard(steadied, 780, 600, 16, measure);

  tracker.take(job(16, 3, { status: "completed", conclusion: "success" }));
  tracker.take({ kind: "run", id: 2, attempt: 1, status: "completed", conclusion: "cancelled", pullRequest: null });
  const later = board();
  const remembered = use.remembersMore(memory, later);
  const resteadied = use.steadyBoard(later, memory);
  use.forgetBeyond(memory, later);

  const diameter = use.heapDiameter(12, 120, 90, 16);
  const heap = new use.HeapWorld(120, 90, diameter);
  for (let i = 0; i < 12; i++) heap.add(i, 10 + (i % 6) * 18, -20 - Math.floor(i / 6) * 18);
  let heapSteps = 0;
  while (heap.advance(1 / 60)) heapSteps++;
  const balls = Array.from({ length: heap.count }, (_, i) => [heap.idAt(i), heap.xAt(i), heap.yAt(i)]);

  const steered: Motion = { x: 10, y: 10, vx: 200, vy: -50, t: 0 };
  let steerSteps = 1;
  while (!use.steerStep(steered, { x: 300, y: 200 }, false)) steerSteps++;

  const leaving = (["passed", "failed", "neither"] as const).map((outcome) => {
    const motion: Motion = { x: 400, y: 300, vx: 20, vy: 0, t: 0 };
    const how = use.startLeaving(motion, 12, outcome, 780, 600, 100, 700);
    let steps = 1;
    while (!use.leaveStep(motion, how)) steps++;
    return { how, motion, steps };
  });

  return {
    tracker: tracker.snapshot(),
    first,
    tokens: use.boardTokens(first).map((token) => [token.id, use.runTitle(token)]),
    steadied,
    colors: steadied.runs.map((run) => palette.color(run.id)),
    layout,
    counts: steadied.pools.flatMap((pool) => pool.boxes.map((box) => use.boxCount(box))),
    later,
    remembered,
    resteadied,
    memory,
    heap: { diameter: heap.diameter, resting: heap.resting, steps: heapSteps, balls },
    steered: { motion: steered, steps: steerSteps },
    leaving,
    abbreviated: use.abbreviateHashes("build 0123456789abcdef0123456789abcdef01234567"),
  };
}

describe("runners-page", () => {
  describe("runnersPage()", () => {
    it("holds every element the script looks up by ID", () => {
      const page = runnersPage(VERSION);
      const ids = [...runnersScript(VERSION).matchAll(/document\.getElementById\("([^"]+)"\)/g)]
        .map((match) => match[1]);

      expect(ids.sort()).toEqual(["balls", "board", "chrome", "effects", "legend", "live-badge", "tooltip"]);
      for (const id of ids) expect(page).toContain(`id="${id}"`);
    });

    it("carries the live pages' badge beside its title, with its styles", () => {
      const page = runnersPage(VERSION);

      expect(page).toContain(`<b>Runners</b>${LIVE_PAGE_BADGE}`);
      expect(page).toContain(LIVE_PAGE_STYLES);
      expect(page.indexOf(LIVE_PAGE_STYLES)).toBeLessThan(page.indexOf("</style>"));
      expect(page.split(LIVE_PAGE_BADGE).length).toBe(2);
    });

    it("runs the script for its version, connecting to the runners socket", () => {
      const page = runnersPage(VERSION);

      expect(page).toContain(`<script>${runnersScript(VERSION)}</script>`);
      expect(page).toContain(JSON.stringify(VERSION));
      expect(page).not.toContain(JSON.stringify("another-version"));
      expect(runnersScript(VERSION)).toContain(JSON.stringify(RUNNERS_SOCKET_PATH));
    });
  });

  describe("runnersScript()", () => {
    /**
     * A WebSocket class for the page script, whose sockets fire `open` and
     * `close` when a case says, and the first socket made with it.
     */
    function socketClass(log: string[][] = []) {
      const made = Promise.withResolvers<FakeWebSocket>();
      class FakeWebSocket {
        #listeners: { type: string; listener: () => void }[] = [];

        constructor(url: string) {
          log.push(["socket", url]);
          made.resolve(this);
        }

        addEventListener(type: string, listener: () => void): void {
          this.#listeners.push({ type, listener });
        }

        /** Calls the listeners for `type`, which, as the script asks, hear it once. */
        fire(type: string): void {
          const firing = this.#listeners.filter((held) => held.type === type);
          this.#listeners = this.#listeners.filter((held) => held.type !== type);
          for (const { listener } of firing) listener();
        }
      }
      return { FakeWebSocket, made: made.promise };
    }

    it("opens each socket with the key it reads afresh from `RUNNERS_KEY_PATH`", async () => {
      const key = "a key/with&odd=characters";
      const log: string[][] = [];
      const fetch: Fetch = (input, init) => {
        log.push(["fetch", input, String(init.cache)]);
        return Promise.resolve(new Response(key));
      };
      const { FakeWebSocket, made } = socketClass(log);
      const script = runnersScript(VERSION);
      const { openSocket } = evaluate(script, fetch, FakeWebSocket);

      const opening = openSocket("wss://dashboard.test/runners/socket");
      const socket = await made;
      socket.fire("open");

      expect(await opening).toBe(socket);
      expect(log).toEqual([
        ["fetch", RUNNERS_KEY_PATH, "no-store"],
        ["socket", `wss://dashboard.test/runners/socket?key=${encodeURIComponent(key)}`],
      ]);
      expect(log[1][1]).not.toContain(key);
      expect(script).toMatch(/\}, openSocket\);\n\}$/);
    });

    it("resolves with the socket only once it opens, and rejects if it closes first", async () => {
      const fetch: Fetch = () => Promise.resolve(new Response("key"));
      const url = "wss://dashboard.test/runners/socket";

      const opens = socketClass();
      const opening = evaluate(runnersScript(VERSION), fetch, opens.FakeWebSocket).openSocket(url);
      const socket = await opens.made;
      expect(await Promise.race([opening, Promise.resolve("still opening")])).toBe("still opening");
      socket.fire("open");
      socket.fire("close");
      expect(await opening).toBe(socket);

      const closes = socketClass();
      const closing = evaluate(runnersScript(VERSION), fetch, closes.FakeWebSocket).openSocket(url);
      (await closes.made).fire("close");
      await expect(closing).rejects.toThrow(`the socket at ${url}?key=key closed before it opened`);
    });

    it("rejects without opening a socket when the key cannot be read", async () => {
      const opened: string[] = [];
      class FakeWebSocket {
        constructor(url: string) {
          opened.push(url);
        }
      }
      const fetch: Fetch = () => Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      const { openSocket } = evaluate(runnersScript(VERSION), fetch, FakeWebSocket);

      await expect(openSocket("wss://dashboard.test/runners/socket")).rejects.toThrow(
        "the dashboard did not give the runners page its key",
      );
      expect(opened).toEqual([]);
    });

    it("declares every name the runner modules use, so its copies do what the modules do", () => {
      const copies = evaluate(runnersScript(VERSION));
      const ran = exercise(copies);

      expect(ran).toEqual(exercise(ORIGINALS));
      expect(ran.first.pools.length).toBeGreaterThan(3);
      expect(ran.first.pools.some((pool) => pool.queue.length > 0)).toBe(true);
      expect(ran.heap.resting).toBe(true);
      expect(ran.leaving.map(({ how }) => how.outcome)).toEqual(["passed", "failed", "neither"]);
      expect(copies.RunnersView.toString()).toBe(RunnersView.toString());
      expect(copies.BallRenderer.toString()).toBe(BallRenderer.toString());
      expect(copies.followRunners.toString()).toBe(followRunners.toString());
    });

    it("declares every name of the runner modules its declarations use, including those only drawing on the page uses", () => {
      // The case above runs most of the script's copies, but not the view,
      // the renderer, or what connects them to the socket, which need a
      // browser. This reads the whole script instead.

      const script = runnersScript(VERSION);

      expect(undeclared(script)).toEqual([]);
      expect(EXPORTED).toContain("OUTCOME_COLORS");
      for (const name of ["OUTCOME_COLORS", "SOCKET_CHECK_MS"]) {
        const constant = new RegExp(`^const ${name} = .*\\n`, "m");
        expect(script).toMatch(constant);
        expect(undeclared(script.replace(constant, ""))).toEqual([name]);
      }
      expect(undeclared(script.replace(runnerView.RunnersView.toString(), ""))).toEqual(["RunnersView"]);
    });

    it("leaves a copy that throws a `ReferenceError` when a declaration it uses is left out", () => {
      // This is what the case above rests on: nothing outside the script
      // supplies a name it leaves out.

      const script = runnersScript(VERSION);
      const declaration = compareTuples.toString();
      expect(script).toContain(declaration);

      const copies = evaluate(script.replace(declaration, ""));

      expect(() => exercise(copies)).toThrow(ReferenceError);
      expect(() => exercise(copies)).toThrow("compareTuples is not defined");
    });
  });
});
