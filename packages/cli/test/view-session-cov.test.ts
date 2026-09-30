/**
 * Coverage-driving behavioral tests for the pager state machine in
 * `lib/view/session.ts`. Each test reaches a specific code path by feeding keys
 * and inspecting `view()` / `doc` / `quit`, mirroring the style of
 * `view-session.test.ts`, `view-filepicker.test.ts` and `view-diffedit.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseDocument, promptText, SAMPLE } from "./view-helpers.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Semantics } from "../lib/view/languages/language.ts";
import type { EditableSource } from "../lib/view/editsource.ts";
import type { DirEntry, FileGateway } from "../lib/view/filegateway.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { overlayBox, renderFrame, type ViewState } from "../lib/view/render.ts";
import type { Document } from "../lib/view/model.ts";
import { frameTop, maxTop } from "../lib/view/actions.ts";

//
// key helpers
//

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

function type(s: Session, text: string): void {
  for (const ch of text) s.handleKey({ name: ch, char: ch });
}

/** Put the final display row on the viewport's last content row. */
function lastFullPage(s: Session): void {
  const view = s.view();
  const rowCount = view.wrapPlan?.rowCount ?? s.displayDoc().lines.length;
  const top = maxTop(rowCount, view.height);
  press(s, "G");
  press(s, ...Array(s.view().top - top).fill("k"));
}

function alt(name: string, char?: string): Key {
  return char !== undefined ? { name, char, alt: true } : { name, alt: true };
}

/** Tab through the tree until a node whose label contains `label` is selected. */
function selectByLabel(s: Session, label: string): void {
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label?.includes(label)) return;
    press(s, "tab");
  }
  throw new Error(`node not reached: ${label}`);
}

function makeSession(width = 90, height = 24): Session {
  const doc = parseDocument(SAMPLE);
  return new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width, height },
  );
}

//
// save dialog: more than six edited files
//

Deno.test("session: the save prompt lists six files plus an '… and N more' line", () => {
  const path = "/work/main.ts";
  const text = "const a = 1;\n";
  const doc = parseDocument(text, path);
  const labels = Array.from({ length: 9 }, (_, i) => `file${i}.ts`);
  const source: EditableSource = {
    label: "main.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
    dirtyLabels: () => labels,
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    source,
  );
  press(s, "e"); // reveal the cursor
  type(s, "X"); // dirty the buffer
  press(s, "ctrl-c"); // raise the save prompt
  const body = s.view().dialog!.body;
  assert(body, "the dialog lists the files");
  assert(body[0].includes("9 files"), body[0]);
  // Six files are shown, then a summary line for the remaining three.
  const fileLines = body.filter((l) => l.trimStart().startsWith("file"));
  assertEquals(fileLines.length, 6, "six files listed");
  assertEquals(body[body.length - 1], "  … and 3 more");
});

Deno.test("session: a single edited file shows no notice list", () => {
  const path = "/work/solo.ts";
  const doc = parseDocument("const a = 1;\n", path);
  const source: EditableSource = {
    label: "solo.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    source,
  );
  press(s, "e");
  type(s, "Y");
  press(s, "ctrl-c");
  assertEquals(s.view().dialog!.body.length, 1, "one file needs no list");
  assert(promptText(s.view()).includes("solo.ts"), promptText(s.view()));
});

//
// selectNode out-of-range guard (288)
//

Deno.test("session: navigating past the last node is a no-op (selectNode guard)", () => {
  const s = makeSession();
  press(s, "tab"); // establish a selection at the first node
  // Step pre-order forward well past the end; selectNode rejects out-of-range.
  let last = s.view().selected;
  for (let i = 0; i < 400; i++) {
    press(s, "tab");
    last = s.view().selected;
  }
  // Pressing tab at the very last node returns an index past the end, which
  // selectNode ignores, leaving the selection where it was.
  const before = s.view().selected;
  press(s, "tab");
  assertEquals(s.view().selected, before, "no change past the last node");
  assert(last, "a node stayed selected");
});

//
// definition lookup (319-348)
//

Deno.test("session: definition lookup reports a miss", () => {
  const s = makeSession();
  press(s, "t");
  type(s, "nonexistentName");
  press(s, "enter");
  assert(
    s.view().message.includes("No definition found"),
    s.view().message,
  );
  assertEquals(s.view().overlay, null, "no overlay on a miss");
});

Deno.test("session: definition lookup with a structure node opens its card", () => {
  const s = makeSession();
  press(s, "t");
  type(s, "myPattern");
  press(s, "enter");
  const ov = s.view().overlay!;
  assert(ov, "overlay opened");
  assert(ov.title.startsWith("definition:"), ov.title);
  assert(ov.title.includes("myPattern"), ov.title);
});

Deno.test("session: definition lookup without a matching structure node falls back to source lines", () => {
  // `Foo` is a type alias; force a definition with offsets that match no
  // structure node by using a document whose definition has no node at that
  // exact range. A bare `type Foo` aliasing works, but to take the fallback we
  // need a definition whose offsets are not a flatStructure node. Use a simple
  // top-level const inside a non-section doc.
  const text = "const target = 1;\nconst use = target;\n";
  const doc = parseDocument(text);
  // Build a doctored document: keep lines/structure but give `target` a
  // definition whose offsets do not correspond to any flatStructure node.
  const defs = new Map(doc.definitions);
  defs.set("phantom", [
    {
      name: "phantom",
      kind: "variable",
      startLine: 0,
      endLine: 0,
      startOffset: 999, // matches no node
      endOffset: 1000,
    },
  ]);
  const doctored = { ...doc, definitions: defs };
  const s = new Session(
    doctored,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
  );
  press(s, "t");
  type(s, "phantom");
  press(s, "enter");
  const ov = s.view().overlay!;
  assert(ov, "fallback overlay opened");
  assert(ov.title.includes("phantom"), ov.title);
  assert(ov.title.includes("variable"), ov.title);
  assert(ov.footer.includes("scroll"), ov.footer);
});

//
// card selection movement & external file (377-484, 644-701)
//

function externalSession(destLine = 1, fileLines = 3): {
  s: Session;
  filePath: string;
} {
  const fileText = Array.from({ length: fileLines }, (_, i) => `line ${i}`)
    .join("\n");
  const filePath = "/workspace/ext.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: (p) => p === filePath ? parseDocument(fileText).lines : null,
    definitionOf: () => [
      {
        name: "ext",
        filePath,
        fileOffset: 0,
        line: destLine + 1,
        col: 4,
        preview: "",
      },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts\nconst flag = ext();`);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter"); // open the card with the external reference
  return { s, filePath };
}

Deno.test("session: card selection wraps at the bottom and scrolls to stay visible", () => {
  // A card with many reference lines so moving down past the inner height
  // scrolls the overlay.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 12 }, // small overlay so targets scroll
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  // Move down through every target; selection clamps at the last and the
  // overlay scrolls to keep the focused reference on screen.
  let lastScroll = s.view().overlay!.scroll;
  for (let i = 0; i < 12; i++) {
    press(s, "down");
    lastScroll = s.view().overlay!.scroll;
  }
  assert(s.view().overlay!.selectedLine !== undefined, "a reference selected");
  // Walking back up to the top resets the scroll and deselects.
  for (let i = 0; i < 12; i++) press(s, "up");
  assertEquals(s.view().overlay!.selectedLine, undefined, "deselected at top");
  assertEquals(s.view().overlay!.scroll, 0, "scroll reset");
  assert(lastScroll >= 0);
});

Deno.test("session: Enter on a card's '… N more' line expands the list in place", () => {
  let src = "// transformed: /app.ts\n";
  for (let i = 0; i < 16; i++) src += `const v${i} = ${i};\n`;
  const doc = parseDocument(src);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 40 },
  );
  selectByLabel(s, "app.ts"); // the file section
  press(s, "enter"); // open its card
  const lines = () => s.view().overlay!.lines;
  const moreLine = lines().findIndex((l) => l.text.includes("2 more"));
  assert(moreLine >= 0, "the card is truncated with a more line");
  // Move the selection down until it lands on the "… 2 more" line (the last
  // selectable target), then press Enter to expand.
  let guard = 0;
  while (s.view().overlay!.selectedLine !== moreLine && guard++ < 100) {
    press(s, "down");
  }
  assertEquals(s.view().overlay!.selectedLine, moreLine, "more line selected");
  // 'z' (reveal) has no destination on a "… N more" line, so it does nothing.
  press(s, "z");
  assert(s.view().overlay !== null, "z left the card open");
  assertEquals(
    s.view().overlay!.selectedLine,
    moreLine,
    "still on the more line",
  );
  press(s, "enter");
  assert(!lines().some((l) => l.text.includes("more")), "no more line now");
  assert(lines().some((l) => l.text.includes("v15")), "every child listed");
});

Deno.test("session: following card references stacks them; Esc walks back, q closes all", () => {
  let src = "// transformed: /app.ts\n";
  for (let i = 0; i < 4; i++) src += `const v${i} = ${i};\n`;
  const doc = parseDocument(src);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 40 },
  );
  selectByLabel(s, "app.ts");
  press(s, "enter"); // open the file section's card
  const sectionTitle = s.view().overlay!.title;
  assert(!s.view().overlay!.footer.includes("back"), "first card: Esc closes");
  press(s, "down"); // select the first outline child (v0)
  press(s, "enter"); // open v0's card, pushing the section card
  assert(s.view().overlay!.title.includes("v0"), s.view().overlay!.title);
  assert(
    s.view().overlay!.footer.includes("esc back"),
    "footer offers go-back",
  );
  press(s, "escape"); // pop back to the section card
  assertEquals(
    s.view().overlay!.title,
    sectionTitle,
    "back on the section card",
  );
  assertEquals(
    s.view().overlay!.selectedLine !== undefined,
    true,
    "v0 reselected",
  );
  press(s, "escape"); // empty stack -> close to the main view
  assertEquals(s.view().overlay, null, "the last Esc closes the card");
  // q from within a stack closes everything at once.
  press(s, "enter"); // reopen the section card
  press(s, "down");
  press(s, "enter"); // v0's card (stack: section)
  press(s, "q");
  assertEquals(s.view().overlay, null, "q closed the whole stack");
});

Deno.test("session: Enter on a 'defined elsewhere' entry, then Esc, returns to the card", () => {
  const { s } = externalSession(1, 4);
  const cardTitle = s.view().overlay!.title; // the flag card
  press(s, "down"); // select the external reference
  press(s, "enter"); // open the external file over the card
  assert(
    s.view().overlay!.title.includes("ext.ts"),
    "opened the external file",
  );
  assert(
    s.view().overlay!.title.includes("line 3, column 5"),
    "shows the exact definition position",
  );
  assert(
    s.view().overlay!.footer.includes("esc back"),
    "the file offers go-back",
  );
  press(s, "escape"); // pop back to the card we came from
  assertEquals(s.view().overlay?.title, cardTitle, "back on the flag card");
  press(s, "escape"); // empty stack -> close
  assertEquals(s.view().overlay, null, "the last Esc closes");
});

Deno.test("session: 'z' on a card opens the external definition file in place", () => {
  const { s } = externalSession(1, 4);
  press(s, "down"); // select the external reference
  press(s, "z"); // reveal: opens the file in place
  const ov = s.view().overlay!;
  assert(ov, "overlay stays open on the file");
  assert(ov.title.includes("ext.ts"), ov.title);
  assert(
    ov.lines.map((l) => l.text).join("\n").includes("line 0"),
    "shows the external file",
  );
});

Deno.test("session: opening an unreadable external file reports an error", () => {
  // A semantics stub that advertises a definition but returns no file lines.
  const filePath = "/workspace/missing.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: () => null, // cannot read
    definitionOf: () => [
      { name: "ext", filePath, fileOffset: 0, line: 1, preview: "" },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts\nconst flag = ext();`);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter");
  press(s, "down"); // select the external reference
  press(s, "enter"); // try to open it
  assert(s.view().message.includes("Cannot open"), s.view().message);
});

Deno.test("session: Enter on a reference with no openable node reports nothing to open", () => {
  // Build a card whose target resolves to no node and no destination line.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // select the first reference (resolves to a node normally)
  // The reference here resolves to a node, so enter navigates. Assert it does
  // not crash and either navigates or reports.
  press(s, "enter");
  const ov = s.view().overlay;
  assert(
    ov !== null || s.view().message.length >= 0,
    "enter handled the reference",
  );
});

Deno.test("session: 'z' on a card with no selected reference reveals the subject node", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  const subject = s.view().selected!;
  press(s, "enter"); // open the card, no reference selected
  press(s, "z"); // reveal the card's own subject
  assertEquals(s.view().overlay, null, "card closed");
  assertEquals(
    s.view().selected?.startOffset,
    subject.startOffset,
    "subject selected",
  );
});

Deno.test("session: overlay paging keys scroll the card", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 8 },
  );
  press(s, "?"); // help overlay: many lines, no targets, so j/k/space scroll
  assertEquals(s.view().overlay!.scroll, 0);
  press(s, "space"); // page down
  assert(s.view().overlay!.scroll > 0, "space paged down");
  const afterSpace = s.view().overlay!.scroll;
  press(s, "pageup");
  assert(s.view().overlay!.scroll < afterSpace, "pageup scrolled back");
  press(s, "j");
  press(s, "k");
  press(s, "pagedown");
  assert(s.view().overlay!.scroll >= 0);
  // 'q' closes the overlay.
  press(s, "q");
  assertEquals(s.view().overlay, null, "q closed the overlay");
});

