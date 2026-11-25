/**
 * Sessions of a branch, and the branch and history requests
 * (04-protocol.md §4.3.8), through a client over a real server: what a
 * session opened on a branch reads, writes and is sent, and what forking,
 * listing and restoring do to the space its other sessions see.
 */

import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  type BranchName,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  type ServerMessage,
  type SessionDescriptor,
  setServerExecutionConfig,
} from "../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { type AdmittedCommitNotice, Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/**
 * A loopback transport over a real server whose connection can be dropped,
 * recording the descriptor of every `session.open` the client sends.
 */
class DroppableTransport implements Transport {
  readonly opens: SessionDescriptor[] = [];

  /** Resolved when the client sends its second `session.open`: a reopen. */
  readonly reopened = Promise.withResolvers<void>();
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type?: string;
      session?: SessionDescriptor;
    };
    if (message.type === "session.open" && message.session !== undefined) {
      this.opens.push(message.session);
      if (this.opens.length === 2) this.reopened.resolve();
    }
    this.#connection ??= this.#server.connect((message) =>
      this.#receiver(encodeMemoryBoundary(message))
    );
    await this.#connection.receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }
}

describe("v2-branch-sessions", () => {
  const SPACE = "did:key:z6Mk-branch-sessions";
  const id = "of:doc";

  let server: Server;
  let client: Client;
  let main: SpaceSession;
  let localSeq: number;

  /** The clients a case connects beside `client`, which the teardown closes. */
  let clients: Client[];

  /** Connects another client to the server, and returns it. */
  const connected = async (): Promise<Client> => {
    const other = await connect({ transport: loopback(server) });
    clients.push(other);
    return other;
  };

  const mount = (branch?: BranchName): Promise<SpaceSession> =>
    client.mount(
      SPACE,
      branch === undefined ? {} : { branch },
      testSessionOpenAuthFactory,
    );

  /** Mounts a session that asks the server to fork `branch` if it is absent. */
  const mountForking = (branch: BranchName): Promise<SpaceSession> =>
    client.mount(
      SPACE,
      { branch, forkBranch: true },
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
    clients = [];
    main = await mount();
    localSeq = 0;
  });

  afterEach(async () => {
    for (const other of clients) await other.close();
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
      await updates.next();

      expect(view.entities.map((entity) => entity.document?.value))
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

    describe("with a view in its watch set", () => {
      const views = [{
        id: "screen",
        revision: 0,
        mode: "render" as const,
        componentContractVersion: "1",
        query,
      }];

      beforeEach(() => {
        setServerExecutionConfig(true);
      });

      afterEach(() => {
        resetServerExecutionConfig();
      });

      it("is sent the view's documents as its branch holds them", async () => {
        await set(main, "shared");
        await main.createBranch("fork");
        const viewer = await (await connected()).mount(
          SPACE,
          { branch: "fork" },
          testSessionOpenAuthFactory,
        );
        await set(viewer, "on fork");
        await set(main, "on main");

        const { view } = await viewer.viewSetSync(views);

        expect(
          view.entities.map((entity) => [
            entity.branch,
            entity.document?.value,
          ]),
        ).toEqual([["fork", "on fork"]]);
      });

      it("is sent the view's documents as the default branch holds them, for a session of the default branch", async () => {
        await set(main, "shared");
        await main.createBranch("fork");
        const fork = await mount("fork");
        await set(fork, "on fork");
        await set(main, "on main");
        const viewer = await (await connected()).mount(
          SPACE,
          {},
          testSessionOpenAuthFactory,
        );

        const { view } = await viewer.viewSetSync(views);

        expect(
          view.entities.map((entity) => [
            entity.branch,
            entity.document?.value,
          ]),
        ).toEqual([["", "on main"]]);
      });
    });

    describe("sending a request the server serves on the default branch alone", () => {
      // Each case sends the request on a session of the default branch as
      // well, where the server hands it on, so the refusal is the branch's.

      const refusal = (type: string) =>
        `\`${type}\` is served on a space's default branch only, and this ` +
        'session is of the branch "fork"';

      let lifecycle: string[];
      let onMain: SpaceSession;
      let onFork: SpaceSession;

      beforeEach(async () => {
        lifecycle = [];
        server.setPatternLifecycleHandler((call) => {
          lifecycle.push(call.sessionId);
          return Promise.resolve({ ok: {} });
        });
        server.setServedRequestHandler(() => Promise.resolve({ ok: {} }));
        await set(main, "value");
        await main.createBranch("fork");
        // The server advertises its handlers to a connection that says
        // `hello` after they are installed.
        const later = await connected();
        onMain = await later.mount(SPACE, {}, testSessionOpenAuthFactory);
        onFork = await later.mount(
          SPACE,
          { branch: "fork" },
          testSessionOpenAuthFactory,
        );
      });

      it("rejects for `entity-id.list`, which a session of the default branch is answered", async () => {
        await expect(onFork.listEntityIds()).rejects.toThrow(
          refusal("entity-id.list"),
        );
        expect((await onMain.listEntityIds())?.ids).toContain(id);
      });

      it("rejects for `pattern.lifecycle` and hands the server's handler nothing", async () => {
        await expect(onFork.runPatternLifecycle("upload", {})).rejects.toThrow(
          refusal("pattern.lifecycle"),
        );
        expect(lifecycle).toEqual([]);
        await onMain.runPatternLifecycle("upload", {});
        expect(lifecycle).toEqual([onMain.sessionId]);
      });

      it("rejects for `served` with the branch's refusal, where a session of the default branch is refused for its principal", async () => {
        await expect(onFork.runServed("append", {})).rejects.toThrow(
          refusal("served"),
        );
        // The test principal is not one the server takes a crossing from,
        // which is the refusal a session of the default branch reaches.
        await expect(onMain.runServed("append", {})).rejects.toThrow(
          "is admitted only from a session of the delegating class",
        );
      });

      it("rejects for `event.attention.resolve` with the branch's refusal, where a session of the default branch is refused for the event", async () => {
        await expect(
          onFork.resolveEventAttention("event:1", 1, "of:sidecar", "dismiss"),
        ).rejects.toThrow(refusal("event.attention.resolve"));
        await expect(
          onMain.resolveEventAttention("event:1", 1, "of:sidecar", "dismiss"),
        ).rejects.toThrow("has no authoritative attention cover");
      });
    });

    describe("reopened", () => {
      it("rejects for an open of its session that declares the default branch", async () => {
        await main.createBranch("fork");
        const fork = await mount("fork");

        await expect(
          client.openSession(SPACE, {
            sessionId: fork.sessionId,
            sessionToken: fork.sessionToken,
          }, testSessionOpenAuthFactory),
        ).rejects.toThrow(`session ${fork.sessionId} is of another branch`);
      });

      it("rejects for an open of its session that declares another branch", async () => {
        await main.createBranch("fork");
        await main.createBranch("other");
        const fork = await mount("fork");

        await expect(
          client.openSession(SPACE, {
            sessionId: fork.sessionId,
            sessionToken: fork.sessionToken,
            branch: "other",
          }, testSessionOpenAuthFactory),
        ).rejects.toThrow(`session ${fork.sessionId} is of another branch`);
      });

      it("rejects for an open of a default-branch session that declares a branch", async () => {
        await main.createBranch("fork");

        await expect(
          client.openSession(SPACE, {
            sessionId: main.sessionId,
            sessionToken: main.sessionToken,
            branch: "fork",
          }, testSessionOpenAuthFactory),
        ).rejects.toThrow(`session ${main.sessionId} is of another branch`);
      });

      it("resumes for an open of its session that declares its branch", async () => {
        await main.createBranch("fork");
        const fork = await mount("fork");

        const reopened = await client.openSession(SPACE, {
          sessionId: fork.sessionId,
          sessionToken: fork.sessionToken,
          branch: "fork",
        }, testSessionOpenAuthFactory);

        expect(reopened).toMatchObject({
          sessionId: fork.sessionId,
          resumed: true,
        });
      });
    });

    describe("against a server that does not advertise `branches`", () => {
      /** A transport to `server` whose `hello.ok` carries no `branches`. */
      const withoutBranches = (): Transport =>
        loopback({
          connect: (send, syncParts, options) =>
            server.connect(
              (message) =>
                send(
                  message.type === "hello.ok"
                    ? {
                      ...message,
                      flags: { ...message.flags, branches: false },
                    }
                    : message,
                ),
              syncParts,
              options,
            ),
        });

      it("rejects without opening a session on the server", async () => {
        await main.createBranch("fork");
        const older = await connect({ transport: withoutBranches() });
        clients.push(older);
        const before = server.sessionSnapshot(SPACE).length;

        await expect(
          older.mount(SPACE, { branch: "fork" }, testSessionOpenAuthFactory),
        ).rejects.toThrow(
          "memory server does not open a session on a branch (`branches` " +
            "is not among its protocol flags)",
        );
        expect(server.sessionSnapshot(SPACE)).toHaveLength(before);
      });

      it("rejects a branch or history request from a session of the default branch", async () => {
        const older = await connect({ transport: withoutBranches() });
        clients.push(older);
        const session = await older.mount(
          SPACE,
          {},
          testSessionOpenAuthFactory,
        );

        await expect(session.createBranch("fork")).rejects.toThrow(
          "memory server does not serve branch and history requests",
        );
        expect((await main.listBranches()).map((branch) => branch.name))
          .toEqual([""]);
      });
    });

    describe("opened with `forkBranch`", () => {
      it("is of a branch `listBranches()` lists as forked from the default branch's head, for a name the space has no branch of", async () => {
        const { seq } = await set(main, "shared");

        const fork = await mountForking("fork");

        expect(await main.listBranches()).toContainEqual({
          name: "fork",
          parentBranch: "",
          forkSeq: seq,
          createdSeq: seq,
          headSeq: seq,
          status: "active",
        });
        expect(await valueIn(fork)).toBe("shared");
      });

      it("writes to that branch and leaves the default branch as it was", async () => {
        await set(main, "shared");
        const fork = await mountForking("fork");

        await set(fork, "on fork");

        expect(await valueIn(fork)).toBe("on fork");
        expect(await valueIn(main)).toBe("shared");
      });

      it("reads what an earlier session of that name wrote, where the default branch has moved on since", async () => {
        const { seq } = await set(main, "shared");
        const first = await mountForking("fork");
        await set(first, "on fork");
        await set(main, "on main");

        const second = await mountForking("fork");

        expect(await valueIn(second)).toBe("on fork");
        expect(
          (await main.listBranches()).filter((branch) => branch.name !== "")
            .map(({ name, forkSeq }) => [name, forkSeq]),
        ).toEqual([["fork", seq]]);
      });

      it("reads the branch as it stands, for a branch another request made at an earlier point", async () => {
        const { seq } = await set(main, "before");
        await set(main, "after");
        await main.createBranch("fork", { forkSeq: seq });

        const fork = await mountForking("fork");

        expect(await valueIn(fork)).toBe("before");
      });

      it("rejects for a deleted branch, and leaves it deleted", async () => {
        await main.createBranch("fork");
        await main.deleteBranch("fork");

        await expect(mountForking("fork")).rejects.toThrow(
          'The space has no active branch "fork"',
        );
        expect(
          (await main.listBranches()).map(({ name, status }) => [name, status])
            .toSorted(),
        ).toEqual([["", "active"], ["fork", "deleted"]]);
      });

      it("rejects for a name the server refuses a branch, and the space gains none", async () => {
        await expect(mountForking("view-demand:fork")).rejects.toThrow(
          "a branch name must not begin with `view-demand:` or `view-support:`",
        );

        expect((await main.listBranches()).map((branch) => branch.name))
          .toEqual([""]);
      });

      it("rejects for an open that names no branch, and the space gains none", async () => {
        await expect(
          client.mount(
            SPACE,
            { forkBranch: true },
            testSessionOpenAuthFactory,
          ),
        ).rejects.toThrow(
          "a session that asks for its branch to be forked names the branch",
        );

        expect((await main.listBranches()).map((branch) => branch.name))
          .toEqual([""]);
      });

      it("rejects for a name of 129 characters, and the space gains no branch", async () => {
        await expect(mountForking("n".repeat(129))).rejects.toThrow(
          "branch name is too long",
        );
        expect((await main.listBranches()).map((branch) => branch.name))
          .toEqual([""]);
        expect(server.sessionSnapshot(SPACE)).toHaveLength(1);
      });

      it("resumes for an open of its session that declares its branch and `forkBranch`", async () => {
        const fork = await mountForking("fork");

        const reopened = await client.openSession(SPACE, {
          sessionId: fork.sessionId,
          sessionToken: fork.sessionToken,
          branch: "fork",
          forkBranch: true,
        }, testSessionOpenAuthFactory);

        expect(reopened).toMatchObject({
          sessionId: fork.sessionId,
          resumed: true,
        });
      });

      it("declares its branch and `forkBranch` on the reopen that follows a dropped connection, and reads its branch after it", async () => {
        await set(main, "shared");
        const transport = new DroppableTransport(server);
        const dropped = await connect({ transport });
        clients.push(dropped);
        const fork = await dropped.mount(
          SPACE,
          { branch: "fork", forkBranch: true },
          testSessionOpenAuthFactory,
        );
        await set(fork, "on fork");

        transport.disconnect();
        await transport.reopened.promise;
        await fork.whenRestored();

        expect(
          transport.opens.map(({ branch, forkBranch }) => [branch, forkBranch]),
        ).toEqual([["fork", true], ["fork", true]]);
        expect(await valueIn(fork)).toBe("on fork");
        expect(await valueIn(main)).toBe("shared");
      });

      it("declares no `forkBranch` on the reopen of a session mounted without it", async () => {
        await main.createBranch("fork");
        const transport = new DroppableTransport(server);
        const dropped = await connect({ transport });
        clients.push(dropped);
        const fork = await dropped.mount(
          SPACE,
          { branch: "fork" },
          testSessionOpenAuthFactory,
        );

        transport.disconnect();
        await transport.reopened.promise;
        await fork.whenRestored();

        expect(
          transport.opens.map(({ branch, forkBranch }) => [branch, forkBranch]),
        ).toEqual([["fork", undefined], ["fork", undefined]]);
      });
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
    const names = async () =>
      (await main.listBranches()).map((branch) => branch.name).toSorted();

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

    it("throws for a name that holds a control character", async () => {
      await set(main, "value");

      for (const name of ["fo\u0000rk", "fork\n", "\u001ffork", "fork\u007f"]) {
        await expect(main.createBranch(name)).rejects.toThrow(
          "a branch name must not hold a control character",
        );
      }
      expect(await names()).toEqual([""]);
    });

    it("throws for a name that begins `view-demand:` or `view-support:`", async () => {
      await set(main, "value");

      for (
        const name of ["view-demand:", "view-demand:fork", "view-support:"]
      ) {
        await expect(main.createBranch(name)).rejects.toThrow(
          "a branch name must not begin with `view-demand:` or `view-support:`",
        );
      }
      expect(await names()).toEqual([""]);
    });

    it("returns a branch for a name that holds `view-demand:` past its start", async () => {
      await set(main, "value");

      expect((await main.createBranch("my-view-demand:fork")).name).toBe(
        "my-view-demand:fork",
      );
    });

    it("throws for a name of 129 characters, and returns a branch for one of 128", async () => {
      await set(main, "value");

      await expect(main.createBranch("n".repeat(129))).rejects.toThrow(
        "branch name is too long",
      );
      expect((await main.createBranch("n".repeat(128))).name).toBe(
        "n".repeat(128),
      );
    });

    it("throws for a deleted parent", async () => {
      await set(main, "value");
      await main.createBranch("parent");
      await main.deleteBranch("parent");

      await expect(main.createBranch("child", { parentBranch: "parent" }))
        .rejects.toThrow("branch is not active: parent");
      expect(await names()).toEqual(["", "parent"]);
    });

    it("throws for a parent the space does not have", async () => {
      await set(main, "value");

      await expect(main.createBranch("child", { parentBranch: "missing" }))
        .rejects.toThrow("missing");
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
      await updates.next();

      expect(view.entities.map((entity) => entity.document?.value))
        .toEqual(["old"]);
      expect((await main.listHistory({ limit: 1 }))[0]).toMatchObject({
        seq,
        class: "system",
        restored: { branch: "", seq: then.seq },
      });
    });

    it("throws for a source other than the default branch, and leaves the default branch as it was", async () => {
      await set(main, "shared");
      await main.createBranch("fork");
      const fork = await mount("fork");
      await set(fork, "on fork");
      await set(main, "on main");

      await expect(main.restoreBranch({ source: "fork" })).rejects.toThrow(
        "a restore is served from the default branch's own history only",
      );
      expect(await valueIn(main)).toBe("on main");
    });

    it("returns `undefined` when the default branch already holds the state", async () => {
      const { seq } = await set(main, "value");

      expect(await main.restoreBranch({ sourceSeq: seq })).toBeUndefined();
    });
  });

  describe("a branch request naming a session its sender does not hold", () => {
    it("is answered `SessionError` on a connection other than the session's, and creates no branch", async () => {
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      try {
        await connection.receive(encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
        }));
        await connection.receive(encodeMemoryBoundary({
          type: "branch.create",
          requestId: "create-1",
          space: SPACE,
          sessionId: main.sessionId,
          name: "fork",
        }));

        expect(messages.at(-1)).toEqual({
          type: "response",
          requestId: "create-1",
          error: {
            name: "SessionError",
            message: "Session is not open on this connection",
          },
        });
        expect((await main.listBranches()).map((branch) => branch.name))
          .toEqual([""]);
      } finally {
        connection.close();
      }
    });

    it("returns a `SessionError` response from `Server.branchRequest()` for a session the server does not have", async () => {
      expect(
        await server.branchRequest({
          type: "branch.list",
          requestId: "list-1",
          space: SPACE,
          sessionId: "session:unknown",
        }),
      ).toEqual({
        type: "response",
        requestId: "list-1",
        error: {
          name: "SessionError",
          message: "Unknown session for space",
        },
      });
    });
  });
});
