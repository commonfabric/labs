import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  addReportRefusal,
  MAX_COMMANDS,
  MAX_NAME,
  MAX_PROBES,
  MAX_STRUCTURED,
  RELEASE,
  structuredRefusal,
  TOPIC_ADDRESS,
} from "./fields.ts";

const ID = "0123456789abcdef".repeat(2);

/** A report the board accepts, with `change` applied. */
function request(change: Record<string, unknown> = {}) {
  return {
    agentName: "cfs-feedback",
    id: ID,
    name: "quiet-heron-41",
    kind: "broke",
    words: "Mail stopped.",
    structured: {
      source: "failure-card",
      cfs: { release: "2026.11.18" },
      want: { id: "w1", cause: "auth-expired", stop: "gmail-sync" },
      commands: [{ id: "sync", ok: false }],
      failingProbes: [{ connector: "gmail", probe: "token-valid" }],
      futureField: { kept: [1] },
    },
    ...change,
  };
}

/** The code `addReport` refuses `request(change)` with. */
function code(change: Record<string, unknown>): string | undefined {
  return addReportRefusal(request(change), [])?.code;
}

/** `request()`'s structured part with `change` applied. */
function structured(change: Record<string, unknown>) {
  return { structured: { ...request().structured, ...change } };
}

describe("fields", () => {
  describe("addReportRefusal()", () => {
    it("returns `undefined` for a well-formed report, unknown fields included", () => {
      expect(addReportRefusal(request(), [])).toBeUndefined();
      expect(code({ id: "f".repeat(32), name: "a-b-1" })).toBeUndefined();
    });

    it("returns the code for each malformed field", () => {
      expect(code({ agentName: " " })).toBe("unsigned");
      expect(code({ id: ID.toUpperCase() })).toBe("bad-id");
      expect(code({ id: undefined })).toBe("bad-id");
      expect(code({ name: "" })).toBe("missing-name");
      expect(code({ name: `a-b-${"1".repeat(MAX_NAME)}` })).toBe(
        "name-too-long",
      );
      expect(code({ name: "Quiet Heron" })).toBe("bad-name");
      expect(code({ name: "quiet-heron-1234567" })).toBe("bad-name");
      expect(code({ kind: "" })).toBe("missing-kind");
      expect(code({ kind: "bug" })).toBe("bad-kind");
      expect(code({ words: 3 })).toBe("bad-words");
      expect(code({ words: "x".repeat(4001) })).toBe("words-too-long");
    });

    it("returns duplicate-id for an id already on the board, and nothing for a name already there", () => {
      expect(addReportRefusal(request(), [ID])?.code).toBe("duplicate-id");
      expect(addReportRefusal(request(), ["f".repeat(32)])).toBeUndefined();
    });
  });

  describe("structuredRefusal()", () => {
    it("returns the code for each malformed known field", () => {
      expect(code({ structured: { source: "" } })).toBe("missing-source");
      expect(code({ structured: "report" })).toBe("missing-source");
      expect(code(structured({ source: "a report" }))).toBe("bad-source");
      expect(code(structured({ want: { cause: "it broke" } }))).toBe(
        "bad-want",
      );
      expect(code(structured({ want: { stop: "x\ny" } }))).toBe("bad-want");
      expect(code(structured({ want: "auth-expired" }))).toBe("bad-want");
      expect(code(structured({ cfs: { release: "latest" } }))).toBe(
        "bad-release",
      );
      expect(code(structured({ commands: {} }))).toBe("bad-commands");
      expect(code(structured({ failingProbes: [{ connector: "gmail" }] })))
        .toBe("bad-probe");
      expect(
        code(structured({ failingProbes: [{ connector: "g m", probe: "p" }] })),
      ).toBe("bad-probe");
    });

    it("returns a code for each limit, and accepts what is at it", () => {
      const commands = (n: number) =>
        Array.from({ length: n }, () => ({ id: "c", ok: true }));
      const probes = (n: number) =>
        Array.from({ length: n }, () => ({ connector: "c", probe: "p" }));
      expect(code(structured({ commands: commands(MAX_COMMANDS) })))
        .toBeUndefined();
      expect(code(structured({ commands: commands(MAX_COMMANDS + 1) })))
        .toBe("too-many-commands");
      expect(code(structured({ failingProbes: probes(MAX_PROBES) })))
        .toBeUndefined();
      expect(code(structured({ failingProbes: probes(MAX_PROBES + 1) })))
        .toBe("too-many-probes");
      expect(code(structured({ padding: "x".repeat(MAX_STRUCTURED) })))
        .toBe("structured-too-large");
    });

    it("refuses a link anywhere in it, in a value or a key", () => {
      for (
        const link of [
          "see https://example.com",
          "www.example.com",
          "javascript:alert(1)",
          " data:text/html,x",
          "ftp://host/file",
        ]
      ) {
        expect(structuredRefusal({ source: "report", note: [{ deep: link }] }))
          .toEqual({
            code: "link-in-structured",
            reason: "structured must not hold a link",
          });
        expect(structuredRefusal({ source: "report", [link]: 1 })?.code)
          .toBe("link-in-structured");
      }
      expect(structuredRefusal({ source: "report", note: "time 12:30" }))
        .toBeUndefined();
    });
  });

  describe("shapes", () => {
    it("takes a release as a commit hash or a version, and nothing else", () => {
      for (const ok of ["2026.11.18", "v1.2.3-rc.1", "abc1234", "1.2"]) {
        expect(RELEASE.test(ok)).toBe(true);
      }
      for (const bad of ["latest", "1", "ABC1234", "1.2 beta", "[1.2](x)"]) {
        expect(RELEASE.test(bad)).toBe(false);
      }
    });

    it("takes a Topic address as top/<n> or a piece id, and nothing else", () => {
      for (const ok of ["top/42", "of:fid1:rMKK3pYbF5IWa7KQL5oe-nd7Wy"]) {
        expect(TOPIC_ADDRESS.test(ok)).toBe(true);
      }
      for (
        const bad of [
          "top/0",
          "top/4a",
          "https://example.com/top/1",
          "of:fid1:x/../y",
          "of:fid1:a b",
          "",
        ]
      ) {
        expect(TOPIC_ADDRESS.test(bad)).toBe(false);
      }
    });
  });
});