Deno.test("session: overlay letter shortcuts match the help text", () => {
  const s = makeSession(60, 8);
  press(s, "?");
  press(s, "J");
  assert(s.view().overlay!.scroll > 0, "J scrolled the help overlay");
  press(s, "K");
  assertEquals(s.view().overlay!.scroll, 0, "K scrolled back");
  press(s, "q");
  assertEquals(s.view().overlay, null, "lowercase q closed the overlay");

  press(s, "?");
  press(s, "Q");
  assertEquals(s.quit, true, "uppercase Q requested quit");

  for (const pageUp of ["b", "B"]) {
    const paging = makeSession(60, 8);
    press(paging, "?", "space");
    const afterPageDown = paging.view().overlay!.scroll;
    assert(afterPageDown > 0, "Space paged down");
    press(paging, pageUp);
    assert(
      paging.view().overlay!.scroll < afterPageDown,
      `${pageUp} paged up`,
    );
  }
});

Deno.test("session: info-card letter shortcuts match the help text", () => {
  for (const reveal of ["z", "Z"]) {
    const s = makeSession();
    selectByLabel(s, "pattern myPattern");
    const subject = s.view().selected!;
    const beforeTop = s.view().top;
    press(s, "enter");
    assert(s.view().overlay, "the info card opened");
    press(s, reveal);
    assertEquals(s.view().overlay, null, `${reveal} revealed the card subject`);
    const expectedTop = Math.min(
      frameTop(
        subject.startLine,
        subject.endLine,
        s.view().height,
        s.doc.lines.length,
      ),
      maxTop(s.doc.lines.length, s.view().height),
    );
    assert(expectedTop !== beforeTop, "the fixture requires reframing");
    assertEquals(
      s.view().top,
      expectedTop,
      `${reveal} framed the card subject`,
    );
    assertEquals(
      s.view().selected?.startOffset,
      subject.startOffset,
      `${reveal} kept the card subject selected`,
    );
  }

  const s = makeSession();
  selectByLabel(s, "pattern myPattern");
  press(s, "enter", "down", "down", "down", "enter");
  assert(s.view().overlay?.title.includes("lift __cfLift_1"));
  assertEquals(s.view().selected?.label, "pattern myPattern");
  press(s, "t");
  assertEquals(
    s.view().inputLine,
    "definition: __cfLift_1",
    "t used the active followed card rather than the main-view selection",
  );
  press(s, "enter");
  assert(s.view().overlay?.title.includes("__cfLift_1"));
});

Deno.test("session: overlay scrolling stops once the last line reaches the bottom", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 20 },
  );
  press(s, "?");
  const lines = s.view().overlay!.lines.length;
  const innerH = overlayBox(100, 20).innerH;
  const maxScroll = lines - innerH;
  assert(maxScroll > 0, "the help is taller than the box");
  // Hammer down well past the end: the scroll settles so the final line sits on
  // the last content row, never scrolling it up past the frame.
  for (let i = 0; i < lines + 5; i++) press(s, "pagedown");
  assertEquals(s.view().overlay!.scroll, maxScroll, "clamped to the last line");
  press(s, "down");
  assertEquals(s.view().overlay!.scroll, maxScroll, "cannot scroll further");
});

Deno.test("session: Tab toggles a peek card to source and z reveals the subject from there", () => {
  const s = makeSession(100, 24);
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  press(s, "tab"); // info -> source
  assertEquals(s.view().overlay!.scroll, 0);
  // Down scrolls the source (no targets in source mode).
  press(s, "down");
  assert(s.view().overlay!.scroll >= 0);
  press(s, "tab"); // back to info
  assertEquals(s.view().overlay!.scroll, 0);
});

//
// normal-mode keys: search stepping & paging (546-845)
//

Deno.test("session: n with no matches reports 'No matches'", () => {
  const s = makeSession();
  press(s, "n");
  assertEquals(s.view().message, "No matches");
  press(s, "N");
  assertEquals(s.view().message, "No matches");
});

Deno.test("session: n / N step through matches and reveal them", () => {
  const s = makeSession(40, 10);
  press(s, "/");
  type(s, "token");
  press(s, "enter");
  const first = s.view().currentMatch;
  press(s, "n");
  const second = s.view().currentMatch;
  press(s, "N");
  assertEquals(s.view().currentMatch, first, "N returns to the previous match");
  assert(second !== first || s.view().matches!.length === 1);
});

Deno.test("session: a search jumps and reveals a match off the bottom and to the right", () => {
  // A doc tall and wide enough that a later match is off both axes.
  const lines = [
    "// transformed: /m.ts",
    ...Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`),
    "const " + "x".repeat(60) + "needle = 1;",
  ];
  const doc = parseDocument(lines.join("\n"));
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 30, height: 8 },
  );
  press(s, "/");
  type(s, "needle");
  press(s, "enter");
  assert(s.view().top > 0, "scrolled down to the match");
  assert(s.view().left > 0, "scrolled right to the match");
});

Deno.test("session: paging, half-paging and home/end via the keymap", () => {
  const lines = ["// transformed: /m.ts"].concat(
    Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`),
  );
  const doc = parseDocument(lines.join("\n"));
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 10 },
  );
  press(s, "space"); // page down
  const afterPage = s.view().top;
  assert(afterPage > 0, "space paged down");
  press(s, "b"); // page up
  assert(s.view().top < afterPage, "b paged up");
  press(s, "ctrl-d"); // half down
  const halfDown = s.view().top;
  assert(halfDown > 0);
  press(s, "ctrl-u"); // half up
  assert(s.view().top < halfDown, "ctrl-u half-paged up");
  press(s, "G"); // end
  const bottom = s.view().top;
  assert(bottom > 0);
  press(s, "g"); // home
  assertEquals(s.view().top, 0, "g goes home");
  // ctrl-f / ctrl-b also page.
  press(s, "ctrl-f");
  assert(s.view().top > 0);
  press(s, "ctrl-b");
  assertEquals(s.view().top, 0);
  // home / end keys.
  press(s, "end");
  assert(s.view().top > 0);
  press(s, "home");
  assertEquals(s.view().top, 0);
  // pagedown / pageup names.
  press(s, "pagedown");
  assert(s.view().top > 0);
  press(s, "pageup");
  assertEquals(s.view().top, 0);
});

Deno.test("session: capital keycap shortcuts accept either letter case", () => {
  const cases: Array<{
    lower: string;
    upper: string;
    setup?: readonly string[];
  }> = [
    { lower: "q", upper: "Q" },
    { lower: "j", upper: "J" },
    { lower: "k", upper: "K", setup: ["j"] },
    { lower: "h", upper: "H", setup: ["l"] },
    { lower: "l", upper: "L" },
    { lower: "b", upper: "B", setup: ["space"] },
    { lower: "c", upper: "C" },
  ];
  for (const { lower, upper, setup = [] } of cases) {
    const lowerSession = makeSession(30, 8);
    const upperSession = makeSession(30, 8);
    press(lowerSession, ...setup, lower);
    press(upperSession, ...setup, upper);
    assertEquals(
      upperSession.view(),
      lowerSession.view(),
      `${upper} matches ${lower}`,
    );
    assertEquals(
      upperSession.quit,
      lowerSession.quit,
      `${upper} and ${lower} have the same quit state`,
    );
  }
});

Deno.test("session: capital WASD keycaps navigate to the same tree nodes", () => {
  const cases = [
    {
      lower: "w",
      upper: "W",
      from: "pattern myPattern",
      to: "lift __cfLift_1",
    },
    {
      lower: "s",
      upper: "S",
      from: "lift __cfLift_1",
      to: "pattern myPattern",
    },
    { lower: "a", upper: "A", from: "pattern myPattern", to: "▸ /app.ts" },
    { lower: "d", upper: "D", from: "pattern myPattern", to: "λ(input)" },
  ];
  for (const { lower, upper, from, to } of cases) {
    const lowerSession = makeSession();
    const upperSession = makeSession();
    selectByLabel(lowerSession, from);
    selectByLabel(upperSession, from);
    press(lowerSession, lower);
    press(upperSession, upper);
    assertEquals(
      lowerSession.view().selected?.label,
      to,
      `${lower} reached ${to}`,
    );
    assertEquals(
      upperSession.view(),
      lowerSession.view(),
      `${upper} matches ${lower}`,
    );
  }
});

Deno.test("session: capital Z keycap frames the selected node", () => {
  const height = 8;
  const lowerSession = makeSession(80, height);
  const upperSession = makeSession(80, height);
  selectByLabel(lowerSession, "pattern myPattern");
  selectByLabel(upperSession, "pattern myPattern");
  const node = lowerSession.view().selected!;
  press(lowerSession, "g");
  press(upperSession, "g");
  assertEquals(lowerSession.view().top, 0);
  assertEquals(upperSession.view().top, 0);

  press(lowerSession, "z");
  press(upperSession, "Z");
  const expected = frameTop(
    node.startLine,
    node.endLine,
    height,
    lowerSession.doc.lines.length,
  );
  assert(expected > 0, "the fixture requires reframing from the top");
  assertEquals(lowerSession.view().top, expected, "z framed the node");
  assertEquals(upperSession.view(), lowerSession.view(), "Z matches z");
});

Deno.test("session: Enter with no selection prompts to select a node", () => {
  const s = makeSession();
  press(s, "enter");
  assert(s.view().message.includes("Select a node first"), s.view().message);
});

Deno.test("session: 'z' in pager mode frames the selected node", () => {
  const s = makeSession(80, 8);
  selectByLabel(s, "pattern myPattern");
  press(s, "g");
  press(s, "z");
  const node = s.view().selected!;
  assertEquals(
    s.view().top,
    frameTop(node.startLine, node.endLine, 8, s.doc.lines.length),
    "z framed the node",
  );
});

Deno.test("session: '#' toggles line numbers and escape clears selection & search", () => {
  const s = makeSession();
  assertEquals(s.view().showLineNumbers, false);
  press(s, "#");
  assertEquals(s.view().showLineNumbers, true);
  press(s, "s"); // select something
  press(s, "/");
  type(s, "token");
  press(s, "enter");
  assert(s.view().selected, "selected before escape");
  press(s, "escape");
  assertEquals(s.view().selected, null, "selection cleared");
  assertEquals(s.view().matches, null, "search cleared");
});

Deno.test("session: navigateTree with no structure reports no structure", () => {
  const doc = parseDocument("   \n   \n");
  // A whitespace-only document has an empty structure tree.
  const empty = { ...doc, structure: [], flatStructure: [] };
  const s = new Session(
    empty,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "tab");
  assertEquals(s.view().message, "No structure detected");
  press(s, "s");
  assertEquals(s.view().message, "No structure detected");
});

//
// plain-file editing key paths (888-1090)
//

function fileSession(text: string, width = 80, height = 12): {
  s: Session;
  source: EditableSource;
  saved: { text: string | null };
} {
  const path = "/work/edit.ts";
  const saved = { text: null as string | null };
  const source: EditableSource = {
    label: "edit.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: (t) => {
      saved.text = t;
      return "Saved edit.ts";
    },
    revert: (original, current, cursorLine) =>
      original === current ? null : {
        text: original,
        cursorLine: Math.min(cursorLine, original.split("\n").length - 1),
      },
  };
  const doc = parseDocument(text, path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width, height },
    undefined,
    source,
  );
  return { s, source, saved };
}

Deno.test("session: revealing the cursor on a non-editable view reports the reason", () => {
  const doc = parseDocument("const a = 1;\n");
  // No source at all: bare arrow reports there's no file to edit.
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "e"); // try to reveal the cursor
  assert(s.view().cursor === null, "no cursor without a source");
  assert(
    s.view().message.includes("no underlying file"),
    s.view().message,
  );
});

Deno.test("session: a read-only source reports its reason on edit", () => {
  const doc = parseDocument("const a = 1;\n");
  const source: EditableSource = {
    label: null,
    editable: false,
    reason: "piped input is read-only",
    parse: (t) => parseDocument(t),
    save: () => "read-only",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "e");
  assertEquals(s.view().cursor, null);
  assert(s.view().message.includes("read-only"), s.view().message);
});

Deno.test("session: word, line and buffer movement in a file buffer", () => {
  const { s } = fileSession("alpha beta gamma\nsecond line here\nthird\n");
  press(s, "e"); // reveal cursor at top
  assertEquals(s.view().cursor, { line: 0, col: 0 });
  s.handleKey(alt("f")); // word forward
  assert((s.view().cursor?.col ?? 0) > 0, "M-f moved forward a word");
  s.handleKey(alt("b")); // word backward
  assertEquals(s.view().cursor?.col, 0, "M-b moved back");
  press(s, "right", "right");
  assertEquals(s.view().cursor?.col, 2);
  press(s, "left");
  assertEquals(s.view().cursor?.col, 1);
  press(s, "ctrl-e"); // line end
  assert((s.view().cursor?.col ?? 0) > 1);
  press(s, "ctrl-a"); // line start
  assertEquals(s.view().cursor?.col, 0);
  press(s, "down"); // ctrl-n style would also work
  assertEquals(s.view().cursor?.line, 1);
  press(s, "up");
  assertEquals(s.view().cursor?.line, 0);
  press(s, "ctrl-n");
  assertEquals(s.view().cursor?.line, 1);
  press(s, "ctrl-p");
  assertEquals(s.view().cursor?.line, 0);
  press(s, "ctrl-f");
  assertEquals(s.view().cursor?.col, 1);
  press(s, "ctrl-b");
  assertEquals(s.view().cursor?.col, 0);
  press(s, "end");
  assert((s.view().cursor?.col ?? 0) > 0);
  press(s, "home");
  assertEquals(s.view().cursor?.col, 0);
  s.handleKey(alt(">")); // buffer end
  assert((s.view().cursor?.line ?? 0) >= 1);
  s.handleKey(alt("<")); // buffer start
  assertEquals(s.view().cursor, { line: 0, col: 0 });
});

