import { debugStr } from "@commonfabric/data-model";
import {
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import {
  clickMarked,
  markTargetsArgs,
  settleAndMarkTargets,
  settleView,
} from "./cfc-browser-helpers.ts";

// Find-and-click-a-button-by-text helpers shared by the default-app
// integration tests. What this module adds is the finder below: it picks a
// button by its text, its exact text, or its title, where the finders in
// cfc-browser-helpers.ts pick one by CSS selector, by index within a selector,
// or by data-ui-action value. Settling around the match, marking it, and
// clicking it are that module's shared step, which every marked click runs.

// Serialized into the page: the first rendered, enabled button or link whose
// text or title matches, reached through its host's shadow root when the host
// wraps the control that takes the click. "Rendered" means laid out and not
// display:none/visibility:hidden — the same elements the innerText scan the
// poll used could see — and is viewport-independent, so a match below the fold
// still qualifies: the click scrolls the element into view itself. A disabled
// match is passed over: it takes no click, since the browser raises none on it
// and a `cf-button` additionally gives it `pointer-events: none`, which sends
// the press to the host that wraps it. Disabled-ness is asked of both the match
// and the control it wraps, because `disabled` does not inherit and a host can
// carry an `aria-disabled` its inner control does not. Answers `undefined`
// until such a match exists, so the wait re-checks on the next DOM mutation
// instead of the caller retrying a bare find-and-click loop. Self-contained —
// it closes over nothing in this module — so it can be serialized and run in
// the page.
const findNoteButton = (
  probe: ProbeApi,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): readonly HTMLElement[] | undefined => {
  const clickTarget = (element: Element): HTMLElement =>
    (element.shadowRoot?.querySelector("[data-cf-button]") as
      | HTMLElement
      | null) ?? element as HTMLElement;

  const target = probe.collect(selector).find((element) => {
    if (!probe.isRendered(element)) return false;
    if (probe.isDisabled(element) || probe.isDisabled(clickTarget(element))) {
      return false;
    }
    if (match === "title") return element.getAttribute("title") === needle;
    const text = (element.textContent ?? "").trim();
    return match === "exact" ? text === needle : text.includes(needle);
  });
  if (!target) return undefined;
  return [clickTarget(target)];
};

// What the finder was deciding on when the wait for it ran out.
export type NoteButtonProbe = {
  selector: string;
  match: string;
  needle: string;
  candidates: Array<{
    tagName: string;
    text: string;
    title: string | null;

    /** Whether the candidate's text or title is the one that was asked for. */
    named: boolean;
    rendered: boolean;

    /** Whether the candidate, or the control it wraps, declines a click. */
    disabled: boolean;
  }>;
};

// Every element the selector reached, with the three things the finder decides
// on. A wait that never resolves is one where no candidate satisfied all three,
// and this names which one each candidate failed — a button whose words match
// and which is sitting there disabled reads as such, rather than as a button
// that was never on the page.
export async function readNoteButtonCandidates(
  page: Page,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): Promise<NoteButtonProbe> {
  return await page.evaluate(
    (
      targetSelector: string,
      targetMatch: string,
      targetNeedle: string,
    ) => {
      const collect = (root: Document | ShadowRoot, out: Element[]): void => {
        for (const element of root.querySelectorAll("*")) {
          try {
            if (element.matches(targetSelector)) out.push(element);
          } catch {
            // Invalid selectors are reported through the empty probe.
          }
          if (element.shadowRoot) collect(element.shadowRoot, out);
        }
      };
      const declines = (candidate: Element): boolean =>
        candidate.hasAttribute("disabled") ||
        candidate.getAttribute("aria-disabled") === "true";

      const found: Element[] = [];
      collect(document, found);
      return {
        selector: targetSelector,
        match: targetMatch,
        needle: targetNeedle,
        candidates: found.map((element) => {
          const style = globalThis.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const text = (element.textContent ?? "").trim();
          const title = element.getAttribute("title");
          const inner = element.shadowRoot?.querySelector("[data-cf-button]") ??
            element;
          return {
            tagName: element.tagName.toLowerCase(),
            text: text.slice(0, 120),
            title,
            named: targetMatch === "title"
              ? title === targetNeedle
              : targetMatch === "exact"
              ? text === targetNeedle
              : text.includes(targetNeedle),
            rendered: style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 && rect.height > 0,
            disabled: declines(element) || declines(inner),
          };
        }),
      };
    },
    { args: [selector, match, needle] },
  );
}

// Settle around a matching button, tag it, and dispatch a single trusted click
// on it. Throws if no matching button becomes clickable.
async function settleAndClickNoteButton(
  page: Page,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): Promise<void> {
  const token = `cfc-note-button-${crypto.randomUUID()}`;
  const args = markTargetsArgs(findNoteButton, [selector, match, needle], [
    token,
  ]);
  try {
    await waitForCondition(page, settleAndMarkTargets, { args });
  } catch (cause) {
    const probe = await readNoteButtonCandidates(page, selector, match, needle)
      .catch(() => undefined);
    throw new Error(
      `Unable to find a ${
        match === "title" ? "button titled" : "button matching"
      } "${needle}" to click. ` +
        debugStr`Last probe: $quote,indent,long${probe}`,
      { cause },
    );
  }
  await clickMarked(page, {
    token,
    remark: { predicate: settleAndMarkTargets, args },
  });
  await settleView(page);
}

// The click helpers resolve `true` once the single click has landed (they throw
// otherwise), so the call sites that assert the click succeeded keep reading.
export async function clickButtonWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  await settleAndClickNoteButton(
    page,
    "cf-button, button, a",
    "includes",
    searchText,
  );
  return true;
}

export async function clickButtonWithExactText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  await settleAndClickNoteButton(
    page,
    "cf-button, button, a",
    "exact",
    searchText,
  );
  return true;
}

export async function clickButtonWithTitle(
  page: Page,
  title: string,
): Promise<boolean> {
  await settleAndClickNoteButton(page, "cf-button, button", "title", title);
  return true;
}
