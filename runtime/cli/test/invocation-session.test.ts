import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  invocationSession,
  renderNewSession,
} from "../commands/invocation-session.ts";
import { newSessionId } from "../lib/session.ts";

// A random (version 4) UUID: the version nibble is 4 and the variant nibble is
// one of 8/9/a/b, with every other nibble drawn from the CSPRNG.
const RANDOM_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("invocation-session", () => {
  describe("newSessionId()", () => {
    it("returns a distinct id on every call", () => {
      const minted = new Set(
        Array.from({ length: 1000 }, () => newSessionId()),
      );
      expect(minted.size).toBe(1000);
    });

    it("returns a random id rather than a countable or timed one", () => {
      // The shape is the evidence of where the bits came from: a counter, a
      // timestamp, or a time-ordered UUID (v1, v7) all carry a version other
      // than 4, and all let a caller who has seen one session id name the
      // next one. Reusing another caller's session id is reusing its
      // invocation ids.
      expect(newSessionId()).toMatch(RANDOM_UUID);
    });
  });

  describe("renderNewSession()", () => {
    it("writes one freshly minted id, and nothing besides", () => {
      const written: string[] = [];
      renderNewSession((text) => written.push(text));
      renderNewSession((text) => written.push(text));

      // Exactly one bare token per call: no prose to strip and no envelope to
      // parse (`cf id new`'s PEM has one because it carries key material; a
      // session carries none), so `$(cf invocation-session new)` captures the
      // id itself.
      expect(written.length).toBe(2);
      expect(written[0]).toMatch(RANDOM_UUID);
      expect(written[1]).toMatch(RANDOM_UUID);
      // Two runs of the command are two sessions.
      expect(written[0]).not.toBe(written[1]);
    });
  });

  describe("invocationSession", () => {
    it("registers `new` as a subcommand", () => {
      expect(invocationSession.getCommand("new")?.getName()).toBe("new");
    });
  });
});
