import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  type AdmittedCommitNotice,
  Server,
  SessionRegistry,
} from "../../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

describe("Server", () => {
  describe("instance members", () => {
    describe("watchAdmittedCommits()", () => {
      let server: Server;
      let space: string;
      let sessionId: string;
      let localSeq: number;
      let warnings: string[];
      let realWarn: typeof console.warn;

      beforeEach(() => {
        const sessions = new SessionRegistry();
        server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL(`memory://admitted-commits-${crypto.randomUUID()}`),
          sessions,
          subscriptionRefreshDelayMs: "manual",
        });
        space = "did:key:z6Mk-admitted-commits";
        ({ sessionId } = sessions.open(
          space,
          {},
          0,
          "admitted-commits",
          TEST_SESSION_OPEN_PRINCIPAL,
        ));
        localSeq = 0;
        warnings = [];
        realWarn = console.warn;
        console.warn = (...args: unknown[]) => {
          warnings.push(args.map((arg) => String(arg)).join(" "));
        };
      });

      afterEach(async () => {
        console.warn = realWarn;
        await server.close();
      });

      /** One authored commit, writing `id`. */
      const write = async (id: string): Promise<void> => {
        const result = await server.transact({
          type: "transact",
          requestId: `write-${++localSeq}`,
          space,
          sessionId,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id, value: { value: { at: localSeq } } }],
          },
        });
        expect(result.error).toBeUndefined();
      };

      it("reports each admitted commit to every watcher", async () => {
        const first: AdmittedCommitNotice[] = [];
        const second: AdmittedCommitNotice[] = [];
        server.watchAdmittedCommits((notice) => first.push(notice));
        server.watchAdmittedCommits((notice) => second.push(notice));

        await write("of:one");

        expect(first).toHaveLength(1);
        expect(second).toEqual(first);
        expect(first[0]).toMatchObject({
          space,
          class: "authored",
          sessionId,
        });
        expect(first[0].writes.map((entry) => entry.id)).toContain("of:one");
        expect(first[0].seq).toBeGreaterThan(0);
      });

      it("reports the host's own observer as well as the watchers", async () => {
        const observed: AdmittedCommitNotice[] = [];
        const watched: AdmittedCommitNotice[] = [];
        server.setServerExecutionObserver({
          commitAdmitted: (notice) => observed.push(notice),
        });
        server.watchAdmittedCommits((notice) => watched.push(notice));

        await write("of:one");

        expect(observed).toHaveLength(1);
        expect(watched).toEqual(observed);
      });

      it("stops reporting to a watcher once its detach has been called", async () => {
        const seen: AdmittedCommitNotice[] = [];
        const detach = server.watchAdmittedCommits((notice) =>
          seen.push(notice)
        );

        await write("of:one");
        detach();
        await write("of:two");

        expect(seen.map((notice) => notice.writes[0].id)).toEqual(["of:one"]);
      });

      it("admits the commit and reports the watchers when the host's observer throws", async () => {
        const watched: AdmittedCommitNotice[] = [];
        server.setServerExecutionObserver({
          commitAdmitted: () => {
            throw new Error("observer blew up");
          },
        });
        server.watchAdmittedCommits((notice) => watched.push(notice));

        await write("of:one");

        expect(watched).toHaveLength(1);
        expect(warnings.join("\n")).toContain(
          "server-execution observer threw on commitAdmitted",
        );
      });

      it("admits the commit and reports the other watchers when one throws", async () => {
        const after: AdmittedCommitNotice[] = [];
        server.watchAdmittedCommits(() => {
          throw new Error("watcher blew up");
        });
        server.watchAdmittedCommits((notice) => after.push(notice));

        await write("of:one");

        expect(after).toHaveLength(1);
        expect(warnings.join("\n")).toContain("admitted-commit watcher threw");
      });
    });
  });
});
