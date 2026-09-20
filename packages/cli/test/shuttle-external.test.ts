/**
 * Unit tests for the external plane: the one working position outside the
 * fabric, and what moves it.
 *
 * Every case drives the location with a home of its own rather than the one
 * the run happens to have, so what `~` expands to is a fact of the case and
 * not of the machine it runs on.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ExternalLocation, type Landing } from "../lib/shuttle/external.ts";

const HOME = "/home/someone";

/**
 * A location at `href`, with a home no machine's own home can be mistaken
 * for.
 */
function at(href: string): ExternalLocation {
  return new ExternalLocation(new URL(href), HOME);
}

/** The reason `landing` was refused for. */
function refusal(landing: Landing): string {
  expect(landing.kind).toBe("refused");
  return (landing as { reason: string }).reason;
}

describe("external", () => {
  describe("the location", () => {
    it("stands at a container, so a relative path resolves inside it", () => {
      expect(at("file:///tmp/work").render()).toBe("file:///tmp/work/");
    });

    it("prints as the one dimension `where` names it by", () => {
      expect(at("file:///tmp/").entries()).toEqual([
        { label: "external", value: "file:///tmp/" },
      ]);
    });

    it("prints what `render()` returns, the two being one spelling", () => {
      const location = at("file:///tmp/work/");
      expect(location.entries()[0].value).toBe(location.render());
    });
  });

  describe("xcd()", () => {
    it("moves the location with a plain relative path", () => {
      const location = at("file:///tmp/work/");
      location.xcd("../other");
      expect(location.render()).toBe("file:///tmp/other/");
    });

    it("moves it into a child named with no path at all", () => {
      const location = at("file:///tmp/work/");
      location.xcd("inner");
      expect(location.render()).toBe("file:///tmp/work/inner/");
    });

    it("moves it with a plain absolute path, staying on the same plane", () => {
      const location = at("https://example.test/a/b/");
      location.xcd("/c");
      expect(location.render()).toBe("https://example.test/c/");
    });

    it("moves it to another plane with a whole schemed path", () => {
      const location = at("file:///tmp/");
      location.xcd("https://example.test/a/b/");
      expect(location.render()).toBe("https://example.test/a/b/");
    });

    it("takes a scheme a location is only held under, nothing opening one", () => {
      const location = at("file:///tmp/");
      expect(location.xcd("https://example.test/a/").kind).toBe("external");
    });

    it("counts a path opening at the home directory as absolute", () => {
      const location = at("file:///tmp/");
      location.xcd("file:~/work");
      expect(location.render()).toBe(`file://${HOME}/work/`);
    });

    it("leaves a `~` alone on a plane that has no home", () => {
      const location = at("https://example.test/a/");
      location.xcd("~/work");
      expect(location.render()).toBe("https://example.test/a/~/work/");
    });

    it("stays where it stands for an operand naming no path", () => {
      const location = at("file:///tmp/work/");
      location.xcd("");
      expect(location.render()).toBe("file:///tmp/work/");
    });

    it("refuses a scheme on a path that is not absolute, and does not move", () => {
      const location = at("file:///tmp/work/");
      expect(refusal(location.xcd("file:other"))).toContain("absolute");
      expect(location.render()).toBe("file:///tmp/work/");
    });

    it("names the operand a scheme on a relative path was written on", () => {
      expect(refusal(at("file:///tmp/").xcd("file:out.json")))
        .toContain("file:out.json");
    });

    it("refuses a path that names somebody else's home, and does not move", () => {
      const location = at("file:///tmp/work/");
      expect(refusal(location.xcd("file:~other/data")))
        .toContain("nobody else's");
      expect(location.render()).toBe("file:///tmp/work/");
    });

    it("refuses a schemed token the plane cannot spell, saying so on its own terms", () => {
      // Absolute and refused anyway: the authority after the separator is not
      // one the plane can write. Telling somebody to make it absolute would
      // send them looking at the half that is already right.

      const reason = refusal(at("file:///tmp/").xcd("file://[bad/x"));
      expect(reason).toContain("spells no place");
      expect(reason).not.toContain("absolute");
    });

    it("refuses a relative token the plane cannot spell, and does not move", () => {
      const location = at("file:///tmp/work/");
      expect(refusal(location.xcd("//a b/c"))).toContain("names no place");
      expect(location.render()).toBe("file:///tmp/work/");
    });

    it("refuses a path opening at a home the run was given none of", () => {
      const homeless = new ExternalLocation(new URL("file:///tmp/"), undefined);
      expect(refusal(homeless.xcd("file:~/work"))).toContain("no home");
    });

    it("moves a path with no `~` in it where the run was given no home", () => {
      const homeless = new ExternalLocation(new URL("file:///tmp/"), undefined);
      homeless.xcd("../other");
      expect(homeless.render()).toBe("file:///other/");
    });
  });
});
