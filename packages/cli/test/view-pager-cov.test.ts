/**
 * Drives runPager's control flow with an injected fake PagerDeps so every
 * terminal/process branch — the no-tty error, the read loop and its EOF break,
 * leftover-byte stitching, the deferred reparse timer, the resize/interrupt/
 * terminate signal handlers, the size fallback and the cleanup error paths —
 * runs without a real terminal. A separate test exercises the real deps' thin
 * wrappers.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parseDocument } from "./view-helpers.ts";
import {
  type PagerDeps,
  type PagerTty,
  realPagerDeps,
  runPager,
} from "../lib/view/pager.ts";
import { fileSource } from "../lib/view/editsource.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { ViewError } from "../lib/view/errors.ts";
import { sgr, term } from "../lib/view/ansi.ts";
import { onGrammarLoad } from "../lib/view/languages/language.ts";
import { swiftLanguage } from "../lib/view/languages/swift/language.ts";
import { styleFor, ui } from "../lib/view/theme.ts";
import { buildView } from "../lib/view/mod.ts";

const OPTS = { color: false, showLineNumbers: false };
const DOC = parseDocument("export const x = 1;\nconst y = x;\n");
const enc = (s: string) => new TextEncoder().encode(s);

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

type Step =
  | { bytes: Uint8Array }
  | { eof: true }
  | { fire: Deno.Signal }
  | { fireTimers: true }
  | { parserLoaded: true }
  | { parserFailed: string }
  | { wait: Promise<unknown> };

interface FakeOpts {
  steps?: Step[];
  openThrows?: boolean;
  setRawThrows?: boolean;
  closeThrows?: boolean;
  consoleSizeThrows?: boolean;
  consoleSize?: { columns: number; rows: number };
  writeThrowsFrom?: number;
  addSignalThrowsFor?: Deno.Signal;
  removeSignalThrows?: boolean;
  env?: Record<string, string>;
}

function makeFake(opts: FakeOpts = {}) {
  const writes: string[] = [];
  const signals = new Map<string, () => void>();
  const removed: string[] = [];
  const timers = new Map<number, () => void>();
  const parserListeners = new Set<(failure?: string) => void>();
  // How many writes the parser listeners made, which is how a test sees that
  // a finished load drew the document again.
  const parserWrites = { count: 0 };
  const exited: number[] = [];
  const ttyState = { rawModes: [] as boolean[], closes: 0 };
  let nextTimer = 1;
  let writeCount = 0;
  const steps = (opts.steps ?? []).slice();

  const tty: PagerTty = {
    async read(buf) {
      for (;;) {
        const step = steps.shift();
        if (!step) return null;
        if ("bytes" in step) {
          buf.set(step.bytes);
          return step.bytes.length;
        }
        if ("eof" in step) return null;
        if ("wait" in step) {
          await step.wait;
          continue;
        }
        if ("fire" in step) {
          signals.get(step.fire)?.();
          continue;
        }
        if ("parserLoaded" in step) {
          const before = writes.length;
          for (const listener of parserListeners) listener();
          parserWrites.count += writes.length - before;
          continue;
        }
        if ("parserFailed" in step) {
          for (const listener of parserListeners) listener(step.parserFailed);
          continue;
        }
        const handlers = [...timers.values()];
        timers.clear();
        for (const h of handlers) h();
      }
    },
    setRaw(mode) {
      ttyState.rawModes.push(mode);
      // Throw only on the cleanup setRaw(false); the startup setRaw(true) is
      // not guarded, so a startup throw would escape.
      if (opts.setRawThrows && !mode) throw new Error("setRaw failed");
    },
    close() {
      ttyState.closes++;
      if (opts.closeThrows) throw new Error("close failed");
    },
  };

  const deps: PagerDeps = {
    openTty: () => {
      if (opts.openThrows) throw new Error("no controlling terminal");
      return tty;
    },
    write: (t) => {
      writes.push(t);
      writeCount++;
      if (
        opts.writeThrowsFrom !== undefined && writeCount >= opts.writeThrowsFrom
      ) {
        throw new Error("write failed");
      }
    },
    consoleSize: () => {
      if (opts.consoleSizeThrows) throw new Error("no console");
      return opts.consoleSize ?? { columns: 80, rows: 24 };
    },
    env: (k) => opts.env?.[k],
    addSignalListener: (s, h) => {
      if (opts.addSignalThrowsFor === s) throw new Error("unsupported");
      signals.set(s, h);
    },
    removeSignalListener: (s) => {
      if (opts.removeSignalThrows) throw new Error("remove failed");
      removed.push(s);
    },
    exit: (code) => {
      exited.push(code);
      throw new ExitSignal(code);
    },
    setTimer: (h) => {
      const id = nextTimer++;
      timers.set(id, h);
      return () => timers.delete(id);
    },
    // Resolve at once: a test drives frames with `fireTimers`, so a real wait
    // here would only stall the run.
    delay: () => Promise.resolve(),
    onGrammarLoad: (listener) => {
      parserListeners.add(listener);
      return () => parserListeners.delete(listener);
    },
  };
  return {
    deps,
    writes,
    signals,
    removed,
    timers,
    exited,
    ttyState,
    parserListeners,
    parserWrites,
  };
}

Deno.test("pager: a missing /dev/tty raises a ViewError", async () => {
  const { deps } = makeFake({ openThrows: true });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    ViewError,
    "/dev/tty",
  );
});

Deno.test("pager: draws the document and quits on q", async () => {
  const { deps, writes } = makeFake({ steps: [{ bytes: enc("q") }] });
  await runPager(DOC, OPTS, undefined, undefined, deps);
  assert(writes.length > 0, "wrote frames");
  // The alt screen is entered on start and left on cleanup.
  assert(writes.some((w) => w.includes("\x1b[?1049h")), "entered alt screen");
  assert(writes.some((w) => w.includes("\x1b[?1049l")), "left alt screen");
  assert(writes.some((w) => w.includes(term.enableMouse)), "enabled the mouse");
  assert(
    writes.some((w) => w.includes(term.disableMouse)),
    "disabled the mouse",
  );
});

Deno.test("pager: restores the terminal when the initial write fails", async () => {
  const { deps, ttyState } = makeFake({ writeThrowsFrom: 1 });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    Error,
    "write failed",
  );
  assertEquals(ttyState.rawModes, [true, false]);
  assertEquals(ttyState.closes, 1);
});

Deno.test("pager: an SGR mouse-wheel report scrolls the document", async () => {
  const doc = parseDocument(
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
  );
  const { deps, writes } = makeFake({
    consoleSize: { columns: 30, rows: 6 },
    steps: [
      { bytes: enc("\x1b[<65;1;1M") },
      { bytes: enc("q") },
    ],
  });
  await runPager(doc, OPTS, undefined, undefined, deps);
  const frames = writes.filter((write) => write.includes("\x1b[?7l"));
  const wheelFrame = frames.at(-1)!;
  assert(wheelFrame.includes("line 3"), "the wheel frame contains line 3");
  for (const skippedLine of ["line 0", "line 1", "line 2"]) {
    assert(
      !wheelFrame.includes(skippedLine),
      `the wheel frame starts after ${skippedLine}`,
    );
  }
});

Deno.test("pager: unknown named files schedule no semantic work", async () => {
  const view = buildView("const incomplete = `plain\n", "LICENSE");
  const semantics = view.semantics();
  assertEquals(semantics, undefined);
  const { deps, timers } = makeFake({ steps: [{ bytes: enc("q") }] });
  await runPager(view.doc, OPTS, semantics, view.editSource, deps);
  assertEquals(timers.size, 0);
});

Deno.test("pager: with color, matches the terminal background to the status bar and restores it", async () => {
  // A redraw (the 'j' scroll) in its own read precedes the quit, so the frame is
  // drawn again inside the loop.
  const { deps, writes } = makeFake({
    steps: [{ bytes: enc("j") }, { bytes: enc("q") }],
  });
  await runPager(
    DOC,
    { color: true, showLineNumbers: false },
    undefined,
    undefined,
    deps,
  );
  const all = writes.join("");
  const set = term.setDefaultBg(ui.statusBar.bg!);
  // OSC 11 sets the terminal default background to the status bar color, and it
  // is re-asserted on every frame so a terminal that drops it cannot leave a
  // strip in its own color; OSC 111 restores it on exit.
  assert(all.includes(set), "set the default background");
  assert(all.split(set).length - 1 >= 2, "re-asserted on redraw");
  assert(all.includes("\x1b]111\x07"), "restored the default background");
});

Deno.test("pager: a closed terminal (EOF) ends the loop", async () => {
  const { deps } = makeFake({ steps: [{ eof: true }] });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: a keystroke split across reads is stitched back together", async () => {
  // 'λ' is CE BB; the lead byte arrives alone, so it is held over and joined
  // with the continuation byte on the next read (exercising concat).
  const { deps } = makeFake({
    steps: [
      { bytes: new Uint8Array([0xce]) },
      { bytes: new Uint8Array([0xbb]) },
      { bytes: enc("q") },
    ],
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: SIGWINCH resizes the session and redraws", async () => {
  const { deps } = makeFake({
    steps: [{ fire: "SIGWINCH" }, { bytes: enc("q") }],
    consoleSize: { columns: 100, rows: 40 },
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: SIGINT on a clean buffer terminates with code 130", async () => {
  const { deps, exited } = makeFake({ steps: [{ fire: "SIGINT" }] });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    ExitSignal,
  );
  assertEquals(exited, [130]);
});

Deno.test("pager: SIGTERM terminates with code 143", async () => {
  const { deps, exited } = makeFake({ steps: [{ fire: "SIGTERM" }] });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    ExitSignal,
  );
  assertEquals(exited, [143]);
});

Deno.test("pager: SIGWINCH that the platform rejects is ignored", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    addSignalThrowsFor: "SIGWINCH",
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: cleanup tolerates setRaw and close failing", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    setRawThrows: true,
    closeThrows: true,
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: removeSignalListener failing during cleanup is ignored", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    removeSignalThrows: true,
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: the size falls back to the environment when consoleSize throws", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    consoleSizeThrows: true,
    env: { COLUMNS: "120", LINES: "50" },
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: the size falls back to 80x24 when neither console nor env give one", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    consoleSizeThrows: true,
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

function editableDoc(): {
  doc: typeof DOC;
  source: ReturnType<typeof fileSource>;
  dir: string;

  /** How many times the source has been re-parsed — the deferred reparse calls
   * `source.parse`, so this stays 0 unless an edit actually scheduled and ran
   * one. */
  parses: () => number;
} {
  const dir = Deno.makeTempDirSync();
  const path = join(dir, "m.ts");
  const text = "export const a = 1;\nconst b = a;\n";
  Deno.writeTextFileSync(path, text);
  const base = fileSource(path);
  let parses = 0;
  const source = {
    ...base,
    parse: (t: string) => {
      parses++;
      return base.parse(t);
    },
  };
  return { doc: parseDocument(text, path), source, dir, parses: () => parses };
}

