// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { CFSecretViewer } from "./index.ts";

const SECRET = "https://example.invalid/hooks/wh_abc123";
const MASK = "•".repeat(12);

/** A viewer mounted with `properties`. */
function viewerWith(properties: Partial<CFSecretViewer> = {}) {
  return mount(Object.assign(new CFSecretViewer(), properties));
}

/** The text the viewer shows for the secret. */
const shown = (element: CFSecretViewer) =>
  element.shadowRoot!.querySelector('[part="value"]')!.textContent;

const toggle = (element: CFSecretViewer) =>
  element.shadowRoot!.querySelector("cf-button")!;

/** Clicks the reveal toggle and waits for the viewer to show the result. */
async function clickToggle(element: CFSecretViewer) {
  toggle(element).dispatchEvent(new MouseEvent("click"));
  await element.updateComplete;
}

describe("CFSecretViewer", () => {
  let time: FakeTime;
  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    document.body.replaceChildren();
    time.restore();
  });

  it("is registered as `cf-secret-viewer`", () => {
    expect(customElements.get("cf-secret-viewer")).toBe(CFSecretViewer);
  });

  describe("render()", () => {
    it("shows the secret masked but for its last four characters", async () => {
      const element = await viewerWith({ value: SECRET });
      expect(shown(element)).toBe(MASK + "c123");
      expect(toggle(element).textContent?.trim()).toBe("Reveal");
    });

    it("shows as many trailing characters as asked for", async () => {
      const element = await viewerWith({ value: SECRET, trailingChars: 8 });
      expect(shown(element)).toBe(MASK + "h_abc123");
    });

    it("shows the mask alone for no trailing characters", async () => {
      const element = await viewerWith({ value: SECRET, trailingChars: 0 });
      expect(shown(element)).toBe(MASK);
    });

    it("shows a short secret's characters after the mask, and no more", async () => {
      const element = await viewerWith({ value: "ab", trailingChars: 4 });
      expect(shown(element)).toBe(MASK + "ab");
    });

    it("shows nothing for an empty secret", async () => {
      const element = await viewerWith();
      expect(shown(element)).toBe("");
    });

    it("shows a label only when given one", async () => {
      const labeled = await viewerWith({ label: "Webhook URL" });
      expect(
        labeled.shadowRoot!.querySelector('[part="label"]')?.textContent,
      ).toBe("Webhook URL");
      const unlabeled = await viewerWith();
      expect(unlabeled.shadowRoot!.querySelector('[part="label"]')).toBeNull();
    });

    it("hands the whole secret to its copy button", async () => {
      const element = await viewerWith({ value: SECRET });
      const copy = element.shadowRoot!.querySelector("cf-copy-button");
      expect(copy).not.toBeNull();
      expect(Reflect.get(copy!, "text")).toBe(SECRET);
    });
  });

  describe("the reveal toggle", () => {
    it("shows the secret, and hides it again", async () => {
      const element = await viewerWith({ value: SECRET });
      await clickToggle(element);
      expect(shown(element)).toBe(SECRET);
      expect(toggle(element).textContent?.trim()).toBe("Hide");

      await clickToggle(element);
      expect(shown(element)).toBe(MASK + "c123");
      expect(toggle(element).textContent?.trim()).toBe("Reveal");
    });

    it("hides a revealed secret after thirty seconds", async () => {
      const element = await viewerWith({ value: SECRET });
      await clickToggle(element);
      time.tick(29_999);
      await element.updateComplete;
      expect(shown(element)).toBe(SECRET);

      time.tick(1);
      await element.updateComplete;
      expect(shown(element)).toBe(MASK + "c123");
    });

    it("leaves a secret hidden by hand hidden when the thirty seconds pass", async () => {
      const element = await viewerWith({ value: SECRET });
      await clickToggle(element);
      await clickToggle(element);
      await clickToggle(element);
      time.tick(20_000);
      await element.updateComplete;
      expect(shown(element)).toBe(SECRET);

      time.tick(10_000);
      await element.updateComplete;
      expect(shown(element)).toBe(MASK + "c123");
    });
  });

  describe("disconnected", () => {
    it("masks a revealed secret again, for when it is put back", async () => {
      const element = await viewerWith({ value: SECRET });
      await clickToggle(element);
      element.remove();
      document.body.append(element);
      await element.updateComplete;
      expect(shown(element)).toBe(MASK + "c123");
      expect(toggle(element).textContent?.trim()).toBe("Reveal");
    });

    it("stops the countdown to hiding the secret", async () => {
      const element = await viewerWith({ value: SECRET });
      await clickToggle(element);
      time.tick(10_000);
      element.remove();
      document.body.append(element);
      await clickToggle(element);
      time.tick(29_999);
      await element.updateComplete;
      expect(shown(element)).toBe(SECRET);
    });
  });
});
