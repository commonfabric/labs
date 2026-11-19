/**
 * Sessions of a branch, and the branch and history requests
 * (04-protocol.md §4.3.8), through a client over a real server: what a
 * session opened on a branch reads, writes and is sent, and what forking,
 * listing and restoring do to the space its other sessions see.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { BranchName, FabricValue } from "../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "../v2/client.ts";
import { type AdmittedCommitNotice, Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("branch sessions", () => {
  const SPACE = "did:key:z6Mk-branch-sessions";
  const id = "of:doc";

  let server: Server;
  let client: Client;
  let main: SpaceSession;
  let localSeq: number;

  const mount = (branch?: BranchName): Promise<SpaceSession> =>
    client.mount(
      SPACE,
      branch === undefined ? {} : { branch },
      testSessionOpenAuthFactory,
    );

  const set = (
    session: SpaceSession,
    value: string,
    doc = id,
  ): Promise<{ seq: number }> =>
    session.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: doc, value: { value } }],
    });

  const query = { roots: [{ id, selector: { path: [], schema: false } }] };

  const valueIn = async (session: SpaceSession): Promise<FabricValue> =>
    (await session.queryGraph(query)).entities[0]?.document?.value;

  beforeEach(async () => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://branch-sessions-${crypto.randomUUID()}`),
    });
    client = await connect({ transport: loopback(server) });
    main = await mount();
    localSeq = 0;
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  describe("a session opened on a branch", () => {
    it("reads what the branch held at its fork point", async () => {
      const { seq } = await set(main, "before");
      await set(main, "after");
      await main.createBranch("fork", { forkSeq: seq });

      const fork = await mount("fork");

      expect(await valueIn(fork)).toBe("before");
      expect(await valueIn(main)).toBe("after");
    });

    it("writes to its branch and leaves the default branch as it was", async () => {
      await set(main, "shared");
      await main.createBranch("fork");
      const fork = await mount("fork");

      await set(fork, "on fork");

      expect(await valueIn(fork)).toBe("on fork");
      expect(await valueIn(main)).toBe("shared");
    });

    it("is sent its branch's commits and none of the default branch's", async () => {
      await set(main, "shared");
      await main.createBranch("fork");
      const watcher = await mount("fork");
      const writer = await mount("fork");
      const view = await watcher.watchSet([{
        id: "root",
        kind: "graph",
        query,
      }]);
      const updates = view.subscribe();

      await set(main, "on main");
      await set(writer, "on fork");
      const update = await updates.next();

      expect(update.value.entities.map((entity) => entity.document?.value))
        .toEqual(["on fork"]);
      expect(view.entities.map((entity) => entity.branch)).toEqual(["fork"]);
    });

    it("lists its branch's history when it names no branch", async () => {
      const before = await set(main, "before");
      await main.createBranch("fork");
      await set(main, "on main");
      const fork = await mount("fork");
      const onFork = await set(fork, "on fork");

      const commits = await fork.listHistory();

      expect(commits.map((commit) => commit.seq))
        .toEqual([onFork.seq, before.seq]);
    });

    it("tells the space's serving loop of no commit", async () => {
      const notices: AdmittedCommitNotice[] = [];
      server.watchAdmittedCommits((notice) => notices.push(notice));
      await main.createBranch("fork");
      const fork = await mount("fork");

      await set(fork, "on fork");
      const onMain = await set(main, "on main");

      expect(notices.map((notice) => notice.seq)).toEqual([onMain.seq]);
    });

    it("is refused a request the server serves on the default branch alone", async () => {
      await set(main, "value");
      await main.createBranch("fork");
      const fork = await mount("fork");

      await expect(fork.entityIdExists(id)).rejects.toThrow(
        "is served on a space's default branch only",
      );
      expect((await main.entityIdExists(id))?.exists).toBe(true);
    });

    it("is refused for a branch the space does not have", async () => {
      await expect(mount("missing")).rejects.toThrow(
        'The space has no active branch "missing"',
      );
    });

    it("is refused for a deleted branch", async () => {
      await main.createBranch("fork");
      await main.deleteBranch("fork");

      await expect(mount("fork")).rejects.toThrow(
        'The space has no active branch "fork"',
      );
    });
  });

  describe("createBranch()", () => {
    it("returns a branch forked from the default branch's head", async () => {
      const { seq } = await set(main, "value");

      expect(await main.createBranch("fork")).toEqual({
        name: "fork",
        parentBranch: "",
        forkSeq: seq,
        createdSeq: seq,
        headSeq: seq,
        status: "active",
      });
    });

    it("throws for a fork point past the parent's head", async () => {
      const { seq } = await set(main, "value");

      await expect(main.createBranch("fork", { forkSeq: seq + 1 })).rejects
        .toThrow(`seq ${seq + 1} is out of range for branch `);
    });

    it("throws for a name another fork point holds", async () => {
      const { seq } = await set(main, "value");
      const later = await set(main, "later");
      await main.createBranch("fork", { forkSeq: seq });

      await expect(main.createBranch("fork", { forkSeq: later.seq })).rejects
        .toThrow(
          "branch name is taken: fork",
        );
    });
  });

  describe("listBranches()", () => {
    it("returns the default branch and every fork, deleted ones included", async () => {
      await set(main, "value");
      await main.createBranch("kept");
      await main.createBranch("dropped");
      await main.deleteBranch("dropped");

      const branches = await main.listBranches();

      expect(branches.map(({ name, status }) => [name, status]).toSorted())
        .toEqual([["", "active"], ["dropped", "deleted"], ["kept", "active"]]);
    });
  });

  describe("restoreBranch()", () => {
    it("sets the default branch to an earlier point and sends its watchers the change", async () => {
      const then = await set(main, "old");
      await set(main, "new");
      const watcher = await mount();
      const view = await watcher.watchSet([{
        id: "root",
        kind: "graph",
        query,
      }]);
      const updates = view.subscribe();

      const seq = await main.restoreBranch({ sourceSeq: then.seq });
      const update = await updates.next();

      expect(update.value.entities.map((entity) => entity.document?.value))
        .toEqual(["old"]);
      expect((await main.listHistory({ limit: 1 }))[0]).toMatchObject({
        seq,
        class: "system",
        restored: { branch: "", seq: then.seq },
      });
    });

    it("sets the default branch to what a fork holds", async () => {
      await set(main, "shared");
      await main.createBranch("fork");
      const fork = await mount("fork");
      await set(fork, "on fork");
      await set(main, "on main");

      await main.restoreBranch({ source: "fork" });

      expect(await valueIn(main)).toBe("on fork");
    });

    it("returns `undefined` when the default branch already holds the state", async () => {
      const { seq } = await set(main, "value");

      expect(await main.restoreBranch({ sourceSeq: seq })).toBeUndefined();
    });
  });
});
