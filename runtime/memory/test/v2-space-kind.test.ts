import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { isSpaceKind, SPACE_KIND_MAX_LENGTH } from "../v2/space-kind.ts";

describe("isSpaceKind()", () => {
  it("returns `true` for one lowercase word, or several joined by single hyphens", () => {
    for (const kind of ["notebook", "fabrichat-room", "a", "v2", "room-2-b"]) {
      expect(isSpaceKind(kind)).toBe(true);
    }
  });

  it("returns `true` for a kind of the longest length, and `false` for one past it", () => {
    const longest = "k".repeat(SPACE_KIND_MAX_LENGTH);
    expect(isSpaceKind(longest)).toBe(true);
    expect(isSpaceKind(`${longest}k`)).toBe(false);
  });

  it("returns `false` for a string not of that form", () => {
    for (
      const kind of [
        "",
        "Notebook",
        "2room",
        "-room",
        "room-",
        "fabrichat--room",
        "fabrichat_room",
        "fabrichat room",
        "system:notebook",
        "room\n",
      ]
    ) {
      expect(isSpaceKind(kind)).toBe(false);
    }
  });

  it("returns `false` for a value that is not a string", () => {
    for (
      const kind of [undefined, null, 1, true, ["notebook"], {
        kind: "notebook",
      }]
    ) {
      expect(isSpaceKind(kind)).toBe(false);
    }
  });
});
