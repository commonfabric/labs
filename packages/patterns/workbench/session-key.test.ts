import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sessionKey as connectorSessionKey } from "../../connectors/agents/connector/src/session-contract.ts";
import { sessionKey } from "./session-key.ts";

/**
 * The pattern's spelling of a session's identity against the connector's,
 * over the identities that would tell the two apart: casing and padding the
 * connector normalizes, a slash in either part, the characters
 * percent-encoding touches, and a native id that is itself a path.
 */
const IDENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["claude", "aaa"],
  ["Codex:Work", "abc/123"],
  [" CLAUDE ", " 43f3f3d0-9b28-432a-9cd9-80a045ed6044 "],
  ["a/b", "c"],
  ["a", "b/c"],
  ["source with spaces", "id with spaces"],
  ["\u00fcn\u00efc\u00f6d\u00e9", "\u65e5\u672c\u8a9e"],
  ["acp-lab", "%2F already encoded"],
  ["claude", "/Users/someone/.claude/projects/x/y.jsonl"],
];

describe("sessionKey", () => {
  it("spells every identity the way the connector does", () => {
    for (const [sourceId, nativeSessionId] of IDENTITIES) {
      expect(sessionKey(sourceId, nativeSessionId)).toBe(
        connectorSessionKey(sourceId, nativeSessionId),
      );
    }
  });

  it("keeps identities apart that differ only in where a slash falls", () => {
    expect(sessionKey("a/b", "c")).not.toBe(sessionKey("a", "b/c"));
  });

  it("encodes a control character where the connector refuses it", () => {
    const withControl = "a" + String.fromCharCode(0) + "b";
    expect(() => connectorSessionKey("claude", withControl)).toThrow();
    expect(sessionKey("claude", withControl)).toBe("claude/a%00b");
  });
});
