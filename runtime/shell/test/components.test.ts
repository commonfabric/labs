// deno-lint-ignore-file cf-imports/no-inline-module-import -- the components
// extend a bare HTMLElement as they load, so they can only load once the test
// has installed one.

/**
 * The shell's small components, reached through the barrel `src/index.ts`
 * loads them by: what each element renders for its properties, and the
 * submit a button makes on behalf of the form around it.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type * as ComponentsModule from "../src/components/index.ts";
import { installBrowserGlobals } from "./browser-globals.ts";
import { templateListeners, templateMarkup } from "./lit-template-markup.ts";

type Components = typeof ComponentsModule;

/** Returns how many times `part` occurs in `markup`. */
function occurrences(markup: string, part: string): number {
  return markup.split(part).length - 1;
}

describe("components", () => {
  let restore: () => void;
  let components: Components;

  beforeAll(async () => {
    restore = installBrowserGlobals("http://localhost:8000/");
    components = await import("../src/components/index.ts");
  });

  afterAll(() => restore());

  describe("index.ts", () => {
    it("defines each element under its tag", () => {
      expect(customElements.get("cf-logo")).toBe(components.CFLogo);
      expect(customElements.get("x-button")).toBe(components.XButtonElement);
      expect(customElements.get("v-box")).toBe(components.VBoxElement);
      expect(customElements.get("x-piece-list")).toBe(components.XPieceList);
    });
  });

  describe("CFLogo", () => {
    it("draws a 32-pixel logo of light shapes on white by default", () => {
      const markup = templateMarkup(new components.CFLogo().render());

      expect(markup).toContain('width="32"');
      expect(markup).toContain('height="32"');
      expect(markup).toContain(
        '<rect width="850" height="850" rx="80" fill="white"',
      );
      expect(occurrences(markup, 'fill="#f9fafb"')).toBe(4);
    });

    it("draws the logo at its size, and in its colors", () => {
      const logo = new components.CFLogo();
      logo.width = 48;
      logo.height = 24;
      logo.backgroundColor = "black";
      logo.shapeColor = "tomato";

      const markup = templateMarkup(logo.render());

      expect(markup).toContain('width="48"');
      expect(markup).toContain('height="24"');
      expect(markup).toContain('rx="80" fill="black"');
      expect(occurrences(markup, 'fill="tomato"')).toBe(4);
      expect(markup).not.toContain("white");
      expect(markup).not.toContain("#f9fafb");
    });
  });

  describe("XButtonElement", () => {
    /** A form, counting the submissions asked of it. */
    class StandInForm {
      /** How many times the form was asked to submit. */
      submissions = 0;

      /** Records a submission, as a click on a submit button in it asks. */
      requestSubmit(): void {
        this.submissions++;
      }
    }

    /**
     * Clicks `button`, which sits in `form` where one is given, and returns
     * the click event.
     */
    function click(
      button: InstanceType<Components["XButtonElement"]>,
      form?: StandInForm,
    ): Event {
      Object.defineProperty(button, "closest", {
        value: (selector: string) => selector === "form" ? form ?? null : null,
      });
      const event = new Event("click", { cancelable: true });
      for (
        const { dispatch } of templateListeners(
          button.render(),
          "click",
          button,
        )
      ) {
        dispatch(event);
      }
      return event;
    }

    it("renders a plain, non-submitting button by default", () => {
      const markup = templateMarkup(new components.XButtonElement().render());

      expect(markup).toContain('type="button"');
      expect(markup).toContain('x-variant="none"');
      expect(markup).toContain("<slot></slot>");
    });

    it("renders its type and variant", () => {
      const button = new components.XButtonElement();
      button.type = "submit";
      button.variant = "primary";

      const markup = templateMarkup(button.render());

      expect(markup).toContain('type="submit"');
      expect(markup).toContain('x-variant="primary"');
    });

    it("submits the form around it once per click", () => {
      const button = new components.XButtonElement();
      button.type = "submit";
      const form = new StandInForm();

      const event = click(button, form);

      expect(event.defaultPrevented).toBe(true);
      expect(form.submissions).toBe(1);
    });

    it("submits nothing when it is not a submit button", () => {
      const button = new components.XButtonElement();
      const form = new StandInForm();

      const event = click(button, form);

      expect(event.defaultPrevented).toBe(false);
      expect(form.submissions).toBe(0);
    });

    it("leaves a submit click alone outside a form", () => {
      const button = new components.XButtonElement();
      button.type = "submit";

      expect(click(button).defaultPrevented).toBe(false);
    });
  });

  describe("VBoxElement", () => {
    it("renders its children in a column container", () => {
      const markup = templateMarkup(new components.VBoxElement().render());

      expect(markup.trim()).toBe("<div><slot></slot></div>");
    });
  });

  describe("icons", () => {
    describe("iconStar()", () => {
      it("returns an outlined star by default, and a filled one when asked", () => {
        expect(templateMarkup(components.iconStar())).toContain('fill="none"');
        expect(templateMarkup(components.iconStar(true))).toContain(
          'fill="currentColor"',
        );
        expect(templateMarkup(components.iconStar(true))).not.toContain(
          'fill="none"',
        );
      });
    });

    describe("iconThemeToggle()", () => {
      it("returns a sun in dark mode and a moon in light mode", () => {
        const sun = templateMarkup(components.iconThemeToggle(true));
        const moon = templateMarkup(components.iconThemeToggle());

        expect(sun).toContain("<circle");
        expect(moon).not.toContain("<circle");
        expect(moon).toContain(
          'd="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"',
        );
        expect(sun).not.toContain("M21 12.79");
      });
    });
  });
});
