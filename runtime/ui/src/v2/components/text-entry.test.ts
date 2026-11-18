import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { targetsTextEntry } from "./text-entry.ts";

/** An event whose composed path starts at `element`. */
function eventFrom(element: unknown): Event {
  return { composedPath: () => [element] } as unknown as Event;
}

describe("text-entry", () => {
  describe("targetsTextEntry()", () => {
    it("returns `true` for an event from a contenteditable element", () => {
      expect(
        targetsTextEntry(
          eventFrom({ tagName: "DIV", isContentEditable: true }),
        ),
      ).toBe(true);
    });

    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      it(`returns \`true\` for an event from a ${tagName.toLowerCase()}`, () => {
        expect(targetsTextEntry(eventFrom({ tagName }))).toBe(true);
      });
    }

    it("returns `false` for an event from a non-editable island inside an editor", () => {
      expect(
        targetsTextEntry(
          eventFrom({ tagName: "SPAN", isContentEditable: false }),
        ),
      ).toBe(false);
    });

    it("returns `false` for an event whose path starts at no element", () => {
      expect(targetsTextEntry(eventFrom(undefined))).toBe(false);
      expect(targetsTextEntry(eventFrom({}))).toBe(false);
    });
  });
});
