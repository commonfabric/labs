/**
 * A browser showing a piece grid whose pieces its own runtime is not running,
 * which is what a reload of a space full of notes looks like to the viewer.
 *
 * `cf-render` opens the piece it displays, so a grid of tiles starts every
 * piece it shows. Starting a note instantiates its whole pattern in the
 * browser's worker, and each node it instantiates collects its dependencies.
 * In the 13-note workload of labs#3954 that came to about 340 subscriptions,
 * whose cost landed either inside the reload or on the first interaction after
 * it. These benchmarks chart both places at 13 notes and at a larger size:
 *
 * - `load <n>`: signing in on a page already routed to the grid, until the view
 *   has settled and every tile's editor shows its note's body. Signing in is
 *   what builds the browser's runtime, so this interval holds the runtime's
 *   start, the grid's render, and every tile's open of its note. The shell's
 *   bundle load and routing come before it.
 * - `first interaction <n>`: from the load above, typing one character into the
 *   first tile's editor and committing it, until the view has settled with the
 *   edit in it. Focus, keystroke and blur are all inside the interval; the blur
 *   is what commits the edit without waiting out the editor's debounce. That
 *   the editor's cell holds the edit is checked after the interval.
 *
 * Each size seeds a space of its own: the notes, and a piece-grid piece listing
 * them. The notes are started in the seeding process, so their stored results
 * are those of notes someone wrote earlier, and that process's runtime is
 * disposed before any browser opens. Every iteration then launches a fresh
 * browser, so the notes are stopped in the runtime under measurement until its
 * grid opens them.
 *
 * Requirements are those of `topic-board-navigation.bench.ts`: a toolshed at
 * `API_URL`, a shell at `FRONTEND_URL`, and a Chrome for Astral. Locally, start
 * the dev servers and run:
 *
 *     API_URL=http://localhost:8000/ FRONTEND_URL=http://localhost:5173/ \
 *       deno bench -A packages/patterns/integration/piece-grid-stopped.bench.ts
 *
 * Stdout carries the JSON report and nothing else; diagnostics go to stderr.
 */

import { debugStr } from "@commonfabric/data-model";
import { type DID, Identity } from "@commonfabric/identity";
import {
  Browser,
  createTestSpace,
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { login } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { join } from "@std/path";
import { describeThrown } from "../../integration/describe-thrown.ts";
import { initializePiecesController } from "./pieces-controller.ts";
import {
  collectBrowserLoadSummary,
  settleView,
  writeAllSync,
} from "./cfc-browser-helpers.ts";
import { readTopicsBrowserPosture } from "./topics-browser-posture.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

/**
 * Stable dashboard group used with this file and the benchmark name to identify
 * each series.
 */
const GROUP = "piece grid stopped";

/** Notes per grid: the labs#3954 workload, and a larger space. */
const SIZES = [13, 60];

/**
 * Measured iterations per benchmark, plus one unmeasured warm-up. Every
 * iteration launches a browser and renders the whole grid, so this stays small.
 */
const ITERATIONS = 3;
const WARMUP = 1;

const PATTERNS_ROOT = join(import.meta.dirname!, "..");

/** The character the interaction types into the first tile. */
const TYPED = "x";

const identity = await Identity.fromPassphrase(
  "piece grid stopped benchmark",
  { implementation: "noble" },
);

const encoder = new TextEncoder();

/**
 * Writes `message` to stderr from inside a bench body, where the JSON reporter
 * captures console output.
 */
function report(message: string): void {
  writeAllSync(
    Deno.stderr,
    encoder.encode(`[piece-grid-stopped] ${message}\n`),
  );
}

/**
 * The body note `index` is seeded with. The trailing period keeps one note's
 * body from containing another's, as `note 1` would be found in `note 13`.
 */
const noteBody = (index: number): string => `Body of stopped note ${index}.`;

/** A seeded space: the grid piece and the bodies its tiles show. */
interface GridFixture {
  spaceDid: DID;
  gridId: string;
  bodies: string[];
}

const fixtures = new Map<number, Promise<GridFixture>>();

/**
 * Seeds `count` notes and a grid listing them into a space of their own, on
 * first use, and releases the seeding runtime. Seeded lazily so a run filtered
 * to one size pays for that size alone.
 */
function fixture(count: number): Promise<GridFixture> {
  let created = fixtures.get(count);
  if (!created) {
    created = seed(count);
    fixtures.set(count, created);
  }
  return created;
}

async function seed(count: number): Promise<GridFixture> {
  const startedAt = performance.now();
  // Server execution decides whether the browser starts what it displays, so
  // the posture labels every run; a deployment that declares none is said to.
  const posture = await readTopicsBrowserPosture(env.API_URL, env.FRONTEND_URL);
  const mode = posture.declared
    ? posture.mode
    : `undeclared (${posture.reason})`;
  const spaceDid = await createTestSpace(identity);
  const cc = await initializePiecesController({
    space: spaceDid,
    apiUrl: new URL(env.API_URL),
    identity,
  });
  try {
    await cc.ensureDefaultPattern();
    const resolve = (main: string) =>
      resolveLocalProgram(
        (resolver) => cc.runtime.harness.resolve(resolver),
        { main: join(PATTERNS_ROOT, main), root: PATTERNS_ROOT },
      );
    const noteProgram = await resolve("notes/note.tsx");
    const bodies: string[] = [];
    const notes = [];
    for (let index = 0; index < count; index++) {
      const body = noteBody(index);
      bodies.push(body);
      notes.push(
        await cc.create(noteProgram, {
          start: true,
          input: { title: `Stopped note ${index}`, content: body },
        }),
      );
    }
    const grid = await cc.create(await resolve("system/piece-grid.tsx"), {
      start: true,
      input: { pieces: notes.map((note) => note.getCell()) },
    });
    await cc.runtime.idle();
    await cc.synced();
    report(
      `seeded ${count} notes and grid ${grid.id} in ${spaceDid} in ${
        Math.round(performance.now() - startedAt)
      }ms; posture ${mode}; ${ITERATIONS} iterations after ${WARMUP} ` +
        "warm-up",
    );
    return { spaceDid, gridId: grid.id, bodies };
  } finally {
    await cc.dispose();
  }
}

/** The page-side state a `cf-code-editor` exposes to these waits. */
type EditorHost = Element & {
  _editorView?: {
    state: { doc: { toString(): string } };
    focus(): void;
    contentDOM: HTMLElement;
  };
  _cellController?: { getCell(): { get(): unknown } | null };
};

/** Where the interaction's target editor is kept between page calls. */
type BenchGlobal = typeof globalThis & { __pieceGridBenchEditor?: EditorHost };

/**
 * Whether every body in `bodies` is shown by some tile's editor. In-page
 * predicate for `waitForCondition`.
 */
const everyTileShows = (probe: ProbeApi, bodies: string[]): boolean => {
  const shown = probe.collect("cf-code-editor").map((element) =>
    (element as EditorHost)._editorView?.state.doc.toString() ?? ""
  );
  return bodies.every((body) => shown.some((text) => text.includes(body)));
};

/**
 * Keeps the first tile's editor for the interaction and answers its text.
 * In-page predicate for `waitForCondition`.
 */
const holdFirstEditor = (probe: ProbeApi): string | false => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  const view = editor?._editorView;
  if (!editor || !view) return false;
  (globalThis as BenchGlobal).__pieceGridBenchEditor = editor;
  return view.state.doc.toString();
};