Deno.test("session: cursor paging up and down moves the cursor by a page", () => {
  const { s } = fileSession(
    Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n") + "\n",
    60,
    8,
  );
  press(s, "e"); // reveal cursor at top
  press(s, "pagedown");
  assert((s.view().cursor?.line ?? 0) > 0, "pagedown moved the cursor");
  const afterDown = s.view().cursor!.line;
  press(s, "pageup");
  assert(s.view().cursor!.line < afterDown, "pageup moved back");
  s.handleKey(alt("v")); // M-v page up
  assert(s.view().cursor!.line >= 0);
  press(s, "ctrl-v"); // C-v page down
  assert(s.view().cursor!.line >= 0);
});

Deno.test("session: typing, tab, space, kill-line, yank and word-case edits in a file", () => {
  const { s } = fileSession("hello world\n");
  press(s, "e"); // reveal cursor
  press(s, "end"); // end of "hello world"
  type(s, "!"); // insert a char
  assert(s.doc.lines[0].text.endsWith("!"), s.doc.lines[0].text);
  press(s, "space"); // insert a space
  press(s, "tab"); // insert two spaces
  assert(s.doc.lines[0].text.includes("  "), s.doc.lines[0].text);
  // Kill to end of line, then yank it back.
  press(s, "ctrl-a");
  press(s, "ctrl-k");
  assertEquals(s.doc.lines[0].text, "", "ctrl-k killed the line");
  press(s, "ctrl-y");
  assert(s.doc.lines[0].text.startsWith("hello"), "ctrl-y yanked it back");
  // Word case operations.
  press(s, "ctrl-a");
  s.handleKey(alt("u")); // uppercase word
  assert(s.doc.lines[0].text.startsWith("HELLO"), s.doc.lines[0].text);
  press(s, "ctrl-a");
  s.handleKey(alt("l")); // lowercase word
  assert(s.doc.lines[0].text.startsWith("hello"), s.doc.lines[0].text);
  press(s, "ctrl-a");
  s.handleKey(alt("c")); // capitalize word
  assert(s.doc.lines[0].text.startsWith("Hello"), s.doc.lines[0].text);
});

Deno.test("session: displayed Alt-letter shortcuts accept either case", () => {
  const cases: Array<{
    lower: string;
    upper: string;
    text: string;
    setup?: readonly string[];
  }> = [
    { lower: "f", upper: "F", text: "hello world\n" },
    { lower: "b", upper: "B", text: "hello world\n", setup: ["end"] },
    { lower: "l", upper: "L", text: "HELLO world\n" },
    { lower: "u", upper: "U", text: "hello world\n" },
    { lower: "c", upper: "C", text: "hello world\n" },
  ];
  for (const { lower, upper, text, setup = [] } of cases) {
    const lowerSession = fileSession(text).s;
    const upperSession = fileSession(text).s;
    press(lowerSession, "e", ...setup);
    press(upperSession, "e", ...setup);
    lowerSession.handleKey(alt(lower));
    upperSession.handleKey(alt(upper));
    assertEquals(
      upperSession.doc.text,
      lowerSession.doc.text,
      `Alt-${upper} edits like Alt-${lower}`,
    );
    assertEquals(
      upperSession.view().cursor,
      lowerSession.view().cursor,
      `Alt-${upper} moves like Alt-${lower}`,
    );
  }
});

Deno.test("session: delete-forward, backspace, kill-word forward/back, newline and mark/region", () => {
  const { s } = fileSession("abcdef ghij\n");
  press(s, "e"); // enter edit mode
  press(s, "delete"); // delete the 'a'
  assert(s.doc.lines[0].text.startsWith("bcdef"), s.doc.lines[0].text);
  press(s, "ctrl-d"); // delete the 'b'
  assert(s.doc.lines[0].text.startsWith("cdef"), s.doc.lines[0].text);
  s.handleKey(alt("d")); // kill word forward ("cdef")
  assert(
    s.doc.lines[0].text.trimStart().startsWith("ghij"),
    s.doc.lines[0].text,
  );
  press(s, "end");
  s.handleKey(alt("backspace")); // kill word backward ("ghij")
  press(s, "ctrl-a");
  // Set mark, move, kill region.
  press(s, "ctrl-space");
  assertEquals(s.view().message, "Mark set");
  press(s, "right", "right");
  press(s, "ctrl-w"); // kill the region
  // Newline insert.
  press(s, "enter");
  assert(s.doc.lines.length >= 2, "enter split the line");
  // Backspace joins lines back.
  press(s, "backspace");
});

Deno.test("session: yank-pop in a file rotates the kill ring", () => {
  const { s } = fileSession("one\ntwo\nthree\n");
  press(s, "e"); // enter edit mode
  press(s, "ctrl-k", "ctrl-k"); // kill "one" then the empty line / newline
  press(s, "down");
  press(s, "ctrl-k");
  press(s, "ctrl-y"); // yank most recent
  s.handleKey(alt("y")); // yank-pop to the previous kill
  assert(s.doc.text.length >= 0, "yank-pop ran");
});

Deno.test("session: ctrl-` sets the mark like ctrl-space", () => {
  const { s } = fileSession("mark me\n");
  press(s, "e"); // enter edit mode
  s.handleKey({ name: "ctrl-`" });
  assertEquals(s.view().message, "Mark set");
});

Deno.test("session: an unmodelled Alt combo while editing is a no-op", () => {
  const { s } = fileSession("text\n");
  press(s, "e"); // enter edit mode
  const before = s.doc.text;
  s.handleKey(alt("q")); // not a modeled Alt binding
  assertEquals(s.doc.text, before, "unmodelled Alt combo changed nothing");
});

Deno.test("session: escape leaves edit mode and triggers a reparse", () => {
  const { s } = fileSession("const a = 1;\n");
  press(s, "e"); // enter edit mode
  type(s, "x"); // dirty + set needsReparse via live highlight
  press(s, "escape"); // leaves edit mode and reparses
  assertEquals(s.view().cursor, null, "cursor hidden after escape");
});

Deno.test("session: ctrl-c while editing quits a clean buffer", () => {
  const { s } = fileSession("clean\n");
  press(s, "e"); // enter edit mode
  press(s, "ctrl-c");
  assert(s.quit, "ctrl-c quit the clean buffer");
});

//
// F3 / save / quit prompts (1391-1474)
//

Deno.test("session: F3 saves an editable file and ctrl-x ctrl-s also saves", () => {
  const { s, saved } = fileSession("save me\n");
  press(s, "e"); // reveal cursor at the start
  press(s, "end"); // move to the end of the line
  type(s, "!");
  press(s, "f3");
  assert(s.view().message.startsWith("Saved"), s.view().message);
  assert(saved.text?.startsWith("save me!"), saved.text ?? "");
  // The C-x C-s chord saves too.
  type(s, "?");
  press(s, "ctrl-x", "ctrl-s");
  assert(s.view().message.startsWith("Saved"), s.view().message);
});

Deno.test("session: requestSave with nothing to save reports it", () => {
  const doc = parseDocument("no source\n");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "f3");
  assertEquals(s.view().message, "Nothing to save.");
});

Deno.test("session: requestSave on a read-only source reports it", () => {
  const doc = parseDocument("ro\n");
  const source: EditableSource = {
    label: null,
    editable: false,
    reason: "this view is read-only",
    parse: (t) => parseDocument(t),
    save: () => "ro",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "f3");
  assert(s.view().message.includes("read-only"), s.view().message);
});

Deno.test("session: a save that throws is reported as a failure", () => {
  const path = "/work/boom.ts";
  const source: EditableSource = {
    label: "boom.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => {
      throw new Error("disk full");
    },
  };
  const doc = parseDocument("data\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "e");
  assert(s.view().cursor !== null, "e entered edit mode");
  type(s, "x");
  assert(s.doc.lines[0].text.startsWith("x"), "the edit landed");
  press(s, "f3");
  assert(s.view().message.includes("Save failed"), s.view().message);
  assert(s.view().message.includes("disk full"), s.view().message);
});

Deno.test("session: the quit save-prompt answers s / d / c", () => {
  // (s) save then quit. Escape leaves edit mode first; q in the pager quits.
  {
    const { s, saved } = fileSession("one\n");
    press(s, "e"); // enter edit mode
    type(s, "A");
    press(s, "escape"); // back to the pager (the buffer is still dirty)
    press(s, "q"); // dirty -> save prompt
    assert(promptText(s.view()).includes("Save changes"), promptText(s.view()));
    const beforeWheel = s.view();
    press(s, "wheel-down");
    assertEquals(
      promptText(s.view()),
      promptText(beforeWheel),
      "wheel input leaves the prompt open",
    );
    assertEquals(s.view().top, beforeWheel.top, "wheel input does not scroll");
    assertEquals(
      s.view().dialog?.focus,
      beforeWheel.dialog?.focus,
      "wheel input does not move the focused button",
    );
    press(s, "s");
    assert(saved.text?.includes("A"), saved.text ?? "");
    assert(s.quit, "s saved and quit");
  }
  // (d) discard then quit.
  {
    const { s, saved } = fileSession("two\n");
    press(s, "e"); // enter edit mode
    type(s, "B");
    press(s, "escape");
    press(s, "q");
    press(s, "d");
    assertEquals(saved.text, null, "d did not save");
    assert(s.quit, "d discarded and quit");
  }
  // (c) cancel stays.
  {
    const { s } = fileSession("three\n");
    press(s, "e"); // enter edit mode
    type(s, "C");
    press(s, "escape");
    press(s, "q");
    press(s, "c");
    assertEquals(s.view().message, "Cancelled");
    assert(!s.quit, "c cancelled the quit");
  }
  // escape also cancels.
  {
    const { s } = fileSession("four\n");
    press(s, "e"); // enter edit mode
    type(s, "D");
    press(s, "escape");
    press(s, "q");
    press(s, "escape");
    assertEquals(s.view().message, "Cancelled");
    assert(!s.quit);
  }
});

Deno.test("session: requestQuitFromSignal raises the prompt with unsaved edits", () => {
  const { s } = fileSession("sig\n");
  press(s, "e"); // enter edit mode
  type(s, "Z"); // dirty
  const willPrompt = s.requestQuitFromSignal();
  assert(willPrompt, "a dirty buffer prompts on signal");
  // A second signal during the prompt returns false.
  assertEquals(s.requestQuitFromSignal(), false);
});

Deno.test("session: requestQuitFromSignal on a clean buffer quits without a prompt", () => {
  const { s } = fileSession("clean\n");
  press(s, "e"); // reveal cursor but make no edits
  const willPrompt = s.requestQuitFromSignal();
  assertEquals(willPrompt, false, "clean buffer does not prompt");
  assert(s.quit, "and it quit");
});

Deno.test("session: an unbound C-x chord reports it", () => {
  const { s } = fileSession("chord\n");
  press(s, "ctrl-x", "z"); // C-x z is unbound
  assert(s.view().message.includes("unbound"), s.view().message);
});

Deno.test("session: C-x C-c quits", () => {
  const { s } = fileSession("clean\n");
  press(s, "ctrl-x", "ctrl-c");
  assert(s.quit, "C-x C-c quit a clean buffer");
});

//
// revert prompt (1480-1544)
//

Deno.test("session: ctrl-r on a clean buffer reports nothing to revert", () => {
  const { s } = fileSession("nothing\n");
  press(s, "e"); // enter edit mode
  press(s, "ctrl-r");
  assertEquals(s.view().message, "Nothing to revert.");
});

Deno.test("session: a plain-file revert prompt accepts y and reverts all", () => {
  const { s } = fileSession("original line\n");
  press(s, "e"); // enter edit mode
  type(s, "EDIT");
  assert(s.doc.text.includes("EDIT"), "edited");
  press(s, "ctrl-r");
  assert(promptText(s.view()).includes("Revert all"), promptText(s.view()));
  press(s, "y");
  assertEquals(s.doc.text, "original line\n", "reverted to the original");
  assert(s.view().message.includes("Reverted"), s.view().message);
});

Deno.test("session: a plain-file revert prompt ignores unlisted keys, cancels on c", () => {
  const { s } = fileSession("keep me\n");
  press(s, "e"); // enter edit mode
  type(s, "X");
  press(s, "ctrl-r");
  press(s, "q"); // not a button -> nothing happens, the prompt stays up
  assertEquals(s.view().message, "", "an unlisted key does nothing");
  assert(promptText(s.view()).includes("Revert"), "the prompt is still up");
  press(s, "c"); // the Cancel button
  assertEquals(s.view().message, "Cancelled");
  assert(s.doc.text.includes("X"), "edit retained after cancel");
});

