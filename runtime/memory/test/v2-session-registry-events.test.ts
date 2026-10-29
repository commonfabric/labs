import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type SessionLifecycleEvent,
  SessionRegistry,
} from "../v2/session-registry.ts";

const space = "did:key:z6MkSessionRegistryEventsSpace";

const openSession = (
  registry: SessionRegistry,
  sessionId: string,
  connection = `connection-${sessionId}`,
) =>
  registry.open(
    space,
    { sessionId, sessionToken: `token-${sessionId}` },
    0,
    connection,
    `did:key:z6Mk${sessionId}`,
  );

describe("session-registry", () => {
  describe("lifecycle events", () => {
    it("reports a session opened, detached with its expiry, and removed to its observer", () => {
      const registry = new SessionRegistry({ ttlMs: 60_000 });
      const events: SessionLifecycleEvent[] = [];
      registry.setObserver((event) => events.push(event));

      openSession(registry, "one");
      registry.detach(space, "one", "connection-one");
      registry.remove(space, "one");

      expect(events.map((event) => event.kind)).toEqual([
        "opened",
        "detached",
        "removed",
      ]);
      expect(events[0]).toEqual({
        kind: "opened",
        space,
        sessionId: "one",
        principal: "did:key:z6Mkone",
      });
      const detached = events[1];
      expect(detached.kind === "detached" && detached.expiresAt > Date.now())
        .toBe(true);
      expect(events[2]).toEqual({ kind: "removed", space, sessionId: "one" });
    });

    it("reports nothing once the observer is withdrawn", () => {
      const registry = new SessionRegistry();
      const events: SessionLifecycleEvent[] = [];
      registry.setObserver((event) => events.push(event));
      registry.setObserver(undefined);

      openSession(registry, "quiet");

      expect(events).toEqual([]);
    });

    it("snapshots every live session as an opened event, with a detached event after one awaiting its expiry", () => {
      const registry = new SessionRegistry({ ttlMs: 60_000 });
      openSession(registry, "attached");
      openSession(registry, "waiting");
      registry.detach(space, "waiting", "connection-waiting");

      const snapshot = registry.snapshot();

      expect(snapshot.map((event) => [event.kind, event.sessionId])).toEqual([
        ["opened", "attached"],
        ["opened", "waiting"],
        ["detached", "waiting"],
      ]);
    });
  });
});