Deno.test("pager: an edit schedules the deferred reparse, which then runs", async () => {
  const { doc, source, dir, parses } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // e: enter edit mode
        { bytes: enc("X") }, // type — marks needsReparse, schedules the timer
        { fireTimers: true }, // the debounce fires: reparse + redraw
        { eof: true },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const out = writes.join("");
    // If e no longer entered edit mode, X would be an inert pager key: no edit
    // hint, no inserted character, and no reparse.
    assert(out.includes("Esc Done"), "e entered edit mode (edit hints shown)");
    assert(out.includes("Xexport"), "the typed X was inserted at the top");
    assertEquals(parses(), 1, "the deferred reparse re-parsed the edited text");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a parser that finishes loading re-parses and redraws the document", async () => {
  const { doc, source, dir, parses } = editableDoc();
  try {
    const { deps, parserListeners, parserWrites } = makeFake({
      steps: [{ parserLoaded: true }, { eof: true }],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    assertEquals(parses(), 1, "the loaded parser re-parsed the document");
    assert(parserWrites.count > 0, "the document was drawn again");
    assertEquals(parserListeners.size, 0, "the pager stopped listening");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a Swift file parsed before its parser loads is colored once it loads", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const path = join(dir, "main.swift");
    const text = "func greet() {}\n";
    Deno.writeTextFileSync(path, text);
    const source = fileSource(path);
    // Nothing in this file loads the Swift parser first, so this parse is the
    // first use: it shows plain text and starts the load.
    const doc = source.parse(text);
    assertEquals(doc.structure, []);
    const { deps, writes } = makeFake({
      steps: [{ wait: swiftLanguage.prepare!() }, { eof: true }],
    });
    deps.onGrammarLoad = onGrammarLoad;

    await runPager(
      doc,
      { color: true, showLineNumbers: false },
      undefined,
      source,
      deps,
    );

    // The frame merges the editor background into the keyword's sequence.
    const keyword = sgr(styleFor("storageKeyword")).slice(0, -1);
    const colored = new RegExp(`${keyword.replace("[", "\\[")}[;0-9]*mfunc`);
    const frames = writes.filter((frame) => frame.includes("greet"));
    assertEquals(colored.test(frames[0]), false, "the first frame is plain");
    assert(
      frames.some((frame) => colored.test(frame)),
      "a frame drawn after the load colors the declaring keyword",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a parser that cannot load says why and leaves the document as it was", async () => {
  const { doc, source, dir, parses } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { parserFailed: "cf view: the swift grammar could not be read." },
        { eof: true },
      ],
      // Wide enough for the status line to hold the whole reason.
      consoleSize: { columns: 200, rows: 24 },
    });
    await runPager(doc, OPTS, undefined, source, deps);
    assertEquals(parses(), 0, "nothing was parsed again");
    assert(
      writes.join("").includes(
        "cf view: the swift grammar could not be read. Its files are shown as plain text.",
      ),
      "the reason is in the status line",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a second edit reschedules the reparse; a pending timer is cleared on exit", async () => {
  const { doc, source, dir, parses } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // e: enter edit mode
        { bytes: enc("X") }, // schedules timer 1
        { bytes: enc("Y") }, // reschedules: clears timer 1, schedules timer 2
        { eof: true }, // exit with timer 2 still pending -> cleared in finally
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const out = writes.join("");
    // Both edits must have landed for there to be a reparse to reschedule.
    assert(out.includes("Esc Done"), "e entered edit mode");
    assert(out.includes("XYexport"), "both typed edits were inserted");
    // The pending reparse timer was cleared on exit before it could fire.
    assertEquals(parses(), 0, "the rescheduled reparse never ran");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a SIGINT with unsaved edits routes through the save prompt", async () => {
  const { doc, source, dir } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // enter edit mode
        { bytes: enc("X") }, // an unsaved edit
        { fire: "SIGINT" }, // requestQuitFromSignal is true -> redraw, no exit
        { eof: true },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    // The dirty buffer is what makes the SIGINT redraw the save prompt instead
    // of exiting; without the edit landing, the prompt would never appear.
    assert(
      writes.join("").includes("Save changes to"),
      "the SIGINT raised the save-prompt dialog over the dirty buffer",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("realPagerDeps: the wrappers reach the real primitives", () => {
  const d = realPagerDeps();
  d.write(""); // writes nothing to stdout
  d.env("PATH");
  d.env("CF_VIEW_DEFINITELY_UNSET");
  const cancel = d.setTimer(() => {}, 0);
  cancel();
  d.onGrammarLoad(() => {})();
  // Opening the controlling terminal either succeeds (close it) or throws when
  // the test has none; both reach the wrapper.
  try {
    d.openTty().close();
  } catch { /* no controlling terminal in this environment */ }
});

//
// Ctrl-L reveal frames
//

/** A one-file diff whose hunk has room to reveal ten lines above it. */
function revealFixture() {
  const root = Deno.makeTempDirSync();
  const lines = Array.from(
    { length: 60 },
    (_, i) => `L${String(i + 1).padStart(2, "0")}`,
  );
  Deno.writeTextFileSync(join(root, "a.ts"), `${lines.join("\n")}\n`);
  const diff = `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -25,20 +25,20 @@
${lines.slice(24, 33).map((l) => ` ${l}`).join("\n")}
-old L34
+L34
${lines.slice(34, 44).map((l) => ` ${l}`).join("\n")}
`;
  const ws: DiffWorkspace = {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  return {
    doc,
    source: diffSource(ws, edit),
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

Deno.test("pager: Ctrl-L walks the revealed lines in a frame at a time", async () => {
  const { doc, source, done } = revealFixture();
  try {
    const { deps, writes } = makeFake({
      consoleSize: { columns: 80, rows: 13 },
      steps: [
        { bytes: enc("\x0c") }, // Ctrl-L: reveals L15..L24 above the hunk
        { fireTimers: true }, // one line has landed
        { fireTimers: true }, // two
        { bytes: enc("q") },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    // The line meeting the hunk lands first, and it lands on its own: the frame
    // holding it does not already hold the furthest line.
    const first = writes.findIndex((w) => w.includes("L24"));
    assert(first > 0, "a frame drew the first revealed line");
    assert(!writes[first].includes("L15"), "the furthest line had not landed");
    const second = writes.findIndex((w) => w.includes("L23"));
    assert(second > first, "the next frame drew the next line");
  } finally {
    done();
  }
});

Deno.test("pager: Ctrl-L draws no frames of its own accord", async () => {
  const { doc, source, done } = revealFixture();
  try {
    const { deps, writes } = makeFake({
      consoleSize: { columns: 80, rows: 13 },
      steps: [{ bytes: enc("\x0c") }, { eof: true }],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    // Without the timers running there are no frames, so the finished reveal
    // never reaches the screen: the walk is what draws, not the keystroke.
    assert(!writes.some((w) => w.includes("L15")), "nothing was drawn");
  } finally {
    done();
  }
});

Deno.test("pager: a key during the reveal drops the frames left", async () => {
  const { doc, source, done } = revealFixture();
  try {
    const { deps, writes } = makeFake({
      consoleSize: { columns: 80, rows: 13 },
      steps: [
        { bytes: enc("\x0c") },
        { fireTimers: true }, // one line in
        { bytes: enc("j") }, // impatient: ends the walk
        { fireTimers: true }, // the frames left are gone, so this draws nothing
        { bytes: enc("q") },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const frames = writes.filter((w) => w.includes("@@"));
    // The opening picture, the one frame that ran, and the finish the key drew.
    assertEquals(frames.length, 3);
    assert(frames.at(-1)!.includes("L15"), "the finish is on screen");
  } finally {
    done();
  }
});

/** A diff whose only hunk runs to the last line of its file, so its bottom edge
 * has nowhere to go. */
function atBottomFixture() {
  const root = Deno.makeTempDirSync();
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  Deno.writeTextFileSync(join(root, "a.ts"), `${lines.join("\n")}\n`);
  const diff = `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -18,3 +18,3 @@
 line18
-OLD19
+line19
 line20
`;
  const ws: DiffWorkspace = {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  return {
    doc,
    source: diffSource(ws, edit),
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

Deno.test("pager: the reason Ctrl-L did nothing stands, then takes itself away", async () => {
  const { doc, source, done } = atBottomFixture();
  try {
    const { deps, writes } = makeFake({
      // Short enough that the end of the document shows the hunk's bottom edge
      // and not its top, so the bottom is the only edge to aim at.
      consoleSize: { columns: 80, rows: 6 },
      steps: [
        { bytes: enc("G") },
        { bytes: enc("\x0c") }, // Ctrl-L, which the bar does not offer here
        { fireTimers: true }, // its moment is up
        { bytes: enc("q") },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const said = writes.findIndex((w) => w.includes("Bottom of file"));
    assert(said >= 0, "the reason was drawn");
    // And a later frame is drawn without it, so it does not sit in the bar
    // describing a keypress the user has moved on from.
    const gone = writes.slice(said + 1).some((w) =>
      w.includes("line20") && !w.includes("Bottom of file")
    );
    assert(gone, "the reason was taken away again");
  } finally {
    done();
  }
});

Deno.test("pager: the reason stays up until its moment is up", async () => {
  const { doc, source, done } = atBottomFixture();
  try {
    const { deps, writes } = makeFake({
      consoleSize: { columns: 80, rows: 6 },
      // No timers fire, so nothing takes the message away.
      steps: [{ bytes: enc("G") }, { bytes: enc("\x0c") }, { eof: true }],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const last = writes.filter((w) => w.includes("line20")).at(-1)!;
    assert(last.includes("Bottom of file"), "still up when nothing has fired");
  } finally {
    done();
  }
});

Deno.test("pager: what a reveal says takes itself away once the lines have landed", async () => {
  const { doc, source, done } = revealFixture();
  try {
    const { deps, writes } = makeFake({
      consoleSize: { columns: 80, rows: 13 },
      steps: [
        { bytes: enc("\x0c") }, // Ctrl-L: ten lines to walk in
        // Nine frames walk them in; the tenth draws the finish and starts the
        // clock, so the message stands from when the lines stop moving.
        ...Array.from({ length: 10 }, () => ({ fireTimers: true as const })),
        { fireTimers: true }, // the clock runs out
        { bytes: enc("q") },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const said = writes.findIndex((w) => w.includes("Showing lines"));
    assert(said >= 0, "the reveal said what it showed");
    const gone = writes.slice(said + 1).some((w) =>
      w.includes("@@") && !w.includes("Showing lines")
    );
    assert(gone, "and it was taken away again");
  } finally {
    done();
  }
});

Deno.test("pager: a prompt button's result waits for the press animation to finish", async () => {
  // Open the revert prompt, then Esc to activate its Cancel button. The press
  // is drawn at once; its result ("Cancelled") is what the push timer draws, so
  // without the timer firing the result never reaches the screen.
  const run = (steps: Step[]) => {
    const { doc, source, dir } = editableDoc();
    const { deps, writes } = makeFake({ steps });
    return runPager(doc, OPTS, undefined, source, deps).then(() => {
      Deno.removeSync(dir, { recursive: true });
      return writes;
    });
  };
  const openRevert: Step[] = [
    { bytes: enc("e") }, // edit mode
    { bytes: enc("X") }, // dirty the buffer
    { bytes: enc("\x12") }, // Ctrl-R: open the revert prompt
    { bytes: enc("\x1b") }, // Esc: activate Cancel — paints the pressed frame
  ];

  const held = await run([...openRevert, { eof: true }]);
  assert(
    held.some((w) => w.includes("Revert all edits?")),
    "the prompt (and its pressed frame) was drawn",
  );
  assert(
    !held.some((w) => w.includes("Cancelled")),
    "the result waited for the press timer, so it never drew",
  );

  const partial = await run([
    ...openRevert,
    { bytes: new Uint8Array([0xce]) }, // first byte of a split UTF-8 key
    { eof: true },
  ]);
  assert(
    !partial.some((w) => w.includes("Cancelled")),
    "an incomplete next key kept the pressed frame on screen",
  );

  const fired = await run([...openRevert, { fireTimers: true }, { eof: true }]);
  assert(
    fired.some((w) => w.includes("Cancelled")),
    "the press timer drew the result",
  );
});

Deno.test("pager: paints a pressed button before its synchronous action starts", async () => {
  const { doc, source: base, dir } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") },
        { bytes: enc("X") },
        { bytes: enc("\x18") }, // Ctrl-X
        { bytes: enc("\x13") }, // Ctrl-S: open the amend prompt
        { bytes: enc("a") }, // Amend commit
        { eof: true },
      ],
    });
    let promptFramesWhenSaveStarted = -1;
    let pressedFrameWasDistinct = false;
    const source = {
      ...base,
      pendingAmend: () => ({
        sha: "0123456789abcdef0123456789abcdef01234567",
        subject: "A commit subject",
      }),
      save: (
        text: string,
        lineEndings: Parameters<typeof base.save>[1],
        baseline?: string,
        options?: Parameters<typeof base.save>[3],
      ) => {
        const promptFrames = writes.filter((write) =>
          write.includes("Amend commit 012345678")
        );
        promptFramesWhenSaveStarted = promptFrames.length;
        pressedFrameWasDistinct = promptFrames[0] !== promptFrames[1];
        return base.save(text, lineEndings, baseline, options);
      },
    };

    await runPager(doc, OPTS, undefined, source, deps);

    assertEquals(
      promptFramesWhenSaveStarted,
      2,
      "the ordinary prompt frame and its pressed frame were written before save",
    );
    assert(
      pressedFrameWasDistinct,
      "the second frame visibly pressed the button",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a committing button plays its press before the pager quits", async () => {
  const { doc, source, dir } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // edit mode
        { bytes: enc("X") }, // dirty the buffer
        { bytes: enc("\x03") }, // Ctrl-C: raise the save-and-quit prompt
        { bytes: enc("d") }, // Discard: quits, but plays its press first
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    // The save dialog is drawn once as it opens and once more as the pressed
    // frame the Discard key paints on its way out. Without the press animation
    // the quit would tear the screen down after the single opening frame.
    const dialogFrames = writes.filter((w) => w.includes("Save changes to"));
    assertEquals(dialogFrames.length, 2, "the press was drawn before quitting");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a resize does not strand the reason Ctrl-L put up", async () => {
  const { doc, source, done } = atBottomFixture();
  try {
    const { deps, writes } = makeFake({
      consoleSize: { columns: 80, rows: 6 },
      steps: [
        { bytes: enc("G") },
        { bytes: enc("\x0c") }, // Ctrl-L: "Bottom of file."
        { fire: "SIGWINCH" }, // a resize redraws and would cancel the clock
        { fireTimers: true }, // the clock the resize restarted runs out
        { bytes: enc("q") },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    // Without restarting expiry after the resize, the message would sit in the
    // bar for good; here a later frame is drawn without it.
    const said = writes.findIndex((w) => w.includes("Bottom of file"));
    assert(said >= 0, "the reason was drawn");
    const last = writes.filter((w) => w.includes("line20")).at(-1)!;
    assert(
      !last.includes("Bottom of file"),
      "the resize left the reason free to expire",
    );
  } finally {
    done();
  }
});
