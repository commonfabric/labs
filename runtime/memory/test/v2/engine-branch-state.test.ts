import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { spy } from "@std/testing/mock";

import { LINK_V1_TAG } from "@commonfabric/data-model/cell-rep";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  type BranchName,
  type Operation,
  resolveScopeKey,
  toDocumentPath,
} from "../../v2.ts";
import {
  applyCommit,
  close,
  ConflictError,
  createBranch,
  deleteBranch,
  type Engine,
  headSeq,
  open,
  PreconditionFailedError,
  ProtocolError,
  read,
  runAtomicCommit,
} from "../../v2/engine.ts";

describe("engine", () => {
  // Each read resolves its branch before it reads the document, and the
  // engine keeps what it learned of each branch between reads. These cases
  // pin what a read returns and throws as the `branch` table changes under
  // it, through this connection and another one, and how many statements a
  // read of a known branch costs.

  let engine: Engine;
  let path: string;
  let localSeq: number;
  const sessionId = "session:branch-state";
  const id = "of:branch-state";

  const setValue = (value: string, branch?: BranchName): number =>
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value } }],
        ...(branch === undefined ? {} : { branch }),
      },
    }).seq;

  const valueAt = (options: { branch?: BranchName; seq?: number } = {}) =>
    read(engine, { id, ...options })?.value;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  describe("createBranch()", () => {
    it("returns an existing branch for a repeat that names no fork point, after its parent moved on", () => {
      setValue("first");
      const created = createBranch(engine, "fork");
      setValue("second");

      expect(createBranch(engine, "fork")).toEqual(created);
    });

    it("throws for a repeat that names another fork point", () => {
      const first = setValue("first");
      setValue("second");
      createBranch(engine, "fork", { forkSeq: first });

      expect(() => createBranch(engine, "fork", { forkSeq: first + 1 }))
        .toThrow("branch name is taken: fork");
    });

    it("throws for the name of a deleted branch", () => {
      setValue("first");
      createBranch(engine, "fork");
      deleteBranch(engine, "fork");

      expect(() => createBranch(engine, "fork")).toThrow(
        "branch name is taken: fork",
      );
    });
  });

  describe("read()", () => {
    it("returns the value at the head and the value as of an older seq", () => {
      const first = setValue("first");
      const second = setValue("second");

      expect(headSeq(engine)).toBe(second);
      expect(valueAt()).toBe("second");
      expect(valueAt({ seq: first })).toBe("first");
    });

    it("returns the value a fork inherits from its parent as of the fork point", () => {
      setValue("before fork");
      createBranch(engine, "fork");
      setValue("after fork");

      expect(valueAt({ branch: "fork" })).toBe("before fork");
      expect(valueAt()).toBe("after fork");
    });

    it("returns a fork's own value over the one it inherits", () => {
      setValue("parent");
      createBranch(engine, "fork");
      setValue("fork", "fork");

      expect(valueAt({ branch: "fork" })).toBe("fork");
      expect(valueAt()).toBe("parent");
    });

    it("returns a fork's patches applied over the document it inherits", () => {
      const patch = (path: string, value: string, branch: BranchName) =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "add", path, value }],
            }],
            branch,
          },
        }).seq;
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: { kept: "parent" } } }],
        },
      });
      createBranch(engine, "fork");
      const first = patch("/value/first", "fork", "fork");
      patch("/value/second", "fork", "fork");

      expect(valueAt({ branch: "fork" })).toEqual({
        kept: "parent",
        first: "fork",
        second: "fork",
      });
      expect(valueAt({ branch: "fork", seq: first })).toEqual({
        kept: "parent",
        first: "fork",
      });
      expect(valueAt()).toEqual({ kept: "parent" });
    });

    it("throws for an unknown branch, and reads the branch once it exists", () => {
      setValue("parent");

      expect(() => valueAt({ branch: "later" })).toThrow(
        "unknown branch: later",
      );
      createBranch(engine, "later");
      expect(valueAt({ branch: "later" })).toBe("parent");
    });

    it("throws for a seq past the head", () => {
      const seq = setValue("only");

      expect(() => valueAt({ seq: seq + 1 })).toThrow(
        `seq ${seq + 1} is out of range for branch `,
      );
    });

    it("throws for a seq before a fork was created", () => {
      const before = setValue("first");
      setValue("second");
      createBranch(engine, "fork");

      expect(() => valueAt({ branch: "fork", seq: before })).toThrow(
        `seq ${before} is out of range for branch fork`,
      );
    });

    it("returns the value each commit writes as the head advances", () => {
      for (const value of ["one", "two", "three"]) {
        const seq = setValue(value);
        expect(headSeq(engine)).toBe(seq);
        expect(valueAt()).toBe(value);
      }
    });
  });

  describe("applyCommit() on a fork", () => {
    it("throws `ConflictError` for a commit that read an inherited document before its parent's last write to it, and leaves the fork's value", () => {
      const first = setValue("first");
      setValue("second");
      createBranch(engine, "fork");
      const commitOnFork = (seq: number) =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: {
              confirmed: [{ id, path: toDocumentPath([]), seq }],
              pending: [],
            },
            operations: [{ op: "set", id, value: { value: "fork" } }],
            branch: "fork",
          },
        });

      expect(() => commitOnFork(first)).toThrow(ConflictError);
      expect(valueAt({ branch: "fork" })).toBe("second");
    });

    it("writes a commit that read an inherited document as of the fork point, whatever its parent wrote since", () => {
      const atFork = setValue("at fork");
      createBranch(engine, "fork");
      setValue("parent, later");

      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: ++localSeq,
          reads: {
            confirmed: [{ id, path: toDocumentPath([]), seq: atFork }],
            pending: [],
          },
          operations: [{ op: "set", id, value: { value: "fork" } }],
          branch: "fork",
        },
      });

      expect(valueAt({ branch: "fork" })).toBe("fork");
    });

    describe("with an `entity-absent` precondition", () => {
      const setIfAbsent = (target: string, branch: BranchName) =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            preconditions: [{ kind: "entity-absent", id: target }],
            operations: [{ op: "set", id: target, value: { value: "fork" } }],
            branch,
          },
        });

      it("throws `PreconditionFailedError` for a document the fork inherits, and leaves it", () => {
        setValue("parent");
        createBranch(engine, "fork");

        expect(() => setIfAbsent(id, "fork")).toThrow(PreconditionFailedError);
        expect(valueAt({ branch: "fork" })).toBe("parent");
      });

      it("writes a document its parent created after the fork point", () => {
        setValue("parent");
        createBranch(engine, "fork");
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:later",
              value: { value: "parent" },
            }],
          },
        });

        setIfAbsent("of:later", "fork");

        expect(read(engine, { id: "of:later", branch: "fork" })?.value).toBe(
          "fork",
        );
        expect(read(engine, { id: "of:later" })?.value).toBe("parent");
      });
    });

    it("throws for a commit that writes a SQLite database", () => {
      setValue("parent");
      createBranch(engine, "fork");

      expect(() =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "sqlite",
              db: { id: "of:db" },
              sql: "INSERT INTO notes (body) VALUES ('fork')",
            }],
            branch: "fork",
          },
        })
      ).toThrow("cannot write a SQLite database");
    });

    it("returns a patch applied over an empty document for one neither the fork nor its parent holds", () => {
      setValue("parent");
      createBranch(engine, "fork");
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "of:fork-only",
            patches: [{ op: "add", path: "/value", value: "fork" }],
          }],
          branch: "fork",
        },
      });

      expect(read(engine, { id: "of:fork-only", branch: "fork" })).toEqual({
        value: "fork",
      });
      expect(read(engine, { id: "of:fork-only" })).toBeNull();
    });

    describe("with a move over a document the fork only inherits", () => {
      // The moving commit carries no reserved string of its own, so what it
      // may land in a schema position is decided by the document the fork
      // inherits, of which the fork holds no row.

      const reservedRef = "schema-ref@2:sha256:inherited";

      const move = (path: string) =>
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "move", from: "/value/harmless", path }],
            }],
            branch: "fork",
          },
        });

      beforeEach(() => {
        applyCommit(engine, {
          sessionId,
          commit: {
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id,
              value: {
                value: {
                  harmless: reservedRef,
                  ref: {
                    "/": {
                      [LINK_V1_TAG]: {
                        id: "of:target",
                        path: [],
                        schema: "opaque-schema-name",
                      },
                    },
                  },
                },
              },
            }],
          },
        });
        createBranch(engine, "fork");
      });

      it("throws `ProtocolError` for a move of an inherited reserved schema reference into a link's schema, and leaves the fork's document", () => {
        const landing = `/value/ref/~1/${LINK_V1_TAG}/schema`;

        expect(() => move(landing)).toThrow(ProtocolError);
        expect(() => move(landing)).toThrow(
          `may not persist reserved wire schema reference: ${reservedRef}`,
        );
        expect(valueAt({ branch: "fork" })).toEqual(valueAt());
      });

      it("writes a move of the same string to a position that is no schema", () => {
        move("/value/relocated");

        expect(valueAt({ branch: "fork" })).toMatchObject({
          relocated: reservedRef,
        });
      });
    });
  });

  describe("applyCommit() with the options of a restore", () => {
    // `scopeKeys` and `releasesOperationFields` are what a restore of a
    // branch writes with, and only a `system` commit may carry either.

    const userKey = resolveScopeKey("user", {
      principal: "did:key:z6Mk-branch-state-user",
      sessionId,
    });

    const commitWith = (
      options: {
        commitClass?: "system";
        scopeKeys?: Map<number, string>;
        releasesOperationFields?: boolean;
      },
      operation: Operation = { op: "set", id, value: { value: "written" } },
    ) =>
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [operation],
        },
        ...options,
      });

    const userScopedSet: Operation = {
      op: "set",
      id,
      scope: "user",
      value: { value: "written" },
    };

    it("throws `ProtocolError` for `releasesOperationFields` on a commit that is not `system`, and writes nothing", () => {
      expect(() => commitWith({ releasesOperationFields: true })).toThrow(
        "releasing a written document's operation fields is system-commit " +
          "admission only",
      );
      expect(() => commitWith({ releasesOperationFields: true })).toThrow(
        ProtocolError,
      );
      expect(headSeq(engine)).toBe(0);
    });

    it("throws `ProtocolError` for `scopeKeys` on a commit that is not `system`, and writes nothing", () => {
      const scopeKeys = new Map([[0, userKey]]);

      expect(() => commitWith({ scopeKeys }, userScopedSet)).toThrow(
        "explicit scope keys are system-commit admission only",
      );
      expect(() => commitWith({ scopeKeys }, userScopedSet)).toThrow(
        ProtocolError,
      );
      expect(headSeq(engine)).toBe(0);
    });

    it("writes a `system` commit's user-scoped operation to the instance `scopeKeys` names", () => {
      commitWith(
        { commitClass: "system", scopeKeys: new Map([[0, userKey]]) },
        userScopedSet,
      );

      expect(read(engine, { id, scopeKey: userKey })?.value).toBe("written");
      expect(valueAt()).toBeUndefined();
    });

    describe("given a `scopeKeys` entry that names no instance of its operation's scope", () => {
      const refusal = (scopeKey: string) =>
        `system commit rejected: scope_key "${scopeKey}" does not name an ` +
        "instance of the scope operation";

      it("throws `ProtocolError` for a user instance given to a space-scoped operation", () => {
        const scopeKeys = new Map([[0, userKey]]);

        expect(() => commitWith({ commitClass: "system", scopeKeys })).toThrow(
          `${refusal(userKey)} 0 writes`,
        );
        expect(() => commitWith({ commitClass: "system", scopeKeys })).toThrow(
          ProtocolError,
        );
        expect(headSeq(engine)).toBe(0);
      });

      it("throws for an entry past the commit's last operation", () => {
        const scopeKeys = new Map([[1, userKey]]);

        expect(() =>
          commitWith({ commitClass: "system", scopeKeys }, userScopedSet)
        ).toThrow(`${refusal(userKey)} 1 writes`);
      });

      it("throws for a key outside the scope key grammar", () => {
        const scopeKeys = new Map([[0, "user:"]]);

        expect(() =>
          commitWith({ commitClass: "system", scopeKeys }, userScopedSet)
        ).toThrow(`${refusal("user:")} 0 writes`);
      });
    });
  });

  describe("a fork of a fork", () => {
    /** Commits a `set` of the document on `branch` that read it as of `seq`. */
    const setHavingRead = (seq: number, value: string, branch: BranchName) =>
      applyCommit(engine, {
        sessionId,
        commit: {
          localSeq: ++localSeq,
          reads: {
            confirmed: [{ id, path: toDocumentPath([]), seq }],
            pending: [],
          },
          operations: [{ op: "set", id, value: { value } }],
          branch,
        },
      });

    it("returns the default branch's value as of the first fork point, through a fork that wrote nothing", () => {
      setValue("at first fork");
      createBranch(engine, "child");
      setValue("default, later");
      createBranch(engine, "grandchild", { parentBranch: "child" });

      expect(valueAt({ branch: "grandchild" })).toBe("at first fork");
    });

    it("returns its parent's value as of its own fork point, and its own value once it writes", () => {
      setValue("default");
      createBranch(engine, "child");
      setValue("child, before", "child");
      createBranch(engine, "grandchild", { parentBranch: "child" });
      setValue("child, after", "child");

      expect(valueAt({ branch: "grandchild" })).toBe("child, before");
      setValue("grandchild", "grandchild");
      expect(valueAt({ branch: "grandchild" })).toBe("grandchild");
      expect(valueAt({ branch: "child" })).toBe("child, after");
      expect(valueAt()).toBe("default");
    });

    it("throws `ConflictError` for a commit that read the document before the default branch's last write below the first fork point", () => {
      const first = setValue("first");
      setValue("second");
      createBranch(engine, "child");
      createBranch(engine, "grandchild", { parentBranch: "child" });

      expect(() => setHavingRead(first, "grandchild", "grandchild")).toThrow(
        ConflictError,
      );
      expect(valueAt({ branch: "grandchild" })).toBe("second");
    });

    it("throws `ConflictError` for a commit that read the document before its parent's last write below its fork point", () => {
      const onDefault = setValue("default");
      createBranch(engine, "child");
      setValue("child", "child");
      createBranch(engine, "grandchild", { parentBranch: "child" });

      expect(() => setHavingRead(onDefault, "grandchild", "grandchild"))
        .toThrow(ConflictError);
      expect(valueAt({ branch: "grandchild" })).toBe("child");
    });

    it("writes a commit that read the document as of the fork points, whatever both ancestors wrote since", () => {
      setValue("default");
      createBranch(engine, "child");
      const onChild = setValue("child", "child");
      createBranch(engine, "grandchild", { parentBranch: "child" });
      setValue("child, later", "child");
      setValue("default, later");

      setHavingRead(onChild, "grandchild", "grandchild");

      expect(valueAt({ branch: "grandchild" })).toBe("grandchild");
    });
  });

  describe("rollback", () => {
    it("returns the head a rolled-back commit would have advanced past", () => {
      const committed = setValue("committed");
      expect(valueAt()).toBe("committed");

      let headInside: number | undefined;
      expect(() =>
        runAtomicCommit(engine, (apply) => {
          apply({
            sessionId,
            commit: {
              localSeq: ++localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{ op: "set", id, value: { value: "rolled back" } }],
            },
          });
          headInside = headSeq(engine);
          throw new Error("abandon the commit");
        })
      ).toThrow("abandon the commit");

      expect(headInside).toBe(committed + 1);
      expect(headSeq(engine)).toBe(committed);
      expect(valueAt()).toBe("committed");
      expect(() => valueAt({ seq: committed + 1 })).toThrow(
        `seq ${committed + 1} is out of range for branch `,
      );
    });

    it("throws for a branch whose creation rolled back", () => {
      setValue("parent");

      expect(() =>
        engine.database.transaction(() => {
          createBranch(engine, "fork");
          expect(valueAt({ branch: "fork" })).toBe("parent");
          throw new Error("abandon the branch");
        })()
      ).toThrow("abandon the branch");

      expect(() => valueAt({ branch: "fork" })).toThrow(
        "unknown branch: fork",
      );
    });

    it("keeps an outer transaction's branch when a savepoint inside it rolls back", () => {
      setValue("parent");

      engine.database.transaction(() => {
        createBranch(engine, "kept");
        expect(() =>
          engine.database.transaction(() => {
            createBranch(engine, "dropped");
            expect(valueAt({ branch: "dropped" })).toBe("parent");
            throw new Error("abandon the savepoint");
          })()
        ).toThrow("abandon the savepoint");
        expect(() => valueAt({ branch: "dropped" })).toThrow(
          "unknown branch: dropped",
        );
      })();

      expect(valueAt({ branch: "kept" })).toBe("parent");
      expect(() => valueAt({ branch: "dropped" })).toThrow(
        "unknown branch: dropped",
      );
    });
  });

  describe("deleteBranch()", () => {
    it("makes a commit to a branch read before its deletion throw", () => {
      setValue("parent");
      createBranch(engine, "fork");
      setValue("fork", "fork");
      expect(valueAt({ branch: "fork" })).toBe("fork");

      deleteBranch(engine, "fork");

      expect(() => setValue("after delete", "fork")).toThrow(
        "branch is not active: fork",
      );
    });
  });

  describe("statements per read", () => {
    it("reads no `branch` row for a read of a branch already read", () => {
      setValue("warm");
      expect(valueAt()).toBe("warm");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      using documentRows = spy(engine.statement("selectCurrentLocal"), "get");
      expect(valueAt()).toBe("warm");

      expect(branchRows.calls).toHaveLength(0);
      expect(documentRows.calls).toHaveLength(1);
    });

    it("reads no `branch` row for a read at the head after a commit", () => {
      setValue("first");
      expect(valueAt()).toBe("first");
      setValue("second");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      expect(valueAt()).toBe("second");

      expect(branchRows.calls).toHaveLength(0);
    });

    it("reads the `branch` row once for reads at a seq past the head it knew", () => {
      setValue("first");
      expect(valueAt()).toBe("first");
      const second = setValue("second");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      expect(valueAt({ seq: second })).toBe("second");
      expect(valueAt({ seq: second })).toBe("second");

      expect(branchRows.calls).toHaveLength(1);
    });

    it("reads no `head` row for a read at a seq, even the head's", () => {
      // Another connection's commit between two statements of one read
      // moves the `head` table, so a read at a seq reads the revision rows
      // as of that seq.
      setValue("first");
      const second = setValue("second");
      expect(valueAt()).toBe("second");

      using headRows = spy(engine.statement("selectCurrentLocal"), "get");
      expect(valueAt({ seq: second })).toBe("second");

      expect(headRows.calls).toHaveLength(0);
    });

    it("reads no `branch` row for a warm read a fork inherits", () => {
      setValue("parent");
      createBranch(engine, "fork");
      expect(valueAt({ branch: "fork" })).toBe("parent");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      expect(valueAt({ branch: "fork" })).toBe("parent");

      expect(branchRows.calls).toHaveLength(0);
    });
  });

  describe("another connection", () => {
    // The serving loop's worker and the memory server beside it are two
    // connections to one store, each committing what the other then reads.

    let other: Engine;

    const otherValueAt = (
      options: { branch?: BranchName; seq?: number } = {},
    ) => read(other, { id, ...options })?.value;

    beforeEach(async () => {
      other = await open({ url: toFileUrl(path) });
    });

    afterEach(() => {
      close(other);
    });

    it("returns the value as of a seq the other's commit passed, and the value at the new head", () => {
      const first = setValue("first");
      expect(otherValueAt()).toBe("first");
      const second = setValue("second");

      expect(otherValueAt({ seq: first })).toBe("first");
      expect(otherValueAt({ seq: second })).toBe("second");
      expect(otherValueAt()).toBe("second");
      expect(() => otherValueAt({ seq: second + 1 })).toThrow(
        `seq ${second + 1} is out of range for branch `,
      );
    });

    it("throws for a branch until the other creates it, then returns its parent's value as of the fork point", () => {
      setValue("before the other read");
      expect(otherValueAt()).toBe("before the other read");
      expect(() => otherValueAt({ branch: "fork" })).toThrow(
        "unknown branch: fork",
      );
      setValue("at the fork point");
      createBranch(engine, "fork");
      setValue("after the fork");

      expect(otherValueAt({ branch: "fork" })).toBe("at the fork point");
      expect(otherValueAt()).toBe("after the fork");
    });
  });
});
