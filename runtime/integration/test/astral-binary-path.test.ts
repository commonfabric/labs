/**
 * Which binary an astral launch is given, and the order the answer is decided
 * in.
 *
 * The order is the whole of what this is: an explicit `ASTRAL_BIN_PATH` is
 * what CI sets and must win, a system browser is what a developer's machine
 * has and beats astral's download, and `undefined` is what leaves that
 * download in place for a machine with neither.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { astralBinaryPath } from "../astral-adapter.ts";

/** Runs the body with `ASTRAL_BIN_PATH` set as given, then puts it back. */
function withEnvironmentOverride(value: string | undefined, body: () => void) {
  const previous = Deno.env.get("ASTRAL_BIN_PATH");
  if (value === undefined) {
    Deno.env.delete("ASTRAL_BIN_PATH");
  } else {
    Deno.env.set("ASTRAL_BIN_PATH", value);
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("ASTRAL_BIN_PATH");
    } else {
      Deno.env.set("ASTRAL_BIN_PATH", previous);
    }
  }
}

describe("astralBinaryPath()", () => {
  it("returns the `ASTRAL_BIN_PATH` override when one is set", () => {
    // Deliberately a path that does not exist: the override is taken on the
    // caller's word, so that naming a binary this code would not have found
    // works -- astral's own downloaded one, say.
    withEnvironmentOverride("/nonexistent/named-by-hand", () => {
      expect(astralBinaryPath()).toBe("/nonexistent/named-by-hand");
    });
  });

  it("ignores an override set to the empty string", () => {
    // An empty variable is how a shell says "unset" by accident, and taking it
    // literally would hand a launch an empty path.
    withEnvironmentOverride("", () => {
      expect(astralBinaryPath()).not.toBe("");
    });
  });

  describe("with no override", () => {
    it("returns an existing file, or nothing at all", () => {
      // What it must never do is name a path that is not there, since astral
      // takes the answer as final and would fail to spawn it. Either answer is
      // correct depending on the machine; naming an absent file is not.
      withEnvironmentOverride(undefined, () => {
        const path = astralBinaryPath();
        if (path === undefined) return;
        expect(Deno.statSync(path).isFile).toBe(true);
      });
    });

    it("skips a candidate that is not there, and takes the next that is", () => {
      // The existence check, asked where the answer is known. Without it the
      // first candidate comes back whether or not it exists, and astral takes
      // that answer as final and fails to spawn it.
      const real = fromFileUrl(import.meta.url);
      withEnvironmentOverride(undefined, () => {
        expect(astralBinaryPath(["/nonexistent/one", "/nonexistent/two", real]))
          .toBe(real);
      });
    });

    it("returns nothing when no candidate is there", () => {
      withEnvironmentOverride(undefined, () => {
        expect(astralBinaryPath(["/nonexistent/one", "/nonexistent/two"]))
          .toBe(undefined);
      });
    });
  });
});
