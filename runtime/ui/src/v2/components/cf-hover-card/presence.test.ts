import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { HoverPresence } from "./presence.ts";

describe("presence", () => {
  describe("HoverPresence", () => {
    it("starts with nothing inside", () => {
      expect(new HoverPresence().inside).toBe(false);
    });

    it("is inside while the pointer is", () => {
      const presence = new HoverPresence();
      presence.enter("pointer");
      expect(presence.inside).toBe(true);
      presence.leave("pointer");
      expect(presence.inside).toBe(false);
    });

    it("is inside while focus is", () => {
      const presence = new HoverPresence();
      presence.enter("focus");
      expect(presence.inside).toBe(true);
      presence.leave("focus");
      expect(presence.inside).toBe(false);
    });

    it("stays inside while focus remains after the pointer leaves", () => {
      const presence = new HoverPresence();
      presence.enter("focus");
      presence.enter("pointer");
      presence.leave("pointer");
      expect(presence.inside).toBe(true);
    });

    it("forgets both on reset", () => {
      const presence = new HoverPresence();
      presence.enter("focus");
      presence.enter("pointer");
      presence.reset();
      expect(presence.inside).toBe(false);
    });
  });
});
