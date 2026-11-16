// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import "../cf-tab/index.ts";
import "../cf-tabs/index.ts";
import { CFTabPanel } from "./index.ts";

/** Mounts `html` and resolves with its panel once every element rendered. */
async function panelIn(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const panel = host.querySelector("cf-tab-panel");
  if (!(panel instanceof CFTabPanel)) throw new Error(`no panel in ${html}`);
  await panel.updateComplete;
  return { host, panel };
}

describe("CFTabPanel", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tab-panel`", () => {
    expect(customElements.get("cf-tab-panel")).toBe(CFTabPanel);
  });

  describe("connected", () => {
    it("exposes itself as a hidden, focusable tab panel", async () => {
      const panel = await mount(new CFTabPanel());
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("tabindex")).toBe("0");
      expect(panel.hasAttribute("hidden")).toBe(true);
      expect(panel.getAttribute("aria-hidden")).toBe("true");
    });

    it("is labelled by its tab, naming the tab when it has no id", async () => {
      const { panel, host } = await panelIn(`
        <cf-tabs>
          <cf-tab value="profile">Profile</cf-tab>
          <cf-tab-panel value="profile"></cf-tab-panel>
        </cf-tabs>`);
      expect(host.querySelector("cf-tab")!.id).toBe("tab-profile");
      expect(panel.getAttribute("aria-labelledby")).toBe("tab-profile");
    });

    it("is labelled by a tab whose value was set as a property, ahead of the tab's update", async () => {
      const tabs = document.createElement("cf-tabs");
      const panel = new CFTabPanel();
      panel.value = "profile";
      const tab = document.createElement("cf-tab");
      tab.setAttribute("id", "me");
      tab.value = "profile";
      // The panel comes first, so it updates before the tab reflects `value`.
      tabs.append(panel, tab);
      document.body.append(tabs);
      await panel.updateComplete;
      expect(panel.getAttribute("aria-labelledby")).toBe("me");
    });

    it("is labelled by its tab's own id", async () => {
      const { panel } = await panelIn(`
        <cf-tabs>
          <cf-tab id="me" value="profile">Profile</cf-tab>
          <cf-tab-panel value="profile"></cf-tab-panel>
        </cf-tabs>`);
      expect(panel.getAttribute("aria-labelledby")).toBe("me");
    });

    it("is labelled by its tab when the value holds a quotation mark", async () => {
      const { panel } = await panelIn(`
        <cf-tabs>
          <cf-tab value='say "hi"'>Greeting</cf-tab>
          <cf-tab-panel value='say "hi"'></cf-tab-panel>
        </cf-tabs>`);
      expect(panel.getAttribute("aria-labelledby")).toBe('tab-say "hi"');
    });

    for (
      const [situation, html] of [
        ["outside tabs", `<cf-tab-panel value="profile"></cf-tab-panel>`],
        [
          "without a value",
          `<cf-tabs><cf-tab></cf-tab><cf-tab-panel></cf-tab-panel></cf-tabs>`,
        ],
        [
          "without a matching tab",
          `<cf-tabs><cf-tab value="a"></cf-tab><cf-tab-panel value="b"></cf-tab-panel></cf-tabs>`,
        ],
      ]
    ) {
      it(`is labelled by nothing ${situation}`, async () => {
        const { panel } = await panelIn(html);
        expect(panel.hasAttribute("aria-labelledby")).toBe(false);
      });
    }

    it("follows a new value to its tab", async () => {
      const { panel } = await panelIn(`
        <cf-tabs>
          <cf-tab value="a"></cf-tab>
          <cf-tab value="b"></cf-tab>
          <cf-tab-panel value="a"></cf-tab-panel>
        </cf-tabs>`);
      panel.value = "b";
      await panel.updateComplete;
      expect(panel.getAttribute("aria-labelledby")).toBe("tab-b");
    });
  });

  describe("show(), hide(), and toggle()", () => {
    it("show and hide the panel, and say so to assistive technology", async () => {
      const panel = await mount(new CFTabPanel());
      panel.show();
      await panel.updateComplete;
      expect(panel.hasAttribute("hidden")).toBe(false);
      expect(panel.getAttribute("aria-hidden")).toBe("false");

      panel.toggle();
      await panel.updateComplete;
      expect(panel.hidden).toBe(true);
      expect(panel.getAttribute("aria-hidden")).toBe("true");

      panel.toggle();
      expect(panel.hidden).toBe(false);
      panel.hide();
      expect(panel.hidden).toBe(true);
    });
  });
});
