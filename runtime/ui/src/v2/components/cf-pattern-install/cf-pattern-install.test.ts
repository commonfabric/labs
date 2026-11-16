// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { CFPatternInstall } from "./index.ts";
import {
  installSentence,
  installWording,
  plainName,
} from "./cf-pattern-install.ts";

/** A component mounted with `properties`. */
function installWith(
  properties: Partial<CFPatternInstall>,
): Promise<CFPatternInstall> {
  return mount(Object.assign(new CFPatternInstall(), properties));
}

/** The button a component draws. */
const button = (element: CFPatternInstall) =>
  element.shadowRoot!.querySelector("button")!;

/** The words a component shows, with whitespace collapsed as a page shows it. */
const shown = (element: CFPatternInstall) =>
  button(element).textContent!.replace(/\s+/g, " ").trim();

/**
 * A click as a person's tap or Enter makes it, which the browser marks
 * `isTrusted`; the test document cannot make one, so the mark is set on the
 * event itself.
 */
function trustedClick(): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

/** A scripted click event, as a page's own code makes one. */
const scriptedClick = () =>
  new MouseEvent("click", { bubbles: true, composed: true });

/** Dispatches `event` on `target` and returns how many times the host's own
 * click listener saw it, as a pattern's `onClick` would. */
function hostSees(
  element: CFPatternInstall,
  target: EventTarget,
  event: Event,
): number {
  let seen = 0;
  const onClick = () => seen++;
  element.addEventListener("click", onClick);
  target.dispatchEvent(event);
  element.removeEventListener("click", onClick);
  return seen;
}

describe("CFPatternInstall", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-pattern-install`", () => {
    expect(customElements.get("cf-pattern-install")).toBe(CFPatternInstall);
  });

  it("takes no text for its button", () => {
    const inputs = Object.keys(CFPatternInstall.properties).sort();
    expect(inputs).toEqual([
      "author",
      "destinationName",
      "disabled",
      "patternId",
      "patternTitle",
    ]);
  });

  describe("render()", () => {
    it("says which pattern it installs onto which loom", async () => {
      const element = await installWith({
        patternId: "split-1",
        patternTitle: "Bill splitter",
        destinationName: "Home",
      });
      expect(shown(element)).toBe("Install “Bill splitter” onto Home");
      expect(button(element).getAttribute("aria-label")).toBe(
        "Install “Bill splitter” onto Home",
      );
    });

    it("names the author when it is given", async () => {
      const element = await installWith({
        patternTitle: "Bill splitter",
        author: "Sam",
        destinationName: "Home",
      });
      expect(shown(element)).toBe("Install “Bill splitter” by Sam onto Home");
    });

    it("keeps a title that imitates its words inside the title's chip", async () => {
      const element = await installWith({ patternTitle: "Notes” onto Work" });
      expect(shown(element)).toBe("Install “Notes' onto Work”");
      const names = element.shadowRoot!.querySelectorAll(".name");
      expect([...names].map((name) => name.textContent)).toEqual([
        "Notes' onto Work",
      ]);
    });

    it("leaves out the loom when it has no name", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(shown(element)).toBe("Install “Bill splitter”");
    });

    it("shows the pattern id when the pattern has no title", async () => {
      const element = await installWith({
        patternId: "bafy0123abcdef0123456789ab",
        destinationName: "Home",
      });
      expect(shown(element)).toBe(
        "Install “pattern bafy0123…456789ab” onto Home",
      );
    });

    it("shows the words its inputs give after they change", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      element.patternTitle = "Reading tracker";
      element.destinationName = "Work";
      await element.updateComplete;
      expect(shown(element)).toBe("Install “Reading tracker” onto Work");
    });

    it("disables its button when disabled", async () => {
      const element = await installWith({ disabled: true });
      expect(button(element).hasAttribute("disabled")).toBe(true);
    });
  });

  describe("installWording()", () => {
    it("shows the true ends of an id longer than a name may run", () => {
      const head = "bafy" + "a".repeat(70);
      expect(installWording({ patternId: `${head}tail0001` }).pattern).toBe(
        "pattern bafyaaaa…tail0001",
      );
    });

    it("falls back to the id when the title is blank", () => {
      expect(
        installWording({ patternTitle: "  ", patternId: "split-1" }).pattern,
      )
        .toBe("pattern split-1");
    });

    it("falls back to `this pattern` with neither a title nor an id", () => {
      expect(installSentence(installWording({}))).toBe(
        "Install “this pattern”",
      );
    });
  });

  describe("plainName()", () => {
    it("flattens a name to one line without reordering characters", () => {
      expect(plainName("Bill‮splitter\nonto Work​")).toBe(
        "Bill splitter onto Work",
      );
    });

    it("keeps a name from closing its quotation", () => {
      expect(plainName("Notes” onto Work. Install “Other")).toBe(
        "Notes' onto Work. Install 'Other",
      );
    });

    it("turns quotation ornaments and paired quotes into apostrophes", () => {
      expect(plainName("❝A❞ ‹B› ‘C’ «D»")).toBe("'A' 'B' 'C' 'D'");
    });

    it("cuts a run of combining marks to two", () => {
      expect(plainName("a\u0301\u0302\u0303\u0304b")).toBe("a\u0301\u0302b");
    });

    it("cuts a long name short", () => {
      const name = plainName("x".repeat(200));
      expect([...name].length).toBe(60);
      expect(name.endsWith("…")).toBe(true);
    });
  });

  describe("clicks", () => {
    it("passes a trusted click on the button to the host", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(hostSees(element, button(element), trustedClick())).toBe(1);
    });

    it("stops a scripted click() before the host sees it", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      let seen = 0;
      element.addEventListener("click", () => seen++);
      button(element).click();
      expect(seen).toBe(0);
    });

    it("stops a synthetic click event before the host sees it", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(hostSees(element, button(element), scriptedClick())).toBe(0);
    });

    it("stops a trusted click while disabled", async () => {
      const element = await installWith({ disabled: true });
      expect(hostSees(element, button(element), trustedClick())).toBe(0);
    });

    it("stops a trusted click on the host's own box", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(hostSees(element, element, trustedClick())).toBe(0);
    });

    it("stops a second tap until the first has been handled", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      using time = new FakeTime();
      expect(hostSees(element, button(element), trustedClick())).toBe(1);
      expect(hostSees(element, button(element), trustedClick())).toBe(0);
      time.tick(0);
      expect(hostSees(element, button(element), trustedClick())).toBe(1);
    });
  });
});
