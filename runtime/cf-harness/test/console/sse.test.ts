import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  chatEventFrame,
  envelopesAfter,
  isUndelivered,
  parseAfterSequence,
  pingFrame,
  sseFrame,
} from "../../console/sse.ts";
import {
  createHarnessChatEventEnvelope,
  type HarnessChatEventEnvelope,
} from "../../src/contracts/interactive-chat.ts";

const envelope = (sequence: number): HarnessChatEventEnvelope =>
  createHarnessChatEventEnvelope({
    sessionId: "session-1",
    sequence,
    emittedAt: "2026-01-01T00:00:00.000Z",
    event: { kind: "assistant_completed", text: `message ${sequence}` },
  });

describe("console/sse", () => {
  describe("sseFrame()", () => {
    it("terminates a frame with a blank line and omits an absent id", () => {
      expect(sseFrame("ping", "1")).toBe("event: ping\ndata: 1\n\n");
    });

    it("writes the id line before the data line", () => {
      expect(sseFrame("chat", "{}", 7)).toBe(
        "event: chat\nid: 7\ndata: {}\n\n",
      );
    });

    it("writes an id of zero rather than dropping it", () => {
      expect(sseFrame("chat", "{}", 0)).toBe(
        "event: chat\nid: 0\ndata: {}\n\n",
      );
    });
  });

  describe("chatEventFrame()", () => {
    it("carries the envelope as JSON keyed by its sequence", () => {
      const frame = chatEventFrame(envelope(3));
      expect(frame.startsWith("event: chat\nid: 3\ndata: {")).toBe(true);
      expect(frame.endsWith("}\n\n")).toBe(true);
      const data = frame.slice(frame.indexOf("data: ") + 6, -2);
      expect(JSON.parse(data)).toEqual(envelope(3));
    });

    it("writes the payload on a single line", () => {
      const frame = chatEventFrame(envelope(1));
      expect(frame.trimEnd().split("\n")).toHaveLength(3);
    });
  });

  describe("pingFrame()", () => {
    it("carries the beat count so the event is delivered to the page", () => {
      expect(pingFrame(4)).toBe("event: ping\ndata: 4\n\n");
    });
  });

  describe("parseAfterSequence()", () => {
    it("returns undefined for an absent or blank value", () => {
      expect(parseAfterSequence(null)).toBeUndefined();
      expect(parseAfterSequence("  ")).toBeUndefined();
    });

    it("returns the sequence a resume asks for, zero included", () => {
      expect(parseAfterSequence("0")).toBe(0);
      expect(parseAfterSequence("42")).toBe(42);
    });

    it("refuses a value that is not a non-negative integer", () => {
      expect(() => parseAfterSequence("-1")).toThrow(RangeError);
      expect(() => parseAfterSequence("1.5")).toThrow(RangeError);
      expect(() => parseAfterSequence("later")).toThrow(RangeError);
    });
  });

  describe("envelopesAfter()", () => {
    it("drops everything the caller has already seen", () => {
      const backfill = envelopesAfter(
        [envelope(1), envelope(2), envelope(3)],
        2,
      );
      expect(backfill.map((event) => event.sequence)).toEqual([3]);
    });

    it("returns the backfill in sequence order whatever order it arrived in", () => {
      const backfill = envelopesAfter(
        [envelope(5), envelope(2), envelope(4)],
        1,
      );
      expect(backfill.map((event) => event.sequence)).toEqual([2, 4, 5]);
    });

    it("leaves the input untouched", () => {
      const input = [envelope(3), envelope(1)];
      envelopesAfter(input, 0);
      expect(input.map((event) => event.sequence)).toEqual([3, 1]);
    });
  });

  describe("isUndelivered()", () => {
    it("holds for an envelope past what the stream has written", () => {
      expect(isUndelivered(envelope(4), 3)).toBe(true);
    });

    it("fails for an envelope the backfill already carried", () => {
      expect(isUndelivered(envelope(3), 3)).toBe(false);
      expect(isUndelivered(envelope(2), 3)).toBe(false);
    });
  });
});