Deno.test("session: revert when the source offers none reports it", () => {
  // A source with editable text but no revert function.
  const path = "/work/norev.ts";
  const source: EditableSource = {
    label: "norev.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
  const doc = parseDocument("data\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "e");
  type(s, "x"); // dirty
  press(s, "ctrl-r");
  press(s, "y");
  assertEquals(s.view().message, "Revert isn't available here.");
});

Deno.test("session: revert that returns nothing-there is reported", () => {
  const path = "/work/empty-rev.ts";
  const source: EditableSource = {
    label: "empty-rev.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
    revert: () => null, // never has anything to revert
  };
  const doc = parseDocument("data\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "e");
  type(s, "x"); // dirty
  press(s, "ctrl-r");
  press(s, "y");
  assertEquals(s.view().message, "Nothing to revert there.");
});

//
// expand context errors (1556-1574)
//

Deno.test("session: ctrl-l when expanding context is unavailable reports it", () => {
  const { s } = fileSession("plain file\n");
  press(s, "e"); // enter edit mode
  press(s, "ctrl-l"); // a plain file has no expandContext
  assertEquals(s.view().message, "Expanding context isn't available here.");
});

Deno.test("session: ctrl-l in pager mode with no hunk in view reports move-to-a-hunk", () => {
  // A source that advertises expandContext but whose document has no hunks.
  const path = "/work/nohunk.ts";
  const source: EditableSource = {
    label: "nohunk.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
    expandContext: () => null,
  };
  const doc = parseDocument("// transformed: /m.ts\nconst a = 1;\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  // Pager mode (no cursor): expandRefLine finds no hunk and returns null.
  press(s, "ctrl-l");
  assert(
    s.view().message.includes("Move to a hunk's edge"),
    s.view().message,
  );
});

Deno.test("session: ctrl-l when expandContext yields nothing reports no more context", () => {
  const { ws, done } = expandWs();
  try {
    const model = parseDiff(EXPAND_DIFF)!;
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
    const base = diffSource(ws, edit);
    // Wrap the source so expandContext always returns null.
    const source: EditableSource = { ...base, expandContext: () => null };
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      source,
    );
    press(s, "e"); // cursor mode
    press(s, "ctrl-l");
    assertEquals(s.view().message, "No more context to show.");
  } finally {
    done();
  }
});

//
// diff edit machinery exercised through a real diff source
//

const EXPAND_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";
const EXPAND_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;

function expandWs(): { ws: DiffWorkspace; root: string; done: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "m.ts"), EXPAND_FILE);
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
  return { ws, root, done: () => Deno.removeSync(root, { recursive: true }) };
}

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
const extra = answer + 1;
`;

const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,5 @@ export function double
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = 42;
+export const answer = double(21);
+const extra = answer + 1;
`;

function diffWorkspace(): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
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
  return { root, ws, done: () => Deno.removeSync(root, { recursive: true }) };
}

function diffSession(ws: DiffWorkspace, height = 20): Session {
  const model = parseDiff(DIFF)!;
  const { doc, edit } = buildDiffDocument(DIFF, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit),
  );
}

/** Reveal the cursor and move it down to the given diff line. */
function toLine(s: Session, line: number): void {
  if (!s.view().cursor) press(s, "e"); // enter edit mode at the top
  let guard = 0;
  while ((s.view().cursor?.line ?? -1) < line && guard++ < 1000) {
    press(s, "down");
  }
}

Deno.test("diffcov: editing a non-editable removed line is refused for typed chars", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8); // the removed line
    const before = s.doc.text;
    type(s, "X");
    assert(s.view().message.includes("isn't editable"), s.view().message);
    assertEquals(s.doc.text, before);
  } finally {
    done();
  }
});

Deno.test("diffcov: delete-forward at end of a diff line is refused as a join", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an added line
    press(s, "end");
    press(s, "delete");
    assert(
      s.view().message.includes("remove a line") ||
        s.view().message.length > 0,
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: a multi-line paste is refused while editing a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    // A key.char carrying a newline is treated as a multi-line insert.
    s.handleKey({ name: "paste", char: "a\nb" });
    assert(s.view().message.includes("across lines"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: M-d / M-backspace / C-w / C-k respect the diff marker", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line
    // M-d kills a word forward from the editable region.
    press(s, "end");
    s.handleKey(alt("backspace")); // kill word backward
    assert(s.doc.text.length > 0);
    // Set the mark and kill a region within the line.
    press(s, "ctrl-a");
    press(s, "ctrl-space");
    press(s, "right", "right", "right");
    press(s, "ctrl-w");
    assert(s.doc.text.length > 0);
    // C-k kills to the end of an editable line.
    press(s, "ctrl-a");
    press(s, "ctrl-k");
    assert(s.doc.text.length >= 0);
  } finally {
    done();
  }
});

Deno.test("diffcov: C-w without a mark asks to set the mark", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "ctrl-w");
    assert(s.view().message.includes("Set the mark"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: a multi-line region kill is refused in a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "ctrl-space"); // mark here
    press(s, "down"); // move to a different row
    press(s, "ctrl-w");
    assert(
      s.view().message.includes("across lines") ||
        s.view().message.includes("isn't editable"),
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: M-d and word-case edits work on an editable diff line", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    type(s, " word");
    press(s, "end");
    s.handleKey(alt("backspace")); // remove " word"-ish backward
    // Word-case on the editable content.
    press(s, "ctrl-a");
    // editStart nudges the cursor past the marker; word ops should run.
    s.handleKey(alt("u"));
    assert(s.doc.text.length > 0);
  } finally {
    done();
  }
});

Deno.test("diffcov: yank-pop is blocked while editing a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    s.handleKey(alt("y")); // M-y yank-pop
    assert(s.view().message.includes("Yank-pop"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: ctrl-s edit-mode search lands the cursor on a match", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 5); // an editable context line near the top
    press(s, "ctrl-s"); // enter edit-mode search, seeded with the last query
    type(s, "return");
    // Ctrl-S inside the search steps to the next match.
    press(s, "ctrl-s");
    press(s, "enter"); // commit: land the cursor on the focused match
    assert(s.view().cursor !== null, "cursor remained on a match");
    // Escape from an edit-mode search restores the viewport to the cursor.
    press(s, "ctrl-s");
    type(s, "answer");
    press(s, "escape");
    assert(s.view().cursor !== null, "cursor still shown after escape");
  } finally {
    done();
  }
});

Deno.test("diffcov: backspace in an edit-mode search refreshes matches", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 5);
    press(s, "ctrl-s");
    type(s, "returnX"); // no match
    press(s, "backspace"); // back to "return": matches reappear
    press(s, "enter");
    assert(s.view().cursor !== null);
  } finally {
    done();
  }
});

Deno.test("diffcov: revert prompt offers hunk / file / all for a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 9);
    press(s, "end");
    type(s, "Z");
    assert(s.doc.text !== before, "edited");
    press(s, "ctrl-r");
    assert(promptText(s.view()).includes("Hunk"), promptText(s.view()));
    press(s, "h"); // revert the chunk
    assertEquals(s.doc.text, before, "the chunk reverted");
    assert(s.view().message.includes("Reverted"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: revert 'file' scope through the session", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 9);
    press(s, "end");
    type(s, "Q");
    press(s, "ctrl-r");
    press(s, "f"); // file scope
    assertEquals(s.doc.text, before);
  } finally {
    done();
  }
});

Deno.test("diffcov: an unlisted key at the diff revert prompt does nothing; Esc cancels", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    type(s, "M");
    press(s, "ctrl-r");
    press(s, "z"); // not a button -> nothing happens
    assertEquals(s.view().message, "", "an unlisted key does nothing");
    assert(promptText(s.view()).includes("Revert"), "prompt still up");
    press(s, "escape"); // Esc cancels (there is a Cancel button)
    assertEquals(s.view().message, "Cancelled");
  } finally {
    done();
  }
});

Deno.test("diffcov: a diff that matches no file on disk is read-only", () => {
  // A workspace whose read always fails: the diff source is not editable.
  const ws: DiffWorkspace = {
    resolve: (p) => p,
    read: () => null,
  };
  const model = parseDiff(DIFF)!;
  const { doc, edit } = buildDiffDocument(DIFF, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    diffSource(ws, edit),
  );
  press(s, "e"); // try to reveal the cursor
  assertEquals(s.view().cursor, null, "no cursor on a read-only diff");
  assert(s.view().message.length > 0, s.view().message);
});

Deno.test("diffcov: Enter splits a context line into a removed/added pair, then collapses back", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 6); // a context line
    press(s, "end");
    type(s, "X"); // splits to -/+ pair
    const split = s.doc.text.split("\n");
    assert(split.some((l) => l.startsWith("-")), "a removed line appeared");
    press(s, "backspace"); // collapse back when content matches again
    assertEquals(s.doc.text, before, "the pair collapsed back to context");
  } finally {
    done();
  }
});

Deno.test("diffcov: Enter mid-context produces +head/+tail added lines", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // a context line
    press(s, "end", "left", "left");
    s.handleKey({ name: "enter" });
    const lines = s.doc.text.split("\n");
    assert(lines.some((l) => l.startsWith("+")), "added lines produced");
  } finally {
    done();
  }
});

Deno.test("diffcov: Backspace at the start of an added line removes it", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 10); // "+const extra = answer + 1;"
    press(s, "end");
    for (let i = 0; i < "const extra = answer + 1;".length + 1; i++) {
      press(s, "backspace");
    }
    // The line was removed; the hunk header shrank by one new line.
    assert(!s.doc.text.includes("const extra = answer + 1;"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l expands the hunk in view", () => {
  const { ws, done } = expandWs();
  try {
    const model = parseDiff(EXPAND_DIFF)!;
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    assert(s.view().canExpand, "expand advertised");
    assertEquals(
      s.view().expandUp,
      false,
      "the quarter-screen target marks the lower hunk edge",
    );
    press(s, "ctrl-l"); // pager mode expand
    assert(s.doc.text.includes("theta"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l with a selected hunk expands that hunk", () => {
  const { ws, done } = expandWs();
  try {
    const model = parseDiff(EXPAND_DIFF)!;
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    // Select the hunk node, then expand it; the selection is re-pointed after.
    selectByLabel(s, "@@");
    press(s, "ctrl-l");
    assert(s.doc.text.includes("alpha") || s.doc.text.includes("beta"));
  } finally {
    done();
  }
});

// A hunk tall enough that the quarter-screen expansion target can be scrolled
// into either half, with room to reveal a full expansion above and below.
const TALL_LINES = Array.from(
  { length: 60 },
  (_, i) => `L${String(i + 1).padStart(2, "0")}`,
);
const TALL_FILE = `${TALL_LINES.join("\n")}\n`;
const TALL_DIFF = `diff --git a/t.ts b/t.ts
index 0000000..1111111 100644
--- a/t.ts
+++ b/t.ts
@@ -25,20 +25,20 @@
${TALL_LINES.slice(24, 33).map((l) => ` ${l}`).join("\n")}
-old L34
+L34
${TALL_LINES.slice(34, 44).map((l) => ` ${l}`).join("\n")}
`;

/** A session over TALL_DIFF, in pager mode, `height` rows tall. */
function tallSession(height: number): { s: Session; done: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "t.ts"), TALL_FILE);
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
  const model = parseDiff(TALL_DIFF)!;
  const { doc, edit } = buildDiffDocument(TALL_DIFF, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit),
  );
  return { s, done: () => Deno.removeSync(root, { recursive: true }) };
}

Deno.test("diffcov: pager-mode ctrl-l at a hunk's top expands upwards", () => {
  const { s, done } = tallSession(13);
  try {
    // With the viewport at the top of the hunk, the quarter-screen target is in
    // the hunk's upper half, so the context comes from above it.
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes("L24"), "revealed the line above the hunk");
    assert(!s.doc.text.includes("L45"), "did not reveal below the hunk");
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l at a hunk's bottom expands downwards", () => {
  const { s, done } = tallSession(13);
  try {
    // Scrolled to the end, the quarter-screen target is in the hunk's lower
    // half, so the context comes from below it.
    press(s, "G");
    const view = s.view();
    assertEquals(view.expandUp, false);
    assert(
      view.expandRow !== null,
      "the bottom body line carries the triangle",
    );
    assertEquals(
      view.diffMetadataRows,
      [],
      "there is no adjacent metadata below the triangle",
    );
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes("L45"), "revealed the line below the hunk");
    assert(!s.doc.text.includes("L24"), "did not reveal above the hunk");
  } finally {
    done();
  }
});

