// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFLabel } from "./index.ts";

/** A label for `id`, mounted beside a control with that id. */
async function labelBeside<T extends HTMLElement>(
  control: T,
  id = "email",
): Promise<{ label: CFLabel; control: T; clicks: CustomEvent[] }> {
  control.id = id;
  control.title = "control";
  document.body.append(control);
  const label = await mount(Object.assign(new CFLabel(), { for: id }));
  const clicks: CustomEvent[] = [];
  label.addEventListener("cf-label-click", (event) => {
    if (event instanceof CustomEvent) clicks.push(event);
  });
  return { label, control, clicks };
}

describe("CFLabel", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-label")).toBe(CFLabel);
  });

  describe("instance members", () => {
    describe("render()", () => {
      it("renders a required indicator only when required", async () => {
        const label = await mount(new CFLabel());
        expect(label.shadowRoot!.querySelector("[part=required]")).toBeNull();

        label.required = true;
        await label.updateComplete;
        expect(label.shadowRoot!.querySelector("[part=required]")?.textContent)
          .toBe("*");
      });

      it("renders the disabled class only when disabled", async () => {
        const label = await mount(new CFLabel());
        const inner = label.shadowRoot!.querySelector("label")!;
        expect(inner.classList.contains("disabled")).toBe(false);

        label.disabled = true;
        await label.updateComplete;
        expect(inner.classList.contains("disabled")).toBe(true);
      });
    });

    describe("getControl()", () => {
      it("returns the element whose id is the for attribute", async () => {
        const { label } = await labelBeside(
          document.createElement("input"),
          "a.b",
        );
        // A decoy that an unescaped `#a.b` selector would match instead.
        const decoy = document.createElement("input");
        decoy.id = "a";
        decoy.className = "b";
        decoy.title = "decoy";
        document.body.prepend(decoy);

        expect(label.getControl()?.title).toBe("control");
      });

      it("returns null without a for attribute", async () => {
        const label = await mount(new CFLabel());
        document.body.append(document.createElement("input"));
        expect(label.getControl()?.localName).toBeUndefined();
      });

      it("looks in the label's own shadow root, not the document", () => {
        const outside = document.createElement("input");
        outside.id = "email";
        outside.title = "outside";
        document.body.append(outside);
        const host = document.createElement("div");
        document.body.append(host);
        const root = host.attachShadow({ mode: "open" });
        const inside = document.createElement("input");
        inside.id = "email";
        inside.title = "inside";
        const label = Object.assign(new CFLabel(), { for: "email" });
        root.append(label, inside);

        expect(label.getControl()?.title).toBe("inside");
      });
    });
  });

  describe("click", () => {
    it("focuses the control and dispatches cf-label-click", async () => {
      const { label, control, clicks } = await labelBeside(
        document.createElement("input"),
      );
      let controlClicks = 0;
      control.addEventListener("click", () => controlClicks++);

      label.click();

      expect(document.activeElement?.getAttribute("title")).toBe("control");
      // A native control is focused, not clicked.
      expect(controlClicks).toBe(0);
      const details = clicks.map(({ detail }) => ({
        targetId: detail.targetId,
        targetTitle: detail.targetElement.title,
      }));
      expect(details).toEqual([{ targetId: "email", targetTitle: "control" }]);
    });

    it("also clicks a custom element control", async () => {
      const { label, control, clicks } = await labelBeside(
        document.createElement("x-control"),
      );
      control.tabIndex = 0;
      let controlClicks = 0;
      control.addEventListener("click", () => controlClicks++);

      label.click();

      expect(document.activeElement?.getAttribute("title")).toBe("control");
      expect(controlClicks).toBe(1);
      expect(clicks).toHaveLength(1);
    });

    it("does nothing while disabled", async () => {
      const { label, clicks } = await labelBeside(
        document.createElement("input"),
      );
      label.disabled = true;

      label.click();

      expect(document.activeElement?.localName).toBe("body");
      expect(clicks).toHaveLength(0);
    });

    it("does nothing when no control has the id", async () => {
      const { label, clicks } = await labelBeside(
        document.createElement("input"),
      );
      label.for = "missing";

      label.click();

      expect(document.activeElement?.localName).toBe("body");
      expect(clicks).toHaveLength(0);
    });

    it("does nothing after the label is removed", async () => {
      const { label, clicks } = await labelBeside(
        document.createElement("input"),
      );
      label.remove();

      label.click();

      expect(clicks).toHaveLength(0);
    });
  });
});