/**
 * Whether the held editor's text differs from `before` and its bound cell holds
 * that text, which is the edit committed. In-page predicate for
 * `waitForCondition`.
 */
const editCommitted = (_probe: ProbeApi, before: string): boolean => {
  const editor = (globalThis as BenchGlobal).__pieceGridBenchEditor;
  const text = editor?._editorView?.state.doc.toString();
  const held = editor?._cellController?.getCell()?.get();
  return text !== undefined && text !== before && held === text;
};

/** One browser, routed to a grid and not yet signed in. */
interface Session {
  browser: Browser;
  page: Page;
  pageErrors: string[];
}

async function openSession(target: GridFixture): Promise<Session> {
  const browser = await Browser.launch({ headless: true });
  // The caller closes the browser once it holds the session, so a failure
  // before that closes it here.
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.addEventListener("pageerror", (event) => {
      pageErrors.push(event.detail.message);
    });
    await page.goto(`${env.FRONTEND_URL}${target.spaceDid}/${target.gridId}`);
    await waitForPieceView(page, target.spaceDid, target.gridId);
    return { browser, page, pageErrors };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Signs in and waits until every tile shows its note's body. */
async function load(page: Page, target: GridFixture): Promise<void> {
  await login(page, identity);
  await waitForCondition(page, everyTileShows, { args: [target.bodies] });
  await settleView(page);
}

/**
 * Types into the held editor, commits by blurring, and waits for the view to
 * settle. The blur hands the edit to the editor's cell before it returns, so
 * the settle that follows is one the edit is part of.
 */
async function interact(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as BenchGlobal).__pieceGridBenchEditor!._editorView!.focus();
  });
  await page.keyboard.type(TYPED);
  await page.evaluate(() => {
    (globalThis as BenchGlobal).__pieceGridBenchEditor!._editorView!
      .contentDOM.blur();
  });
  await settleView(page);
}

/**
 * Registers one benchmark per size: a fresh browser routed to the grid, with
 * `measure` handed the page and the bench context to bracket. A failure writes
 * its elapsed time, error and main-thread diagnostics to stderr.
 */
function benchGrid(
  label: string,
  measure: (
    page: Page,
    target: GridFixture,
    b: Deno.BenchContext,
  ) => Promise<void>,
): void {
  for (const count of SIZES) {
    const name = `${label} ${count}`;
    Deno.bench(
      { name, group: GROUP, n: ITERATIONS, warmup: WARMUP },
      async (b) => {
        const target = await fixture(count);
        const session = await openSession(target);
        const startedAt = performance.now();
        try {
          await measure(session.page, target, b);
        } catch (error) {
          let diagnostics: unknown;
          try {
            diagnostics = await collectBrowserLoadSummary(session.page, name, {
              includeWorker: false,
            });
          } catch (diagnosticError) {
            diagnostics = { unavailable: describeThrown(diagnosticError) };
          }
          report(
            debugStr`failed attempt $quote,indent,long${{
              name,
              elapsedMs: performance.now() - startedAt,
              error: describeThrown(error),
              diagnostics,
            }}`,
          );
          throw error;
        } finally {
          await session.browser.close();
        }
        if (session.pageErrors.length > 0) {
          throw new Error(
            `Uncaught browser exception(s) in ${name}:\n${
              session.pageErrors.map((message) => `  ${message}`).join("\n")
            }`,
          );
        }
      },
    );
  }
}

benchGrid("load", async (page, target, b) => {
  b.start();
  await load(page, target);
  b.end();
});

benchGrid("first interaction", async (page, target, b) => {
  await load(page, target);
  const before = await waitForCondition(page, holdFirstEditor);
  if (typeof before !== "string") {
    throw new Error("The first tile's editor answered no text");
  }
  b.start();
  await interact(page);
  b.end();
  // Checked after the interval: the cell's value changes with no DOM mutation
  // to announce it, so a wait on it would pay the condition's backstop.
  await waitForCondition(page, editCommitted, { args: [before] });
});