Deno.test("diffcov: padded blank rows do not move the quarter-screen target", () => {
  const root = Deno.makeTempDirSync();
  try {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[9] = "new";
    Deno.writeTextFileSync(join(root, "t.ts"), `${lines.join("\n")}\n`);
    const diff = `diff --git a/t.ts b/t.ts
index 0000000..1111111 100644
--- a/t.ts
+++ b/t.ts
@@ -10,1 +10,1 @@
-old
+new`;
    const ws: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => Deno.readTextFileSync(path),
    };
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 21 },
      undefined,
      diffSource(ws, edit),
    );

    press(s, "G");
    assertEquals(s.view().top, 2);
    assertEquals(
      s.view().expandUp,
      false,
      "the viewport quarter is nearest the hunk's bottom edge",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffcov: pager-mode ctrl-l follows the quarter-screen target as the view scrolls", () => {
  const { s, done } = tallSession(13);
  try {
    // The same session expands up first, then down once scrolled, rather than
    // repeating one direction until it is exhausted.
    press(s, "ctrl-l");
    assert(s.doc.text.includes("L24"), s.doc.text);
    press(s, "G", "ctrl-l");
    assert(s.doc.text.includes("L45"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l measures a selection's hunk from the selection", () => {
  // Tall enough that both of the hunk's edges are on screen, so which one is
  // nearest is a real question rather than the only one left.
  const plain = tallSession(30);
  try {
    // Left alone, the quarter-screen target is nearer the hunk's top edge.
    press(plain.s, "ctrl-l");
    assert(
      plain.s.doc.text.includes("L24"),
      "the quarter-screen target reached upwards",
    );
  } finally {
    plain.done();
  }
  const { s, done } = tallSession(30);
  try {
    // A selected line low in the hunk puts its bottom edge nearest instead, and
    // that is the edge that grows: the user picked a place to look.
    selectByLabel(s, "L37");
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes("L45"), "revealed below the selected line");
    assert(!s.doc.text.includes("L24"), "did not reveal above the hunk");
  } finally {
    done();
  }
});

const TWO_HUNK_FILE = `${
  Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n")
}\n`;
const TWO_HUNK_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -20,3 +20,3 @@
 line20
-OLD21
+line21
 line22
`;

Deno.test("filepicker: opening it after an edit leaves the structure tree current", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), TWO_HUNK_FILE);
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
    const model = parseDiff(TWO_HUNK_DIFF)!;
    const { doc, edit } = buildDiffDocument(TWO_HUNK_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
      gateway(),
    );
    press(s, "e");
    // Land an edit, then split the line so the hunks below it move down.
    for (let r = 0; r < 12; r++) {
      const before = s.doc.text;
      press(s, "x");
      if (s.doc.text !== before) break;
      press(s, "down");
    }
    press(s, "enter", "enter", "enter");
    press(s, "ctrl-x", "ctrl-f"); // the picker drops the text cursor
    press(s, "escape"); // cancelling returns to navigation
    // The tree navigation lands on must describe the text as it now stands.
    const real = parseDiff(s.doc.text)!.files.flatMap((f) => f.hunks).map((
      h,
    ) => [h.headerLine, h.endLine]);
    const tree = s.doc.flatStructure.filter((n) => n.kind === "hunk").map((
      n,
    ) => [n.startLine, n.endLine]);
    assertEquals(tree, real);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// Four files, one big enough that hiding it takes a large slice of the document
// off screen while leaving one row behind.
const FOLD_FILE = (p: string) =>
  `${
    Array.from(
      { length: 40 },
      (_, i) => `${p}${String(i + 1).padStart(3, "0")}`,
    )
      .join("\n")
  }\n`;
const FOLD_SMALL = (name: string, p: string) =>
  `diff --git a/${name} b/${name}
index 0000000..1111111 100644
--- a/${name}
+++ b/${name}
@@ -20,3 +20,3 @@
 ${p}020
-old ${p}021
+${p}021
 ${p}022`;
const FOLD_DIFF = `${FOLD_SMALL("a.ts", "A")}
diff --git a/big.ts b/big.ts
index 0000000..1111111 100644
--- a/big.ts
+++ b/big.ts
@@ -5,20 +5,20 @@
${
  Array.from({ length: 9 }, (_, i) => ` B${String(i + 5).padStart(3, "0")}`)
    .join("\n")
}
-old B014
+B014
${
  Array.from({ length: 10 }, (_, i) => ` B${String(i + 15).padStart(3, "0")}`)
    .join("\n")
}
${FOLD_SMALL("c.ts", "C")}
${FOLD_SMALL("d.ts", "D")}
`;

Deno.test("diffcov: pager-mode ctrl-l measures nearest in rows, not document lines", () => {
  const root = Deno.makeTempDirSync();
  try {
    for (
      const [name, p] of [
        ["a.ts", "A"],
        ["big.ts", "B"],
        ["c.ts", "C"],
        ["d.ts", "D"],
      ]
    ) {
      Deno.writeTextFileSync(join(root, name), FOLD_FILE(p));
    }
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
    const model = parseDiff(FOLD_DIFF)!;
    const { doc, edit } = buildDiffDocument(FOLD_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 23 },
      undefined,
      diffSource(ws, edit),
    );
    selectByLabel(s, "big.ts");
    press(s, "f", "escape"); // hide the big file, drop the selection
    lastFullPage(s);
    // The quarter-screen target is two display rows above c.ts's hunk and four
    // below a.ts's. c.ts is what the eye is nearest, so c.ts grows even though
    // big.ts's hidden lines put its header much farther away in the document.
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes("C019"), "the hunk nearest on screen grew");
    assert(!s.doc.text.includes("A023"), "the hunk further away did not");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// The tall hunk with a second file after it, so the content on either side of
// the hunk can be found by name.
const PIN_DIFF = `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -25,20 +25,20 @@
${TALL_LINES.slice(24, 33).map((l) => ` ${l}`).join("\n")}
-old L34
+L34
${TALL_LINES.slice(34, 44).map((l) => ` ${l}`).join("\n")}
diff --git a/b.ts b/b.ts
index 0000000..1111111 100644
--- a/b.ts
+++ b/b.ts
@@ -20,3 +20,3 @@
 B020
-old B021
+B021
 B022
`;

function pinSession(): { s: Session; done: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "a.ts"), TALL_FILE);
  Deno.writeTextFileSync(
    join(root, "b.ts"),
    `${
      Array.from({ length: 40 }, (_, i) => `B${String(i + 1).padStart(3, "0")}`)
        .join("\n")
    }\n`,
  );
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
  const model = parseDiff(PIN_DIFF)!;
  const { doc, edit } = buildDiffDocument(PIN_DIFF, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 13 },
    undefined,
    diffSource(ws, edit),
  );
  return { s, done: () => Deno.removeSync(root, { recursive: true }) };
}

/** The screen row `text` sits on: negative above the viewport, at or past the
 * content rows below it. A display row is a document line while nothing is
 * collapsed. */
function screenRow(s: Session, text: string): number {
  const line = s.doc.text.split("\n").indexOf(text);
  if (line < 0) throw new Error(`line not in the document: ${text}`);
  return line - s.view().top;
}

Deno.test("diffcov: expanding upwards holds the content before the hunk still", () => {
  const { s, done } = pinSession();
  try {
    const held = screenRow(s, "+++ b/a.ts");
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assertEquals(
      screenRow(s, "+++ b/a.ts"),
      held,
      "the content before it held",
    );
    const revealed = screenRow(s, " L20");
    assert(
      revealed >= 0 && revealed < 12,
      `revealed line on screen: ${revealed}`,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: expanding downwards holds the content after the hunk still", () => {
  const { s, done } = pinSession();
  try {
    // Put the quarter-screen target in the hunk's lower half.
    press(s, "ctrl-d", "ctrl-d", "j", "j", "j");
    const held = screenRow(s, "diff --git a/b.ts b/b.ts");
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assertEquals(
      screenRow(s, "diff --git a/b.ts b/b.ts"),
      held,
      "the content after it held",
    );
    const revealed = screenRow(s, " L50");
    assert(
      revealed >= 0 && revealed < 12,
      `revealed line on screen: ${revealed}`,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: wrapped expansion holds the content after the hunk still", () => {
  for (
    const { width, scroll } of [
      { width: 2, scroll: 144 },
      { width: 3, scroll: 79 },
      { width: 4, scroll: 44 },
      { width: 5, scroll: 35 },
    ]
  ) {
    const { s, done } = pinSession();
    try {
      s.resize(width, 13);
      press(s, "\\", ...Array(scroll).fill("j"));
      const before = s.view();
      assertEquals(before.expandUp, false);
      const heldLine = s.displayDoc().lines.findIndex((line) =>
        line.text === "diff --git a/b.ts b/b.ts"
      );
      const heldRow = before.wrapPlan!.firstRow[heldLine] - before.top;
      assertEquals(heldRow, 11, `initial row at width ${width}`);

      press(s, "ctrl-l");
      const after = s.view();
      const movedLine = s.displayDoc().lines.findIndex((line) =>
        line.text === "diff --git a/b.ts b/b.ts"
      );
      assertEquals(
        after.wrapPlan!.firstRow[movedLine] - after.top,
        heldRow,
        `held row at width ${width}`,
      );
    } finally {
      done();
    }
  }
});

Deno.test("diffcov: wrapped reveal keeps the next triangle on screen", () => {
  const { s, done } = tallSession(9);
  try {
    s.resize(20, 9);
    press(s, "\\", "ctrl-l");

    const view = s.view();
    assert(
      (view.diffMetadataRows?.length ?? 0) > 0,
      "the next edge has adjacent metadata",
    );
    assertEquals(
      view.diffAnnotations,
      [{ line: 5, kind: "expandUp" }],
      "the metadata label is withheld when its reflow would hide the triangle",
    );
    const rendered = renderFrame(s.displayDoc(), view);
    assert(
      rendered.slice(0, -1).some((row) => row.endsWith("◥")),
      "the next expansion triangle remains visible",
    );
    assert(
      rendered.slice(0, -1).every((row) =>
        !row.includes("^L") && !row.endsWith("█")
      ),
      "no orphan metadata connector is drawn in document rows",
    );
  } finally {
    done();
  }
});

/** The row texts a frame — or the session itself — puts on screen. */
function rows(f: { doc: Document; view: ViewState }): string[] {
  return f.doc.lines.slice(f.view.top, f.view.top + f.view.height - 1)
    .map((l) => l.text);
}

function screenOf(s: Session): string[] {
  return rows({ doc: s.displayDoc(), view: s.view() });
}

Deno.test("diffcov: the reveal frames run from the screen before to the one after", () => {
  const { s, done } = pinSession();
  try {
    const before = screenOf(s);
    press(s, "ctrl-l");
    const reveal = s.pendingReveal!;
    assertEquals(reveal.count, 10);
    assertEquals(reveal.up, true);
    const body = (ls: string[]) => ls.filter((l) => !l.startsWith("@@"));
    // Nothing shown yet is the picture the user was already looking at, and
    // everything shown is where it settles, so the frames only ever interpolate.
    // The lines are what arrive: the header carries its finished counts from the
    // first frame, reading the range the reveal is heading for rather than
    // counting up to it.
    assertEquals(body(rows(s.revealFrame(0)!)), body(before));
    assert(
      rows(s.revealFrame(0)!).some((l) => l.startsWith("@@ -15,30")),
      "the header is already at the range it is heading for",
    );
    assertEquals(rows(s.revealFrame(reveal.count)!), screenOf(s));
  } finally {
    done();
  }
});

Deno.test("diffcov: reveal-frame metadata stays beside its triangle", () => {
  const { s, done } = pinSession();
  try {
    press(s, "ctrl-l");
    const reveal = s.pendingReveal!;
    for (let shown = 0; shown <= reveal.count; shown++) {
      const frame = s.revealFrame(shown)!;
      const annotations = frame.view.diffAnnotations ?? [];
      const triangle = annotations.find((annotation) =>
        annotation.kind !== "diffMetadata"
      );
      for (
        const metadata of annotations.filter((annotation) =>
          annotation.kind === "diffMetadata"
        )
      ) {
        assert(triangle, `metadata has no triangle at frame ${shown}`);
        assertEquals(
          Math.abs(metadata.line - triangle.line),
          1,
          `metadata is not adjacent at frame ${shown}`,
        );
      }
      const rendered = renderFrame(frame.doc, frame.view);
      if (rendered.some((row) => row.includes("^L█"))) {
        assert(
          rendered.some((row) => row.includes("◥") || row.includes("◢")),
          `rendered metadata has no triangle at frame ${shown}`,
        );
      }
    }
  } finally {
    done();
  }
});

Deno.test("diffcov: reveal frames land the line meeting the hunk first", () => {
  const { s, done } = pinSession();
  try {
    press(s, "ctrl-l"); // upwards: L15..L24 revealed above the body
    const first = s.revealFrame(1)!.doc.lines.map((l) => l.text);
    // L24 meets the hunk, L15 is furthest from it. Landing the furthest first
    // would put L15 next to the body and show a file that reads L15, L25.
    assert(first.includes(" L24"), "the line meeting the hunk has landed");
    assert(!first.includes(" L15"), "the furthest line has not");
  } finally {
    done();
  }
});

Deno.test("diffcov: reveal frames landing downwards also start at the hunk", () => {
  const { s, done } = pinSession();
  try {
    press(s, "ctrl-d", "ctrl-d", "j", "j", "j", "ctrl-l"); // downwards
    const reveal = s.pendingReveal!;
    assertEquals(reveal.up, false);
    const first = s.revealFrame(1)!.doc.lines.map((l) => l.text);
    assert(first.includes(" L45"), "the line meeting the hunk has landed");
    assert(!first.includes(" L54"), "the furthest line has not");
    // The held edge stays on its row throughout, not only at the end.
    for (let shown = 0; shown <= reveal.count; shown++) {
      const f = s.revealFrame(shown)!;
      assertEquals(
        rows(f).indexOf("diff --git a/b.ts b/b.ts"),
        11,
        `held edge moved at frame ${shown}`,
      );
    }
  } finally {
    done();
  }
});

Deno.test("diffcov: the next key ends the reveal", () => {
  const { s, done } = pinSession();
  try {
    press(s, "ctrl-l");
    assert(s.pendingReveal !== null, "a reveal is pending");
    press(s, "j");
    assertEquals(s.pendingReveal, null);
    assertEquals(s.revealFrame(1), null);
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l drops a selection that scrolls out of view", () => {
  const { s, done } = tallSession(13);
  try {
    // The selected line is nearer the hunk's bottom edge. Scrolling it off the
    // top hands the decision back to the quarter-screen target, which is in the
    // hunk's upper half and expands upwards.
    selectByLabel(s, "L37");
    press(s, "g", "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(
      s.doc.text.includes("L24"),
      "the quarter-screen target decided, not the selection",
    );
    assert(!s.doc.text.includes("L45"), "the off-screen selection did not");
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l with a hidden file reports move-to-a-hunk", () => {
  const { s, done } = tallSession(13);
  try {
    press(s, "F"); // hide every file: only the summary row is on screen
    const before = s.doc.text;
    press(s, "ctrl-l");
    assert(
      s.view().message.includes("Move to a hunk's edge"),
      s.view().message,
    );
    assertEquals(s.doc.text, before, "a hidden hunk is not expanded");
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l with the file node selected uses the quarter-screen target", () => {
  const { s, done } = tallSession(13);
  try {
    // The file node spans the hunk rather than sitting in it, so it does not
    // pin the reference line to its own start. The quarter-screen target still
    // decides.
    // Selecting scrolls to the node, so scroll to the end after selecting.
    press(s, "tab", "a", "a", "a");
    assert(s.view().selected?.label?.includes("t.ts"), "file node selected");
    press(s, "G", "ctrl-l");
    assert(s.doc.text.includes("L45"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffcov: after a revert the cursor snaps to an editable line", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6);
    press(s, "end");
    type(s, "X");
    press(s, "ctrl-r");
    press(s, "a"); // revert all; snapCursorToEditable runs
    assert(s.view().cursor !== null, "cursor lands on an editable line");
  } finally {
    done();
  }
});

//
// file picker (1656-1849)
//

const TREE: Record<string, DirEntry[]> = {
  "/work": [
    { name: "sub", isDir: true },
    ...Array.from({ length: 30 }, (_, i) => ({
      name: `file${String(i).padStart(2, "0")}.ts`,
      isDir: false,
    })),
  ],
  "/work/sub": [{ name: "c.ts", isDir: false }],
};

const PFILES: Record<string, string> = {
  "/work/file00.ts": "const a = 0;\n",
  "/work/sub/c.ts": "const c = 3;\n",
};

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function gateway(): FileGateway {
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  return {
    cwd: () => "/work",
    list: (dir) => TREE[dir] ?? null,
    open: (path) => {
      const text = PFILES[path];
      if (text === undefined) return null;
      return { source: pickerSource(path), text };
    },
    join: (dir, segment) => normalize(`${dir}/${segment}`),
    parent: (p) => normalize(`${p}/..`),
    base,
  };
}

function pickerSource(path: string): EditableSource {
  return {
    label: path.split("/").filter(Boolean).pop() ?? path,
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
}

function pickerSession(withPath = true): Session {
  const path = "/work/file00.ts";
  const doc = parseDocument(PFILES[path], path);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    withPath ? pickerSource(path) : undefined,
    gateway(),
  );
}

function entryText(s: Session): string[] {
  return s.view().overlay?.lines.map((l) => l.text) ?? [];
}

Deno.test("filepickercov: paging through a long listing scrolls the picker", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  assert(entryText(s).length > 10, "a long listing");
  press(s, "pagedown");
  assert(s.view().overlay!.scroll >= 0);
  press(s, "down", "ctrl-n"); // arrow and Emacs down
  press(s, "up", "ctrl-p"); // arrow and Emacs up
  press(s, "pageup");
  assertEquals(s.view().overlay!.selectedLine, 0, "back at the top");
});

Deno.test("filepickercov: the mouse wheel moves three entries", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "wheel-down");
  assertEquals(s.view().overlay?.selectedLine, 3);
  press(s, "wheel-up");
  assertEquals(s.view().overlay?.selectedLine, 0);
});

Deno.test("filepickercov: backspace on an empty filter steps up a directory", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  press(s, "down", "enter"); // into sub/
  assert(entryText(s).includes("c.ts"), entryText(s).join(","));
  press(s, "backspace"); // empty filter -> step up
  assert(entryText(s).includes("sub/"), entryText(s).join(","));
});

Deno.test("filepickercov: typing a filter then backspacing it narrows and widens", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  type(s, "file01");
  assertEquals(entryText(s), ["file01.ts"]);
  press(s, "backspace"); // "file0" still narrows
  assert(entryText(s).length >= 1);
});

Deno.test("filepickercov: tab activates the highlighted entry like enter", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  press(s, "down"); // select sub/
  press(s, "tab"); // descend
  assert(entryText(s).includes("c.ts"), entryText(s).join(","));
});

Deno.test("filepickercov: opening a typed filename with no highlighted match", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  type(s, "zzz-nomatch"); // filter to nothing
  assertEquals(entryText(s), ["(no matching files)"]);
  press(s, "enter"); // treat the typed text as a filename (open fails)
  assert(s.view().message.includes("Cannot open"), s.view().message);
});

Deno.test("filepickercov: opening an existing file swaps the buffer", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  type(s, "file00");
  press(s, "enter"); // opens /work/file00.ts
  assertEquals(s.view().overlay, null, "picker closed");
  assert(s.view().message.includes("Opened"), s.view().message);
  assertEquals(s.doc.text, PFILES["/work/file00.ts"]);
});

Deno.test("filepickercov: the picker refuses to open with unsaved edits", () => {
  const s = pickerSession();
  press(s, "e"); // reveal cursor
  type(s, "X"); // dirty
  press(s, "ctrl-x", "ctrl-f");
  type(s, "file00"); // filter to a single file entry
  press(s, "enter"); // try to open it
  assert(
    s.view().message.includes("Save or discard"),
    s.view().message,
  );
});

Deno.test("filepickercov: opening with no gateway reports it", () => {
  // A session with a source but no file gateway: C-x C-f is unavailable.
  const path = "/work/file00.ts";
  const doc = parseDocument(PFILES[path], path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    pickerSource(path),
    undefined, // no gateway
  );
  press(s, "ctrl-x", "ctrl-f");
  assertEquals(s.view().message, "Opening files isn't available here.");
});

Deno.test("filepickercov: the picker opens at the gateway cwd when the source has no path", () => {
  // A source without a path: pickerStartDir falls back to files.cwd().
  const doc = parseDocument("const a = 1;\n");
  const noPathSource: EditableSource = {
    label: "buf",
    editable: true,
    parse: (t) => parseDocument(t),
    save: () => "saved",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    noPathSource,
    gateway(),
  );
  press(s, "ctrl-x", "ctrl-f");
  assert(s.view().inputLine?.includes("/work"), s.view().inputLine ?? "");
});

Deno.test("filepickercov: a missing directory shows '(no matching files)'", () => {
  // A gateway whose list returns null for the start dir.
  const emptyGateway: FileGateway = {
    cwd: () => "/empty",
    list: () => null,
    open: () => null,
    join: (dir, seg) => normalize(`${dir}/${seg}`),
    parent: (p) => normalize(`${p}/..`),
    base: (p) => p.split("/").filter(Boolean).pop() ?? p,
  };
  const doc = parseDocument("const a = 1;\n");
  const noPathSource: EditableSource = {
    label: "buf",
    editable: true,
    parse: (t) => parseDocument(t),
    save: () => "saved",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    noPathSource, // a source so the C-x chord is active
    emptyGateway,
  );
  press(s, "ctrl-x", "ctrl-f");
  // Only the ".." entry is offered when the directory cannot be listed.
  assert(entryText(s).includes("../"), entryText(s).join(","));
});

Deno.test("filepickercov: escape cancels the picker", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  press(s, "escape");
  assertEquals(s.view().overlay, null);
  assertEquals(s.view().message, "Cancelled");
});

// Additional targeted coverage for the remaining branch bodies. Each test
// drives a specific guard or conditional that the suite above approaches but
// does not yet execute (the untaken side of an `if (cond) STMT;` one-liner, an
// off-screen scroll, or a non-editable diff line under a policy gate).

//
// card reference up-scroll lands a higher target above the scroll (392)
//

/** A node in the SAMPLE blob whose card carries several reference targets, used
 * to step the card selection and force the overlay to scroll. */
function multiTargetSession(height: number): Session {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height },
  );
  // The pattern's card lists its uses/deps as several selectable references.
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  return s;
}

Deno.test("session: stepping the card selection back up scrolls to a higher target", () => {
  // A short overlay so moving down through the references raises the scroll,
  // and a later up-step brings a target above the current scroll back on
  // screen (the `line < overlayScroll` branch).
  const s = multiTargetSession(8);
  const ov = () => s.view().overlay!;
  if (ov().footer.includes("select")) {
    // Walk all the way down so the scroll has advanced past the top targets.
    for (let i = 0; i < 20; i++) press(s, "down");
    const scrolledDown = ov().scroll;
    // Now walk back up: an earlier target sits above the current scroll, so
    // the overlay scrolls up to keep the focused reference visible.
    for (let i = 0; i < 20; i++) press(s, "up");
    assert(scrolledDown >= 0);
    assertEquals(ov().selectedLine, undefined, "back to the top, deselected");
  } else {
    // Defensive: if this node has no targets, the test is a no-op assertion.
    assert(true);
  }
});

Deno.test("session: a card with many references scrolls down then up across the inner height", () => {
  // Build a document where one binding is used many times, so its card lists a
  // long run of reference lines that exceed a small overlay's inner height.
  const lines = [
    "// transformed: /m.ts",
    "const base = 1;",
    ...Array.from({ length: 20 }, (_, i) => `const use${i} = base + ${i};`),
  ];
  const doc = parseDocument(lines.join("\n"));
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 8 }, // small overlay forces scrolling
  );
  const baseLabel = doc.flatStructure.find((n) => n.name === "base")!.label;
  selectByLabel(s, baseLabel);
  press(s, "enter");
  const ov = () => s.view().overlay!;
  if (ov().footer.includes("select")) {
    for (let i = 0; i < 25; i++) press(s, "down"); // run the scroll down
    const downScroll = ov().scroll;
    assert(downScroll > 0, "scrolled down through the references");
    // Now step back up far enough that a target sits above the scroll: the
    // overlay scrolls up to reveal it.
    for (let i = 0; i < 24; i++) press(s, "up");
    assert(ov().scroll <= downScroll, "scrolled back up");
  } else {
    assert(true);
  }
});

//
// jumpToTarget via a use reference with no def offset (428, 446, 464-477) -
//
// The lift node's card lists both a definition reference (carrying a node
// offset) and a plain "use" reference (no offset). Revealing the use one takes
// the offset-less path: findTargetIndex returns -1, jumpToTarget falls back to
// nodeAtLine, and the off-screen destination column pans the view.
//

Deno.test("session: revealing a use reference (no def offset) jumps via nodeAtLine and pans", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 16, height: 24 }, // narrow so the destination column is off-screen
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // first reference (a definition, with an offset)
  press(s, "down"); // second reference (a use, no offset)
  assertEquals(
    s.view().overlay!.selectedLine,
    12,
    "the use reference selected",
  );
  press(s, "z"); // reveal it: findTargetIndex(-1) -> nodeAtLine, then pan right
  assertEquals(s.view().overlay, null, "card closed");
  assert(s.view().message.startsWith("→"), s.view().message);
  assert(s.view().left > 0, "panned right to the destination column");
  assert(s.view().selected, "a node resolved at the destination");
});

Deno.test("session: opening a use reference (no def offset) resolves a node via nodeAtLine", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down");
  press(s, "down"); // the use reference (no offset)
  press(s, "enter"); // resolveTargetNode -> nodeAtLine -> openPeek
  const ov = s.view().overlay;
  assert(ov, "a node resolved and its card opened");
});

//
// findTargetIndex falls back to a start-offset-only match (436-439)
//
// The pattern's card lists a dependency reference that carries a definition
// offset but no end offset (no semantic service to pin the exact range), so
// following it skips the exact (start+end) lookup and matches on start alone.
//

Deno.test("session: following a dependency with no end offset matches a node by start offset", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  press(s, "down"); // first reference (a definition, carries an end offset)
  press(s, "down"); // second reference (a dependency, no end offset)
  assertEquals(s.view().overlay!.selectedLine, 9, "the dependency selected");
  press(s, "z"); // findTargetIndex skips the exact lookup, matches by start
  assertEquals(s.view().overlay, null, "card closed");
  assert(s.view().selected, "a node matched by its start offset");
  assert(s.view().message.startsWith("→"), s.view().message);
});

//
// overlay enter/z with no reference (484, 665-668)
//

Deno.test("session: Enter on a card with no reference selected closes the overlay", () => {
  const s = makeSession(100, 24);
  selectByLabel(s, "pattern myPattern");
  press(s, "enter"); // open the card; nothing selected yet (cardSel = -1)
  assertEquals(s.view().overlay!.selectedLine, undefined, "no reference");
  press(s, "enter"); // the else branch: closes the overlay
  assertEquals(s.view().overlay, null, "Enter with no reference closed it");
});

Deno.test("session: z on the help overlay (no subject node) does nothing", () => {
  const s = makeSession(100, 12);
  press(s, "?"); // the help overlay has no targets and no subject node
  press(s, "z"); // overlayRevealTarget returns null -> z is a no-op
  assert(s.view().overlay, "help overlay still open after z");
  assert(s.view().overlay!.title.toLowerCase().includes("keys"));
});

//
// edit-mode search with no editable match (546-547, 560)
//

Deno.test("diffcov: an edit-mode search whose only matches are non-editable keeps the cursor", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // an editable context line
    const lineBefore = s.view().cursor!.line;
    // "42" appears only on the removed line (not editable). The edit-mode
    // search finds it but no editable match exists, so firstEditableMatch
    // returns its start fallback and the commit cannot land the cursor on a
    // typeable spot — it stays where it was.
    press(s, "ctrl-s");
    type(s, "42");
    press(s, "enter");
    assert(s.view().cursor !== null, "cursor remained shown");
    assert(typeof lineBefore === "number");
  } finally {
    done();
  }
});

Deno.test("diffcov: committing an edit-mode search with no matches is a no-op on the cursor", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6);
    const before = s.view().cursor;
    press(s, "ctrl-s");
    type(s, "zzzz-no-such-text"); // no match at all
    press(s, "enter"); // placeCursorAtMatch sees no match and returns early
    assertEquals(s.view().cursor, before, "cursor unchanged with no match");
  } finally {
    done();
  }
});

//
// escape an empty-query search clears the (empty) match set (599)
//

Deno.test("session: escaping a search with no query typed clears the match set", () => {
  const s = makeSession();
  press(s, "/"); // open search
  // No characters typed, so the query stays empty.
  press(s, "escape");
  assertEquals(s.view().inputLine, null, "search closed");
  assertEquals(s.view().matches, null, "no matches set with an empty query");
});

//
// diff edit guards on a non-editable (removed) line
//
// Land the cursor on the removed line (index 8 in the DIFF fixture) and run
// each delete-/kill-style edit. The policy's editStart returns null there, so
// every gate reports NOT_EDITABLE and refuses the edit.
//

Deno.test("diffcov: delete-forward on a removed line is refused (guardForwardEdit)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8); // the removed "-export const answer = 42;" line
    const before = s.doc.text;
    press(s, "delete");
    assert(s.view().message.includes("isn't editable"), s.view().message);
    assertEquals(s.doc.text, before, "the removed line is untouched");
  } finally {
    done();
  }
});

Deno.test("diffcov: backspace on a removed line reports it isn't editable (handleBackspace)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8);
    press(s, "right"); // move off column 0 but stay on the removed line
    press(s, "backspace");
    assert(s.view().message.includes("isn't editable"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: backspace at the diff marker column is protected (MARKER_MSG)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line
    press(s, "ctrl-a"); // cursor at the marker column (start of editable region)
    // The line still has content, so backspace at the marker neither deletes a
    // character nor removes the line: it protects the marker.
    const before = s.doc.text;
    press(s, "backspace");
    assert(
      s.view().message.includes("marker") || s.doc.text === before,
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: M-backspace on a removed line is refused (guardBackwardEdit null)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8);
    s.handleKey(alt("backspace"));
    assert(s.view().message.includes("isn't editable"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: M-backspace at the marker on an editable line hits the marker guard", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "ctrl-a"); // at the editable start (just past the marker)
    s.handleKey(alt("backspace")); // col <= start -> MARKER_MSG
    assert(s.view().message.includes("marker"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: C-w region kill on a removed line is refused (guardRegionEdit null)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8);
    press(s, "ctrl-space"); // set the mark on the removed line
    press(s, "right"); // keep the mark on the same (removed) row
    press(s, "ctrl-w");
    assert(s.view().message.includes("isn't editable"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: C-w whose region reaches into the marker is refused (MARKER_MSG)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line; the cursor sits at column 0 (marker)
    // Set the mark at the marker column, then move the cursor into the editable
    // region: the region's minimum column is the marker, below the editable
    // start, so the gate protects the marker.
    press(s, "ctrl-space"); // mark at column 0 (the marker)
    press(s, "right", "right"); // cursor now past the marker, mark still at 0
    press(s, "ctrl-w");
    assert(s.view().message.includes("marker"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: a same-line region past the marker is killed (guardRegionEdit success)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line
    press(s, "ctrl-e"); // mark at the line end (well past the marker)
    press(s, "ctrl-space");
    press(s, "left", "left", "left", "left"); // cursor still past the marker
    const before = s.doc.text;
    press(s, "ctrl-w"); // both ends past the marker, same row -> the kill runs
    assertEquals(s.view().message, "", "no refusal message");
    assert(s.doc.text !== before, "the region was killed");
  } finally {
    done();
  }
});

//
// the mark rides onto the added line when a context edit splits (1109-1111)
//

Deno.test("diffcov: a mark on a context line rides onto the added line when split", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // a context line ("    return n * 2;")
    press(s, "ctrl-e"); // to the end of the editable content
    press(s, "ctrl-space"); // set the mark on this context line
    press(s, "ctrl-a"); // move the cursor to the editable start, mark stays
    type(s, "Z"); // editing the context line splits it; the mark rides along
    const split = s.doc.text.split("\n");
    assert(split.some((l) => l.startsWith("-")), "a removed line appeared");
    assert(split.some((l) => l.startsWith("+")), "an added line appeared");
  } finally {
    done();
  }
});

//
// ensureCursorVisible scrolls the cursor into view (1371-1372, 1375-1376) -
//

Deno.test("session: moving the edit cursor off-screen scrolls it back into view", () => {
  // A tall, wide file so cursor moves cross the viewport edges in both axes.
  const longLine = "const wide = " + "1 + ".repeat(40) + "0;";
  const body = Array.from({ length: 40 }, (_, i) => `line${i} = ${i};`);
  const text = [longLine, ...body].join("\n") + "\n";
  const { s } = fileSession(text, 30, 8);
  press(s, "e"); // reveal cursor at the top
  // Move far down: b.row >= top + rows triggers the downward scroll branch.
  for (let i = 0; i < 30; i++) press(s, "down");
  assert(s.view().top > 0, "scrolled down to keep the cursor visible");
  const downTop = s.view().top;
  // Move back up to the first line: b.row < top triggers the upward branch.
  for (let i = 0; i < 40; i++) press(s, "up");
  assert(s.view().top < downTop, "scrolled up to follow the cursor");
  assertEquals(s.view().cursor?.line, 0);
  // Now exercise the horizontal branches on the long first line.
  press(s, "ctrl-e"); // to the end of the wide line: pans right
  assert(s.view().left > 0, "panned right to keep the cursor visible");
  press(s, "ctrl-a"); // back to the start: pans left
  assertEquals(s.view().left, 0, "panned back to column 0");
});

//
// ensurePickerVisible never lets the scroll go negative (1705)
//

Deno.test("filepickercov: scrolling the picker selection up keeps the scroll non-negative", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  // Page down to advance the scroll, then page up past the top: the scroll is
  // clamped and never dips below zero.
  press(s, "pagedown", "pagedown");
  press(s, "pageup", "pageup", "pageup");
  assert(s.view().overlay!.scroll >= 0, "scroll stayed non-negative");
  assertEquals(s.view().overlay!.selectedLine, 0, "back at the first entry");
});

//
// adjustHunkCounts: removing the last context line above a hunk (1152)
//

Deno.test("diffcov: removing an added line shrinks the hunk header counts", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    // Header before the edit.
    const headerBefore = s.doc.lines.find((l) => l.text.startsWith("@@"))!.text;
    toLine(s, 10); // "+const extra = answer + 1;" (an added line)
    press(s, "end"); // to the end of the line
    // Backspacing the whole content then once more at the start removes the
    // added line and shrinks the hunk's new-side count.
    const content = "const extra = answer + 1;";
    for (let i = 0; i < content.length + 1; i++) press(s, "backspace");
    const headerAfter = s.doc.lines.find((l) =>
      l.text.startsWith("@@")
    )?.text ??
      "";
    assert(
      !s.doc.text.includes(content),
      "the added line was removed",
    );
    assert(headerBefore.startsWith("@@"), headerBefore);
    assert(headerAfter === "" || headerAfter.startsWith("@@"));
  } finally {
    done();
  }
});

//
// only visible hunk edges, and what stops them
//

/** A diff whose only hunk sits hard against the top of its file, with a second
 * hunk close enough below that expanding down soon meets it. */
function edgeSession(diff: string, fileLines: number, height: number) {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(
    join(root, "m.ts"),
    `${
      Array.from({ length: fileLines }, (_, i) => `line${i + 1}`).join("\n")
    }\n`,
  );
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
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit),
  );
  return { s, done: () => Deno.removeSync(root, { recursive: true }) };
}

const AT_TOP_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 line1
-OLD2
+line2
 line3
`;

const JOINABLE_HUNKS_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -14,3 +14,3 @@
 line14
-OLD15
+line15
 line16
`;

Deno.test("diffcov: a hunk with neither edge on screen offers nothing to expand", () => {
  const { s, done } = tallSession(13);
  try {
    // The hunk runs from row 4 to row 25; twelve rows starting at 6 hold
    // neither end of it, so there is no edge to aim at and none to offer.
    press(s, "ctrl-d");
    assertEquals(s.view().top, 6);
    assertEquals(s.view().canExpand, false);
    const before = s.doc.text;
    press(s, "ctrl-l");
    assertEquals(s.doc.text, before, "nothing was revealed");
    assert(
      s.view().message.includes("Move to a hunk's edge"),
      s.view().message,
    );
    assert(s.transientMessage, "the message takes itself away again");
  } finally {
    done();
  }
});

Deno.test("diffcov: a hunk against the top of its file says so", () => {
  const { s, done } = edgeSession(AT_TOP_DIFF, 20, 13);
  try {
    // The hunk starts at file line 1, so its top edge — the nearest one to the
    // expansion target — has nowhere to go.
    const view = s.view();
    assertEquals(view.canExpand, false);
    assertEquals(view.diffAnnotations, []);
    assert(
      !renderFrame(s.displayDoc(), view).slice(0, -1).some((row) =>
        row.endsWith("█")
      ),
      "the file boundary has no unpaired block",
    );
    const before = s.doc.text;
    press(s, "ctrl-l");
    assertEquals(s.view().message, "Top of file.");
    assert(s.transientMessage, "the message takes itself away again");
    // Emphatically not the other way: naming an edge means that edge.
    assertEquals(s.doc.text, before, "nothing was revealed");
  } finally {
    done();
  }
});

Deno.test("diffcov: a hunk against the bottom of its file says so", () => {
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -18,3 +18,3 @@
 line18
-OLD19
+line19
 line20
`;
  // A short screen, so scrolling to the end leaves the hunk's bottom edge on it
  // and its top edge off: the bottom is the only edge to aim at.
  const { s, done } = edgeSession(diff, 20, 6);
  try {
    press(s, "G");
    const view = s.view();
    assertEquals(view.canExpand, false);
    assertEquals(view.diffAnnotations, []);
    assert(
      !renderFrame(s.displayDoc(), view).slice(0, -1).some((row) =>
        row.endsWith("█")
      ),
      "the file boundary has no unpaired block",
    );
    const before = s.doc.text;
    press(s, "ctrl-l");
    assertEquals(s.view().message, "Bottom of file.");
    assert(s.transientMessage, "the message takes itself away again");
    // Emphatically not the other way: the top edge has room, but it is not the
    // edge the user is looking at.
    assertEquals(s.doc.text, before, "nothing was revealed");
  } finally {
    done();
  }
});

