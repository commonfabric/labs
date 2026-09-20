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

    it("refuses a relative token a URL plane cannot spell, and does not move", () => {
      // A plane written in URLs reads a token as a URL reference, and `//a b`
      // is an authority it cannot write. The same token on the file plane is
      // an ordinary path and lands, which is the case below.

      const location = at("https://example.test/a/");
      expect(refusal(location.xcd("//a b/c"))).toContain("names no place");
      expect(location.render()).toBe("https://example.test/a/");
    });

    it("reads a token on the file plane as a path, not as a URL reference", () => {
      // A URL reads `#` as a fragment, `?` as a query and a leading blank as
      // nothing at all, and a directory may be named with any of them. Each
      // of these would land somewhere else if the token were resolved as a
      // URL reference: `a#b` at `a`, and the third at a scheme.

      const cases: readonly (readonly [string, string])[] = [
        ["a#b", "file:///tmp/work/a%23b/"],
        ["a?b", "file:///tmp/work/a%3Fb/"],
        [" file:out", "file:///tmp/work/%20file:out/"],
        ["//a b/c", "file:///a%20b/c/"],
      ];
      for (const [token, landed] of cases) {
        const location = at("file:///tmp/work/");
        location.xcd(token);
        expect({ token, at: location.render() }).toEqual({ token, at: landed });
      }
    });

    it("writes out a home holding a character a URL would read as syntax", () => {
      const location = new ExternalLocation(
        new URL("file:///tmp/"),
        "/home/a#b",
      );
      location.xcd("file:~/data");
      expect(location.render()).toBe("file:///home/a%23b/data/");
    });

    it("refuses a `file:` token naming a host, which is another machine", () => {
      // The host would be dropped in silence by the conversion to a path,
      // leaving a location that looks like the one asked for and is not.

      const location = at("file:///tmp/work/");
      expect(refusal(location.xcd("file://server/share/a")))
        .toContain("does not reach");
      expect(location.render()).toBe("file:///tmp/work/");
    });

    it("takes `localhost` as the local machine, the parser resolving it away", () => {
      const location = at("file:///tmp/");
      location.xcd("file://localhost/work");
      expect(location.render()).toBe("file:///work/");
    });

    it("cannot be read past a leading blank into a scheme, on a URL plane", () => {
      // A URL parser drops leading blanks before it reads anything else,
      // which would turn this into a schemed reference — past the check that
      // refuses the scheme, and onto another plane.

      const location = at("https://example.test/a/");
      location.xcd(" file:out.json");
      expect(location.render())
        .toBe("https://example.test/a/%20file:out.json/");
    });

    it("refuses a token holding a character a terminal acts on", () => {
      // The same rule a place makes about a part holding one, for the same
      // reason. A URL parser would drop it rather than refuse it, which is
      // what makes it the reading's problem rather than the plane's.

      const location = at("file:///tmp/work/");
      expect(refusal(location.xcd("file:out\n.json")))
        .toContain("a terminal acts on");
      expect(location.render()).toBe("file:///tmp/work/");
    });

    it("reads the scheme of a token whatever the rest of it holds", () => {
      // The refusal above is the door; this is the reading behind it. A
      // pattern that carried the rest as a group would stop at a line break
      // and leave the token reading as though it named no scheme, which is a
      // relative path landing where an absolute one was refused.

      const location = at("https://example.test/a/");
      expect(refusal(location.xcd("file:out.json"))).toContain("absolute");
      expect(location.render()).toBe("https://example.test/a/");
    });

    it("keeps a blank at either end of a token on a URL plane", () => {
      // A URL parser drops them at both ends: at the front that reads past a
      // scheme, and at the back it quietly renames `a ` to `a`.

      const location = at("https://example.test/a/");
      location.xcd("b ");
      expect(location.render()).toBe("https://example.test/a/b%20/");
    });

    it("reads a scheme however it is spelled, a scheme being case-blind", () => {
      const location = at("file:///tmp/");
      location.xcd("FILE:~/work");
      expect(location.render()).toBe(`file://${HOME}/work/`);
    });

    it("stands at the root without a separator written twice", () => {
      // A caller that appends one to a directory it already has would hand
      // the root a second, and what makes a location a container is here
      // rather than at a caller.

      expect(new ExternalLocation(new URL("file:///"), HOME).render())
        .toBe("file:///");
    });

    it("counts the home on its own as a whole path", () => {
      const location = at("file:///tmp/");
      location.xcd("file:~");
      expect(location.render()).toBe(`file://${HOME}/`);
    });

    it("keeps a token that is nothing but blanks", () => {
      const location = at("https://example.test/a/");
      location.xcd("  ");
      expect(location.render()).toBe("https://example.test/a/%20%20/");
    });

    it("refuses a relative path opening at a home the run was given none of", () => {
      // The refusal reached through the relative branch rather than the
      // schemed one, which is a second way in to the same question.

      const homeless = new ExternalLocation(new URL("file:///tmp/"), undefined);
      expect(refusal(homeless.xcd("~/work"))).toContain("no home");
      expect(homeless.render()).toBe("file:///tmp/");
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
