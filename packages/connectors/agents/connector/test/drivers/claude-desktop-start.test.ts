import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  ClaudeAgentSdkDriver,
  type ClaudeDesktopDeps,
  type ClaudeSdkAdapter,
} from "../../src/drivers/claude-agent-sdk.ts";

type SessionInfo = Awaited<
  ReturnType<ClaudeSdkAdapter["listSessions"]>
>[number];

const START_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT = "Work on topic #7";
const CWD = "/work/labs";

/** A controllable SDK inventory and opener, with no filesystem or app access. */
function setup() {
  const sessions: SessionInfo[] = [];
  const opened: string[] = [];
  const state = { now: 1_000_000 };
  const sdk: ClaudeSdkAdapter = {
    listSessions: (options) =>
      Promise.resolve(
        sessions.slice(
          options?.offset ?? 0,
          options?.limit === undefined
            ? undefined
            : (options.offset ?? 0) + options.limit,
        ),
      ),
    getSessionInfo: (id) =>
      Promise.resolve(sessions.find((session) => session.sessionId === id)),
    getSessionMessages: () => Promise.resolve([]),
    renameSession: () => Promise.resolve(),
    query: () => {
      throw new Error("A desktop start must not run a query");
    },
  };
  const desktop: ClaudeDesktopDeps = {
    os: "darwin",
    now: () => state.now,
    installed: () => Promise.resolve(true),
    isDirectory: () => Promise.resolve(true),
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: CWD,
      configDir: "/config/claude-desktop-test",
    },
    sdk,
    desktop,
  );
  const session = (createdAt?: number): SessionInfo => ({
    sessionId: SESSION_ID,
    summary: PROMPT,
    firstPrompt: PROMPT,
    cwd: CWD,
    createdAt,
    lastModified: state.now,
  });
  const start = () =>
    driver.startSession(START_ID, { text: PROMPT, surface: "desktop" });
  return { driver, sdk, desktop, sessions, opened, state, session, start };
}

describe("ClaudeAgentSdkDriver", () => {
  describe("instance members", () => {
    describe("startSession()", () => {
      it("excludes sessions created since the last inventory, including later pages and missing timestamps", async () => {
        const f = setup();
        await f.driver.listSessions();
        for (let index = 0; index < 101; index++) {
          f.sessions.push({
            ...f.session(f.state.now - 3_000),
            sessionId: `existing-${index}`,
          });
        }
        f.sessions.push(f.session());
        const listSessions = f.sdk.listSessions;
        let inventoryConfigDir: string | undefined;
        let inventoryDirectory: string | undefined;
        f.sdk.listSessions = (options) => {
          if (f.opened.length === 0) {
            inventoryConfigDir = Deno.env.get("CLAUDE_CONFIG_DIR");
            inventoryDirectory = options?.dir;
          }
          return listSessions(options);
        };

        expect((await f.start()).status).toBe("succeeded");
        for (const cursor of [undefined, "100"]) {
          const page = await f.driver.listSessions(cursor);
          expect(
            page.sessions.every((session) => session.startedAs === undefined),
          )
            .toBe(true);
        }
        expect(inventoryConfigDir).toBe("/config/claude-desktop-test");
        expect(inventoryDirectory).toBe(CWD);
        f.state.now += 1_000;
        f.sessions.unshift({
          ...f.session(f.state.now),
          sessionId: "new-session",
        });
        expect((await f.driver.readSession("new-session")).summary.startedAs)
          .toBe(START_ID);
      });

      it("pairs a new session listed while the opener is pending", async () => {
        const f = setup();
        const entered = Promise.withResolvers<void>();
        const opening = Promise.withResolvers<boolean>();
        f.desktop.openUrl = () => {
          entered.resolve();
          return opening.promise;
        };
        const starting = f.start();
        await entered.promise;
        try {
          f.sessions.push(f.session(f.state.now));
          expect((await f.driver.listSessions()).sessions[0].startedAs)
            .toBeUndefined();
          f.state.now += 10_000;
        } finally {
          opening.resolve(true);
        }
        expect((await starting).status).toBe("succeeded");
        expect((await f.driver.readSession(SESSION_ID)).summary.startedAs)
          .toBe(START_ID);
      });

      it("leaves sessions older than the launch boundary or without creation evidence unpaired", async () => {
        const f = setup();
        expect((await f.start()).status).toBe("succeeded");
        f.sessions.push(
          { ...f.session(f.state.now - 1), sessionId: "older" },
          { ...f.session(), sessionId: "undated" },
          { ...f.session(NaN), sessionId: "invalid-date" },
        );
        expect((await f.driver.listSessions()).sessions.map((s) => s.startedAs))
          .toEqual([undefined, undefined, undefined]);
        f.sessions.push(f.session(f.state.now));
        expect((await f.driver.readSession(SESSION_ID)).summary.startedAs)
          .toBe(START_ID);
      });

      it("returns a retryable failure without opening the app when inventory fails", async () => {
        const f = setup();
        f.sdk.listSessions = () =>
          Promise.reject(new Error("inventory unavailable"));
        const result = await f.start();
        expect(result.status).toBe("failed");
        expect(result.error?.retryable).toBe(true);
        expect(result.affectedSession).toBeNull();
        expect(f.opened).toEqual([]);
      });

      it("leaves no pairing behind when the opener fails", async () => {
        const f = setup();
        f.desktop.openUrl = () => Promise.resolve(false);
        expect((await f.start()).status).toBe("failed");
        f.sessions.push(f.session(f.state.now));
        expect((await f.driver.listSessions()).sessions[0].startedAs)
          .toBeUndefined();
      });

      it("returns a stopped result without opening the app when stopped during inventory", async () => {
        const f = setup();
        const entered = Promise.withResolvers<void>();
        const inventory = Promise.withResolvers<SessionInfo[]>();
        f.sdk.listSessions = () => {
          entered.resolve();
          return inventory.promise;
        };
        const starting = f.start();
        await entered.promise;
        try {
          await f.driver.stop();
        } finally {
          inventory.resolve([]);
        }
        expect((await starting).error?.code).toBe("claude-driver-stopped");
        expect(f.opened).toEqual([]);
      });
    });
  });
});