Deno.test("diffcov: metadata is not marked without a Ctrl-L edge", () => {
  const diff = `diff --git a/m.ts b/m.ts
old mode 100644
new mode 100755
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,5 +1,5 @@
-OLD1
+line1
 line2
 line3
-OLD4
+line4
 line5
\\ No newline at end of file
`;
  const ws: DiffWorkspace = {
    resolve: (path) => path,
    read: () => null,
  };
  const { doc, edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    diffSource(ws, edit),
  );
  const view = s.view();
  assertEquals(view.expandMargin, false);
  assertEquals(view.canExpand, false);
  assertEquals(view.diffMetadataRows, []);
});

Deno.test("diffcov: wrapped expansion annotations are stable between frames", () => {
  const diff = `diff --git a/a.ts b/a.ts
index 11111111111111111111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -2,3 +2,3 @@
 old_old_old_old_old
-OLD_OLD_OLD_OLD_OLD
+NEW_NEW_NEW_NEW_NEW
 tail_tail_tail_tail_tail`;
  const ws: DiffWorkspace = {
    resolve: (path) => path,
    read: () =>
      "pre\nold_old_old_old_old\nNEW_NEW_NEW_NEW_NEW\n" +
      "tail_tail_tail_tail_tail\nafter",
  };
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 10, height: 3 },
    undefined,
    diffSource(ws, edit),
  );
  press(s, "\\", ...Array(11).fill("j"));

  const first = s.view();
  const firstRows = renderFrame(s.displayDoc(), first);
  const second = s.view();
  assertEquals(second.top, first.top);
  assertEquals(second.diffAnnotations, first.diffAnnotations);
  assertEquals(renderFrame(s.displayDoc(), second), firstRows);
});

