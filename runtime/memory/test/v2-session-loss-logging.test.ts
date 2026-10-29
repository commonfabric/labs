import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** How many times the memory client has logged a terminated session. */
const terminatedSessions = (): number =>
  getLoggerCountsBreakdown()["memory.v2.client"]?.["session-terminated"]
    ?.error ?? 0;

/**
 * Takes a session over from a second client and then resumes it from a third
 * with the stale token, capturing every line the client and server log.
 */
async function takeOverAndRefuse(label: string, sessionId?: string) {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://session-loss-logging-${label}`),
  });
  const space = "did:key:z6Mk-session-loss-logging";
  const holder = await connect({ transport: loopback(server) });
  const taker = await connect({ transport: loopback(server) });
  const late = await connect({ transport: loopback(server) });
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const warn = stub(console, "warn", capture);
  const error = stub(console, "error", capture);
  try {
    const held = await holder.mount(
      space,
      sessionId === undefined ? {} : { sessionId },
      testSessionOpenAuthFactory,
    );
    const stale = {
      sessionId: held.sessionId,
      sessionToken: held.sessionToken,
    };
    const before = terminatedSessions();
    const taken = await taker.mount(space, stale, testSessionOpenAuthFactory);
    const refused = late.mount(space, stale, testSessionOpenAuthFactory);
    return {
      held,
      takenError: taken.closeError,
      space,
      lines,
      terminated: terminatedSessions() - before,
      refused: await refused.then(() => undefined, (cause: Error) => cause),
    };
  } finally {
    warn.restore();
    error.restore();
    await holder.close();
    await taker.close();
    await late.close();
    await server.close();
  }
}

describe("memory session loss logging", () => {
  it("records a session taken over by another connection, and a resume refused for a stale token", async () => {
    const { held, takenError, space, lines, terminated, refused } =
      await takeOverAndRefuse("records");
    const id = JSON.stringify(held.sessionId);
    expect(held.closeError?.name).toBe("SessionRevokedError");
    expect(takenError).toBeUndefined();
    expect(terminated).toBe(1);
    expect(refused?.message).toContain("resume token is no longer valid");
    expect(
      lines.some((line) =>
        line.includes(`session ${id} on ${JSON.stringify(space)} moved from`)
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes(`refused to resume session ${id}`)),
    )
      .toBe(true);
    expect(
      lines.some((line) =>
        line.includes(`session-terminated session ${id} on`)
      ),
    ).toBe(true);
  });

  it("keeps a line break in a session id from starting a log record of its own", async () => {
    // Found in review: a session id is the opener's text, and the refusal's
    // message repeats it.
    const forged = "\n[ERROR] forged log record";
    const { lines } = await takeOverAndRefuse(
      "forged",
      "session:legit" + forged,
    );
    const naming = lines.filter((line) => line.includes("session:legit"));
    expect(naming.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(line).not.toContain(forged);
    expect(naming.every((line) => line.includes("\\n[ERROR] forged"))).toBe(
      true,
    );
  });
});
