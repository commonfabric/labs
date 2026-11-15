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
  element.shadowRoot!.querySelector<HTMLElement>("cf-button")!;

/** The words a component shows, with whitespace collapsed as a page shows it. */
const shown = (element: CFPatternInstall) =>
  button(element).textContent!.replace(/\s+/g, " ").trim();

type Internals = { _onClick(event: Event): void };

/** A click that reached the component through the button, as the browser
 * marks a person's tap (`isTrusted: true`), with a stopPropagation spy. */
function tap(): Event & { stopped: boolean } {
  return {
    isTrusted: true,
    stopped: false,
    composedPath: () => [{ tagName: "BUTTON" }, { tagName: "CF-BUTTON" }],
    stopPropagation() {
      (this as { stopped: boolean }).stopped = true;
    },
  } as unknown as Event & { stopped: boolean };
}

/** Dispatches a scripted click on the button and returns whether the host's
 * own click listener saw it. */
function hostSees(element: CFPatternInstall, click: () => void): boolean {
  let seen = false;
  const onClick = () => seen = true;
  element.addEventListener("click", onClick);
  click();
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

    it("leaves out the loom when it has no name", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(shown(element)).toBe("Install “Bill splitter”");
    });

    it("shows the pattern id when the pattern has no title", async () => {
      const element = await installWith({
        patternId: "bafy0123456789abcdef",
        destinationName: "Home",
      });
      expect(shown(element)).toBe("Install “pattern bafy01234567…” onto Home");
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

    it("cuts a long name short", () => {
      const name = plainName("x".repeat(200));
      expect([...name].length).toBe(60);
      expect(name.endsWith("…")).toBe(true);
    });
  });

  describe("clicks", () => {
    it("stops a scripted click() before it reaches the host", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(hostSees(element, () => button(element).click())).toBe(false);
    });

    it("stops a synthetic click event before it reaches the host", async () => {
      const element = await installWith({ patternTitle: "Bill splitter" });
      expect(
        hostSees(element, () =>
          button(element).dispatchEvent(
            new MouseEvent("click", { bubbles: true, composed: true }),
          )),
      ).toBe(false);
    });

    it("lets a trusted tap on the button through", () => {
      const element = new CFPatternInstall();
      const event = tap();
      using _time = new FakeTime();
      (element as unknown as Internals)._onClick(event);
      expect(event.stopped).toBe(false);
    });

    it("stops a trusted tap while disabled", () => {
      const element = new CFPatternInstall();
      element.disabled = true;
      const event = tap();
      using _time = new FakeTime();
      (element as unknown as Internals)._onClick(event);
      expect(event.stopped).toBe(true);
    });

    it("stops a trusted click beside the button", () => {
      const element = new CFPatternInstall();
      const event = {
        ...tap(),
        composedPath: () => [{ tagName: "DIV" }],
      } as unknown as Event & { stopped: boolean };
      event.stopPropagation = () => event.stopped = true;
      (element as unknown as Internals)._onClick(event);
      expect(event.stopped).toBe(true);
    });

    it("stops a second tap until the first has been handled", () => {
      const element = new CFPatternInstall();
      using time = new FakeTime();
      const first = tap();
      const second = tap();
      (element as unknown as Internals)._onClick(first);
      (element as unknown as Internals)._onClick(second);
      expect(first.stopped).toBe(false);
      expect(second.stopped).toBe(true);
      time.tick(0);
      const third = tap();
      (element as unknown as Internals)._onClick(third);
      expect(third.stopped).toBe(false);
    });
  });
});