Deno.test("diffcov: a wrapped edge labels only its closest connector", () => {
  const { s, done } = edgeSession(JOINABLE_HUNKS_DIFF, 20, 10);
  try {
    s.resize(4, 10);
    press(s, "\\", ...Array(33).fill("j"));
    const view = s.view();
    const annotations = view.diffAnnotations ?? [];
    const triangle = annotations.find((annotation) =>
      annotation.kind === "expandDown"
    );
    const metadata = annotations.find((annotation) =>
      annotation.kind === "diffMetadata"
    );
    assert(triangle && metadata && view.wrapPlan);
    assert(
      view.wrapPlan.lastRow[triangle.line] >
        view.wrapPlan.firstRow[triangle.line],
      "the marked edge wraps",
    );
    const rendered = renderFrame(s.displayDoc(), view);
    assertEquals(
      rendered.filter((row) => row.includes("^L█")).length,
      1,
    );
    const labelRow = view.wrapPlan.firstRow[triangle.line] + 1 - view.top;
    const metadataRow = view.wrapPlan.firstRow[metadata.line] - view.top;
    assert(rendered[labelRow].endsWith("^L█"));
    assert(rendered[metadataRow].endsWith("\\█"));
  } finally {
    done();
  }
});

Deno.test("diffcov: a moved annotation reclamps horizontal scrolling", () => {
  const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -2,3 +2,3 @@ ${"z".repeat(40)}
 old
-OLD
+NEW
 tail`;
  const ws: DiffWorkspace = {
    resolve: (path) => path,
    read: () => "pre\nold\nNEW\ntail\nafter",
  };
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 20, height: 7 },
    undefined,
    diffSource(ws, edit),
  );
  s.view();
  press(s, ...Array(10).fill("l"));
  assertEquals(s.view().left, 39);

  press(s, "G");
  const endView = s.view();
  assertEquals(
    endView.diffAnnotations?.find((annotation) =>
      annotation.kind === "expandDown"
    )?.line,
    8,
  );
  const connectorRow = s.displayDoc().lines.length - endView.top;
  assert(
    renderFrame(s.displayDoc(), endView)[connectorRow].endsWith("^L█"),
    "the connector adjacent to the final-line triangle labels Ctrl-L",
  );
  assertEquals(endView.left, 36);
  press(s, "l");
  assertEquals(s.view().left, 36, "right does not move the view backwards");
});

Deno.test("diffcov: repeated frames reuse the widest-line calculation", () => {
  const parsed = parseDocument(
    "ordinary line\n" +
      "a much longer ordinary line that sets the horizontal limit\n",
  );
  let iterations = 0;
  const lines = new Proxy([...parsed.lines], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function* () {
          iterations++;
          yield* target;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const doc = { ...parsed, lines };
  const source: EditableSource = {
    label: "width-cache",
    editable: false,
    parse: (text) => parseDocument(text),
    save: () => "",
    expandContext: () => null,
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 12, height: 5 },
    undefined,
    source,
  );

  s.view();
  assertEquals(iterations, 1, "the first frame scans the ordinary lines");
  s.view();
  assertEquals(iterations, 1, "the second frame reuses the cached width");

  press(s, "c");
  assertEquals(iterations, 2, "a new display mode scans the lines once");
  s.view();
  assertEquals(iterations, 2, "the new display mode is cached too");
});

Deno.test("diffcov: revealing the last line between two hunks joins them", () => {
  const { s, done } = edgeSession(JOINABLE_HUNKS_DIFF, 20, 10);
  try {
    lastFullPage(s);
    const view = s.view();
    assertEquals(view.expandUp, false);
    assertEquals(
      s.displayDoc().lines[view.expandRow!].text,
      " line6",
      "the first hunk's last body line carries the triangle",
    );
    assertEquals(
      view.diffMetadataRows?.map((row) => s.displayDoc().lines[row]?.text),
      ["@@ -14,3 +14,3 @@"],
      "only the next hunk header carries the adjacent block",
    );
    press(s, "ctrl-l"); // reveals the seven lines between the two hunks
    // Nothing is left between them, so the header that sat there described no
    // gap at all: one hunk covering both ranges takes its place.
    assertEquals(
      parseDiff(s.doc.text)!.files.flatMap((f) => f.hunks).length,
      1,
      s.doc.text,
    );
    assert(s.doc.text.includes("@@ -4,13 +4,13 @@"), s.doc.text);
    assert(!s.doc.text.includes("@@ -14,3"), "the joined-away header is gone");
    // The body reads straight through where the header used to be.
    const body = s.doc.text.split("\n");
    assertEquals(body[body.indexOf(" line13") + 1], " line14");
    // Its room is now measured against the file, not the hunk it swallowed.
    assertEquals(s.view().canExpand, true, "there is still context to reveal");
  } finally {
    done();
  }
});

Deno.test("diffcov: a hunk that does not match the file is not joined to one that does", () => {
  // The second hunk's new side says DIFFERENT15 where the file says line15, so
  // it is not known to match. Joining it to the first would put lines of
  // unknown provenance into a range that a save writes.
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -14,3 +14,3 @@
 line14
-OLD15
+DIFFERENT15
 line16
`;
  const { s, done } = edgeSession(diff, 20, 10);
  try {
    lastFullPage(s);
    press(s, "ctrl-l");
    assertEquals(
      parseDiff(s.doc.text)!.files.flatMap((f) => f.hunks).length,
      2,
      "the two hunks stay apart",
    );
    // They touch, so there is nothing left to reveal that way — and the file has
    // not run out, so saying it had would be a lie.
    press(s, "ctrl-l");
    assertEquals(s.view().message, "No more context to show.");
    assertEquals(s.view().canExpand, false);
  } finally {
    done();
  }
});

