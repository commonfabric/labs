/**
 * Coverage-gate tests for `lib/view/session.ts`, targeting the cross-reference
 * resolution fallbacks in `findTargetIndex` and `jumpToTarget`.
 *
 * `findTargetIndex` first tries an exact (start + end offset) match, then falls
 * back to matching a node by its start offset alone; `jumpToTarget` falls back
 * to `nodeAtLine` when neither matches. Earlier suites stepped to card targets
 * that always exact-matched, so the fallbacks never ran. These tests step to the
 * specific targets that carry only a start offset (a dependency reference) or no
 * offset at all (a plain use reference), which drive each fallback.
 */

import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { Session } from "../lib/view/session.ts";

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

/** Tab through the tree until a node whose label contains `label` is selected. */
function selectByLabel(s: Session, label: string): void {
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label?.includes(label)) return;
    press(s, "tab");
  }
  throw new Error(`node not reached: ${label}`);
}

/** Step the card selection down until the focused target's `cardLine` stops
 * changing — i.e. the last selectable reference is reached. Returns the number
 * of distinct references walked. */
function focusLastTarget(s: Session): number {
  let last = s.view().overlay!.selectedLine;
  let steps = 0;
  for (let i = 0; i < 50; i++) {
    press(s, "down");
    const cur = s.view().overlay!.selectedLine;
    if (cur === last) break;
    last = cur;
    steps++;
  }
  return steps;
}

//
// findTargetIndex start-offset-only fallback (436, 437, 439).
//

Deno.test("gate: following the last card reference (a dependency, no end offset) matches by start offset", () => {
  // The pattern's card lists a dependency on `__cfLift_1` whose target carries
  // a definition start offset but no end offset (the dependency is found
  // syntactically, with no semantic service to pin the exact range). Following
  // it skips the exact (start + end) lookup and matches the lift node by its
  // start offset alone, landing the selection on that node.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  // The lift node the dependency points at, to compare against once resolved.
  const liftNode = doc.flatStructure.find((n) =>
    n.label?.includes("__cfLift_1") && n.kind === "builder"
  )!;
  assert(liftNode, "the lift node exists in the structure");

  selectByLabel(s, "pattern myPattern");
  press(s, "enter"); // open the pattern's info card
  const card = s.view().overlay!;
  assert(
    card.footer.includes("select"),
    "the card lists selectable references",
  );

  press(s, "down"); // focus the first reference
  assert(s.view().overlay!.selectedLine !== undefined, "a reference focused");
  // Walk to the last reference: the dependency on the lift, which has no end
  // offset, so it exercises the start-offset-only fallback.
  focusLastTarget(s);

  press(s, "z"); // reveal it: findTargetIndex falls through to the start match
  assertEquals(s.view().overlay, null, "the card closed on reveal");
  assert(s.view().message.startsWith("→"), s.view().message);
  const sel = s.view().selected;
  assert(sel, "a node resolved at the dependency's start offset");
  assertEquals(
    sel!.startOffset,
    liftNode.startOffset,
    "the start-offset match landed on the lift node",
  );
});

Deno.test("gate: Enter on the dependency reference opens the start-matched node's card", () => {
  // A second, independent route to the same fallback: opening (Enter) the
  // focused dependency reference resolves its node through `resolveTargetNode`,
  // which shares `findTargetIndex`, and opens that node's card in place.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  assert(s.view().overlay!.footer.includes("select"), "references listed");
  const beforeTitle = s.view().overlay!.title;
  press(s, "down");
  focusLastTarget(s); // focus the no-end-offset dependency
  press(s, "enter"); // resolveTargetNode -> findTargetIndex start match -> openPeek
  const ov = s.view().overlay!;
  assert(ov, "the overlay stays open (navigated, not closed)");
  assert(
    ov.title !== beforeTitle,
    "the card now describes the dependency's node",
  );
});

//
// jumpToTarget nodeAtLine fallback (446).
//

Deno.test("gate: revealing the last lift reference (a use, no offset) resolves via nodeAtLine", () => {
  // The lift's card ends with a plain "use" reference that carries a
  // destination line but no definition offset at all. `findTargetIndex` returns
  // -1 for it, so `jumpToTarget` falls back to `nodeAtLine` on the destination
  // line to pick the node to select.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 16, height: 24 }, // narrow so the destination column is off-screen
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter"); // open the lift's card
  assert(s.view().overlay!.footer.includes("select"), "references listed");
  press(s, "down"); // focus the first reference
  assert(s.view().overlay!.selectedLine !== undefined, "a reference focused");
  // Walk to the last reference: the use site, which carries no offset.
  focusLastTarget(s);

  press(s, "z"); // reveal: findTargetIndex(-1) -> jumpToTarget falls to nodeAtLine
  assertEquals(s.view().overlay, null, "the card closed on reveal");
  assert(s.view().message.startsWith("→"), s.view().message);
  assert(s.view().selected, "a node resolved at the destination line");
  assert(
    s.view().left > 0,
    "the off-screen destination column panned the view",
  );
});

Deno.test("gate: Enter on the offset-less use reference resolves a node via nodeAtLine", () => {
  // Opening (Enter) the offset-less use reference resolves a node through
  // `resolveTargetNode`/`nodeAtLine` and opens its card, the complementary
  // route.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  assert(s.view().overlay!.footer.includes("select"), "references listed");
  press(s, "down");
  focusLastTarget(s); // the offset-less use reference
  press(s, "enter"); // resolveTargetNode -> nodeAtLine -> openPeek
  assert(s.view().overlay, "a node resolved and its card opened in place");
});
