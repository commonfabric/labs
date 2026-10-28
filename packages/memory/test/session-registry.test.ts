import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SessionRegistry } from "../v2/session-registry.ts";

describe("session-registry", () => {
  it("refuses to resume a session opened with `elidedVerdicts` for a client that does not advertise it", () => {
    // A commit the session had accepted under the waived identity proof may
    // replay as an elided positional write, which only a replica that
    // promotes elided layers by their computed document handles; the
    // downgraded client opens a fresh session.
    const registry = new SessionRegistry();
    const opened = registry.open(
      "space",
      {},
      0,
      "connection-a",
      "principal",
      undefined,
      false,
      true,
    );
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts).toBe(true);
    const resume = {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    };

    expect(() => registry.open("space", resume, 0, "connection-b", "principal"))
      .toThrow("requires a client that advertises it");
    expect(
      registry.get("space", opened.sessionId)?.ownerConnectionId,
    ).toBe("connection-a");

    const resumed = registry.open(
      "space",
      resume,
      0,
      "connection-c",
      "principal",
      undefined,
      false,
      true,
    );
    expect(resumed.resumed).toBe(true);
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts).toBe(true);
  });

  it("opens a session for a client without `elidedVerdicts` and resumes it for one with it", () => {
    // The capability is the connection's: a session opened without it takes
    // it on from a later connection that advertises it.
    const registry = new SessionRegistry();
    const opened = registry.open("space", {}, 0, "connection-a", "principal");
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts)
      .toBeUndefined();
    registry.open(
      "space",
      { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
      0,
      "connection-b",
      "principal",
      undefined,
      false,
      true,
    );
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts).toBe(true);
  });

  it("resumes from the token the latest open presented when the resume carries that open's key", () => {
    // The response to a resume can be lost with its connection, and the
    // client then resumes with the token it presented, under the same key.
    const registry = new SessionRegistry();
    const opened = registry.open(
      "space",
      { resumeKey: "key", resumeAttempt: 1 },
      0,
      "a",
      "p",
    );
    let attempt = 1;
    const resume = (sessionToken: string, connection: string) =>
      registry.open(
        "space",
        {
          sessionId: opened.sessionId,
          sessionToken,
          resumeKey: "key",
          resumeAttempt: ++attempt,
        },
        0,
        connection,
        "p",
      );

    const lost = resume(opened.sessionToken, "b");
    expect(lost.sessionToken).not.toBe(opened.sessionToken);
    const again = resume(opened.sessionToken, "c");
    expect(again.resumed).toBe(true);
    expect(again.revokedConnectionId).toBe("b");
    const received = resume(opened.sessionToken, "d");
    expect(received.resumed).toBe(true);
    // Only the presented token and the latest are good: the one whose
    // response was lost never reached the client.
    expect(() => resume(lost.sessionToken, "e")).toThrow(
      "resume token is no longer valid",
    );

    // Once the client presents the token it received, the old one resumes
    // nothing.
    const current = resume(received.sessionToken, "e");
    expect(() => resume(opened.sessionToken, "f")).toThrow(
      "resume token is no longer valid",
    );
    expect(resume(current.sessionToken, "g").resumed).toBe(true);
  });

  it("refuses the token the latest open presented to a resume without that open's key", () => {
    const registry = new SessionRegistry();
    const opened = registry.open(
      "space",
      { resumeKey: "key", resumeAttempt: 1 },
      0,
      "a",
      "p",
    );
    const first = {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    };
    registry.open(
      "space",
      { ...first, resumeKey: "key", resumeAttempt: 2 },
      0,
      "b",
      "p",
    );

    expect(() =>
      registry.open(
        "space",
        { ...first, resumeKey: "other", resumeAttempt: 3 },
        0,
        "c",
        "p",
      )
    ).toThrow("resume token is no longer valid");
    expect(() => registry.open("space", first, 0, "c", "p")).toThrow(
      "resume token is no longer valid",
    );
    expect(registry.get("space", opened.sessionId)?.ownerConnectionId).toBe(
      "b",
    );
  });

  it("refuses the token the latest open presented to an attempt that open superseded", () => {
    // Found in review: a resume the client gave up on carries the same key
    // and token as the one that replaced it, and can reach the server after
    // that one has restored the session.
    const registry = new SessionRegistry();
    const opened = registry.open(
      "space",
      { resumeKey: "key", resumeAttempt: 1 },
      0,
      "a",
      "p",
    );
    const resume = (attempt: number, connection: string) =>
      registry.open(
        "space",
        {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
          resumeKey: "key",
          resumeAttempt: attempt,
        },
        0,
        connection,
        "p",
      );

    resume(3, "c");
    for (const attempt of [2, 3, undefined]) {
      expect(() =>
        registry.open(
          "space",
          {
            sessionId: opened.sessionId,
            sessionToken: opened.sessionToken,
            resumeKey: "key",
            ...(attempt === undefined ? {} : { resumeAttempt: attempt }),
          },
          0,
          "b",
          "p",
        )
      ).toThrow("resume token is no longer valid");
    }
    expect(registry.get("space", opened.sessionId)?.ownerConnectionId).toBe(
      "c",
    );
    expect(resume(4, "d").resumed).toBe(true);
  });
});