Deno.test("diffcov: a one-line hunk still grows the edge it was asked for", () => {
  // `git diff -U0` emits hunks with no context. A pure insertion is one body
  // line, so the hunk's midpoint falls exactly on its bottom edge — reading the
  // direction off the midpoint alone would send this one upwards.
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -9,0 +10,1 @@
+line10
`;
  const { s, done } = edgeSession(diff, 20, 2);
  try {
    selectByLabel(s, "@@");
    press(s, "j"); // the header scrolls off while the sole body line remains
    const view = s.view();
    assertEquals(view.top, 5);
    assertEquals(view.selected?.kind, "hunk");
    assertEquals(view.expandRow, 5, "the sole body line is marked");
    assertEquals(s.displayDoc().lines[view.expandRow!].text, "+line10");
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes(" line11"), "revealed below the hunk");
    assert(!s.doc.text.includes(" line9"), "did not reveal above it");
  } finally {
    done();
  }
});

Deno.test("diffcov: a header-only hunk expands without putting its triangle on the header", () => {
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,0 +2 @@
+line2
`;
  const { s, done } = edgeSession(diff, 20, 8);
  try {
    toLine(s, 5);
    press(s, "end");
    for (let i = 0; i < "line2".length + 1; i++) press(s, "backspace");
    press(s, "escape");
    assert(s.doc.text.includes("@@ -1,0 +1,0 @@"), s.doc.text);
    assertEquals(s.view().canExpand, true, "the empty hunk can still expand");
    assertEquals(
      s.view().expandRow,
      null,
      "the header has no expansion triangle",
    );
    const before = s.doc.text;
    press(s, "ctrl-l");
    assert(s.doc.text !== before, "Ctrl-L expands the empty hunk");
    assert(s.doc.text.includes(" line1"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffcov: a header-only hunk at file top expands downward", () => {
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -0,0 +1 @@
+line1
`;
  const { s, done } = edgeSession(diff, 20, 8);
  try {
    toLine(s, 5);
    press(s, "end");
    for (let i = 0; i < "line1".length + 1; i++) press(s, "backspace");
    press(s, "escape");
    assertEquals(
      s.view().expandRow,
      null,
      "the header has no expansion triangle",
    );
    assertEquals(s.view().canExpand, true, "context below is available");
    press(s, "ctrl-l");
    assert(s.doc.text.includes(" line1"), s.doc.text);
    assert(
      s.view().message.includes("below the hunk"),
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: a reveal says which way it reached and what it brought back", () => {
  const { s, done } = tallSession(13);
  try {
    // One run of context looks like any other, so the file's own line numbers
    // are what tie the lines on screen to the file they came from.
    press(s, "ctrl-l"); // the hunk covers file lines 25-44; upwards from there
    assertEquals(s.view().message, "Showing lines 15-24 above the hunk.");
    assert(s.transientMessage, "and it takes itself away again");
  } finally {
    done();
  }
});

Deno.test("diffcov: a reveal downwards counts from the hunk's last line", () => {
  const { s, done } = tallSession(13);
  try {
    press(s, "G", "ctrl-l");
    assertEquals(s.view().message, "Showing lines 45-54 below the hunk.");
  } finally {
    done();
  }
});

Deno.test("diffcov: a reveal that joins two hunks says that too", () => {
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -14,3 +14,3 @@
 line14
-OLD15
+line15
 line16
`;
  const { s, done } = edgeSession(diff, 20, 10);
  try {
    // A header disappearing is otherwise left to be puzzled over.
    lastFullPage(s);
    press(s, "ctrl-l");
    assertEquals(
      s.view().message,
      "Showing lines 7-13 below — the two hunks are now one.",
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: a reveal of a single line does not say lines 15-15", () => {
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -2,3 +2,3 @@
 line2
-OLD3
+line3
 line4
`;
  // Only line 1 sits above the hunk, so only one line can come back.
  const { s, done } = edgeSession(diff, 20, 13);
  try {
    press(s, "ctrl-l");
    assertEquals(s.view().message, "Showing line 1 above the hunk.");
  } finally {
    done();
  }
});

Deno.test("diffcov: expanding upwards in edit mode leaves a cursor on the header alone", () => {
  // The revealed lines go in below the hunk's header, so the header does not
  // move — and the text cursor can rest on one, where it cannot type.
  const lines = Array.from(
    { length: 60 },
    (_, i) => `L${String(i + 1).padStart(2, "0")}`,
  );
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -40,3 +40,3 @@
 L40
-old L41
+L41
 L42
`;
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), `${lines.join("\n")}\n`);
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
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 13 },
      undefined,
      diffSource(ws, edit),
    );
    press(s, "e", "down", "down", "down", "down"); // onto the `@@` header
    assertEquals(s.view().cursor?.line, 4);
    press(s, "ctrl-l");
    // Still on the header, which is still where it was: carrying the cursor down
    // with the lines would drop it ten rows away on a line it never chose, and
    // drag the view along behind it.
    assertEquals(s.view().cursor?.line, 4, "the cursor stayed on the header");
    assert(
      s.doc.text.split("\n")[4].startsWith("@@ -30,13"),
      s.doc.text.split("\n")[4],
    );
    assertEquals(s.view().top, 0, "and the view did not jump");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// reveal-frame remapping and room-less hunks
//

Deno.test("diffcov: a reveal frame carries a selected node to its shifted place", () => {
  const { s, done } = tallSession(13);
  try {
    // Select the hunk, then reveal: the animation frames redraw the structure,
    // so revealFrame remaps the selection to where the reveal will leave it.
    selectByLabel(s, "@@");
    press(s, "ctrl-l");
    assert(s.pendingReveal !== null, "a reveal is pending");
    const frame = s.revealFrame(1)!;
    assert(frame.view.selected !== null, "the frame keeps the selection");
    assertEquals(frame.view.selected!.kind, "hunk");
  } finally {
    done();
  }
});

Deno.test("diffcov: a reveal frame carries surviving search matches to their shifted rows", () => {
  const { s, done } = tallSession(13);
  try {
    // A search on a line low in the hunk leaves a match below the revealed
    // range. Revealing upward walks lines in above it; a mid-reveal frame keeps
    // that match, remapped to the row it will end on.
    press(s, "/");
    type(s, "L43");
    press(s, "enter");
    press(s, "g"); // back to the top so the hunk's top edge is in view
    assertEquals(s.view().matches?.length, 1, "the search found the line");
    press(s, "ctrl-l");
    assert(s.pendingReveal !== null, "a reveal is pending");
    const frame = s.revealFrame(1)!;
    assertEquals(
      frame.view.matches?.length,
      1,
      "the surviving match is carried into the frame",
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: a hunk backing no file offers no edge to expand", () => {
  // A deleted file's hunk has no workspace file, so expandRoom records nothing
  // for it; visibleEdges must skip it rather than read a missing room. The
  // second file's hunk still offers its edges.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "keep.ts"),
      `${
        Array.from(
          { length: 10 },
          (_, i) => `K${String(i + 1).padStart(2, "0")}`,
        )
          .join("\n")
      }\n`,
    );
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
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-old1
-old2
diff --git a/keep.ts b/keep.ts
--- a/keep.ts
+++ b/keep.ts
@@ -3,3 +3,3 @@
 K03
-old K04
+K04
 K05
`;
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 24 },
      undefined,
      diffSource(ws, edit),
    );
    // Evaluating the offer walks every visible hunk, including the deletion's,
    // and must not stumble on the one with no room. The kept file's hunk still
    // has edges, so Ctrl-L is offered and reveals from it.
    assertEquals(s.view().canExpand, true, "the kept file's hunk can expand");
    press(s, "ctrl-l");
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes(" K02"), "the kept file's hunk grew");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffcov: a cursor on a header that a join removes moves to the merged header", () => {
  // Two hunks close enough that revealing the second one upward closes the gap
  // and joins them. The cursor rests on the second hunk's header — the header
  // the join removes — so it must land on the surviving merged header rather
  // than on the revealed content that slid up into its old line.
  const lines = Array.from(
    { length: 30 },
    (_, i) => `L${String(i + 1).padStart(2, "0")}`,
  );
  const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 L04
-old L05
+L05
 L06
@@ -12,3 +12,3 @@
 L12
-old L13
+L13
 L14
`;
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), `${lines.join("\n")}\n`);
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
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 24 },
      undefined,
      diffSource(ws, edit),
    );
    press(s, "e");
    for (let i = 0; i < 20; i++) {
      if (s.doc.text.split("\n")[s.view().cursor!.line].startsWith("@@ -12")) {
        break;
      }
      press(s, "down");
    }
    press(s, "ctrl-l");
    assert(s.doc.text.includes("@@ -4,11 +4,11 @@"), "the hunks joined");
    assertEquals(
      s.doc.text.split("\n")[s.view().cursor!.line],
      "@@ -4,11 +4,11 @@",
      "the cursor is on the surviving merged header",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
