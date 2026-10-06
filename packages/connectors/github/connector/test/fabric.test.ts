import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { GithubFabricTarget } from "../src/fabric.ts";
import {
  githubFabricCellId,
  type GithubFabricConnection,
  readGithubFabricCell,
  writeGithubFabricCells,
} from "../src/fabric-storage.ts";
import type { GithubPullRequest } from "../src/types.ts";
import { createTransactionCommitReceipt } from "../../../../runner/src/storage/commit-receipt.ts";

async function readIndex(
  connection: GithubFabricConnection,
  cell: Cell<unknown>,
): Promise<Record<string, unknown>> {
  return await readGithubFabricCell(connection, cell) as Record<
    string,
    unknown
  >;
}

async function readDetail(
  connection: GithubFabricConnection,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (!isLinkRef(value)) throw new Error("detail is not a Fabric link");
  const cell = connection.runtime.getCellFromLink(
    linkRefPayload(value) as Parameters<Runtime["getCellFromLink"]>[0],
  );
  return await readGithubFabricCell(connection, cell) as Record<
    string,
    unknown
  >;
}

function pullRequest(): GithubPullRequest {
  return {
    id: "PR_42",
    number: 42,
    url: "https://github.com/common/labs/pull/42",
    title: "Pull request 42",
    repository: "common/labs",
    repositoryUrl: "https://github.com/common/labs",
    baseRefName: "main",
    baseRefOid: "base",
    headRefName: "feature",
    headRefOid: "head",
    headRepository: "ianh/labs",
    headRepositoryUrl: "https://github.com/ianh/labs",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checkState: "SUCCESS",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    observedAt: "2026-08-21T01:00:00.000Z",
    visibility: "visible",
    status: "green-and-can-land",
  };
}

async function createTestConnection(passphrase: string): Promise<{
  connection: GithubFabricConnection;
  close: () => Promise<void>;
}> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  let runtime: Runtime;
  try {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  } catch (error) {
    await storageManager.close();
    throw error;
  }
  return {
    connection: { runtime, spaceDid: signer.did() },
    close: async () => {
      try {
        await runtime.dispose();
      } finally {
        await storageManager.close();
      }
    },
  };
}

describe("GithubFabricTarget", () => {
  describe("instance members", () => {
    describe("publish()", () => {
      it("publishes details before a complete generation index", async () => {
        const fixture = await createTestConnection("GitHub connector test");
        const { connection } = fixture;
        try {
          const target = await GithubFabricTarget.open(connection, {
            host: " API.GITHUB.COM ",
            account: " IANH ",
          });
          expect(target.source).toEqual({
            host: "api.github.com",
            account: "ianh",
          });
          expect(await target.readPullRequests()).toEqual([]);
          expect(await target.readLastComplete()).toBeUndefined();
          expect(target.indexCellId().startsWith("of:")).toBe(false);
          expect(target.healthCellId().startsWith("of:")).toBe(false);
          const firstPublication = await target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T01:00:00.000Z",
            pullRequests: [pullRequest()],
          });
          expect(firstPublication.pullRequestCount).toBe(1);

          const first = await readIndex(connection, target.cells.index);
          expect(first.generation).toBe(1);
          expect(first.generatedAt).toBe(firstPublication.completedAt);
          expect(first.lastCompleteCollectionAt).toBe(
            "2026-08-21T01:00:00.000Z",
          );
          expect(await target.readLastComplete()).toEqual(firstPublication);
          const rows = first.pullRequests as Array<Record<string, unknown>>;
          expect(rows).toHaveLength(1);
          expect(rows[0].number).toBe(42);
          expect((await readDetail(connection, rows[0].detail)).number).toBe(
            42,
          );
          expect(await target.readPullRequests()).toEqual([pullRequest()]);
          await target.publishHealth({
            status: "healthy",
            checkedAt: "2026-08-21T01:30:00.000Z",
          });
          expect(await readGithubFabricCell(connection, target.cells.health))
            .toEqual({
              schema: "commonfabric.github-connector.health.v1",
              status: "healthy",
              checkedAt: "2026-08-21T01:30:00.000Z",
            });
          await expect(target.publish({
            viewer: "someone-else",
            observedAt: "2026-08-21T01:45:00.000Z",
            pullRequests: [],
          })).rejects.toThrow("does not match configured account");
          const unchanged = await readIndex(connection, target.cells.index);
          expect(unchanged.generation).toBe(1);
          const unchangedRows = unchanged.pullRequests as Array<
            Record<string, unknown>
          >;
          expect(unchangedRows[0].number).toBe(42);
          expect(
            (await readDetail(connection, unchangedRows[0].detail)).number,
          ).toBe(42);

          const secondPublication = await target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T02:00:00.000Z",
            pullRequests: [],
          });
          expect(secondPublication.pullRequestCount).toBe(0);
          const second = await readIndex(connection, target.cells.index);
          expect(second.generation).toBe(2);
          expect(second.lastCompleteCollectionAt).toBe(
            "2026-08-21T02:00:00.000Z",
          );
          expect(second.pullRequests).toEqual([]);
        } finally {
          await fixture.close();
        }
      });

      it("leaves prior detail links unchanged when the index write fails", async () => {
        const fixture = await createTestConnection(
          "GitHub connector failure test",
        );
        const { connection } = fixture;
        let target: GithubFabricTarget | undefined;
        let failIndexWrite = false;
        let detailPublishedBeforeFailure = false;
        const writeGraph: typeof writeGithubFabricCells = (conn, entries) => {
          const isIndexWrite = entries.some((entry) =>
            entry.cell === target?.cells.index
          );
          if (failIndexWrite && isIndexWrite) {
            return Promise.reject(new Error("index write failed"));
          }
          return writeGithubFabricCells(conn, entries).then(() => {
            if (failIndexWrite && !isIndexWrite) {
              detailPublishedBeforeFailure = true;
            }
          });
        };
        try {
          target = await GithubFabricTarget.open(
            connection,
            { host: "api.github.com", account: "ianh" },
            writeGraph,
          );
          await target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T01:00:00.000Z",
            pullRequests: [pullRequest()],
          });
          failIndexWrite = true;
          await expect(target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T02:00:00.000Z",
            pullRequests: [{
              ...pullRequest(),
              title: "Changed title",
              observedAt: "2026-08-21T02:00:00.000Z",
            }],
          })).rejects.toThrow("index write failed");
          expect(detailPublishedBeforeFailure).toBe(true);

          const index = await readIndex(connection, target.cells.index);
          const rows = index.pullRequests as Array<Record<string, unknown>>;
          expect(rows[0].title).toBe("Pull request 42");
          expect((await readDetail(connection, rows[0].detail)).title).toBe(
            "Pull request 42",
          );
        } finally {
          await fixture.close();
        }
      });

      it("rejects malformed prior indexes and rows", async () => {
        const fixture = await createTestConnection(
          "GitHub connector malformed index test",
        );
        const { connection } = fixture;
        try {
          const target = await GithubFabricTarget.open(connection, {
            host: "api.github.com",
            account: "ianh",
          });
          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: { schema: "unexpected", generation: 1 },
          }]);
          await expect(target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T01:00:00.000Z",
            pullRequests: [],
          })).rejects.toThrow("index has an invalid shape");

          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: {
              schema: "commonfabric.github-connector.pull-request-index.v1",
              formatVersion: 1,
              generation: 1,
              viewer: "ianh",
              pullRequests: [null],
            },
          }]);
          await expect(target.readPullRequests()).rejects.toThrow(
            "pull-request row is invalid: 0",
          );

          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: {
              schema: "commonfabric.github-connector.pull-request-index.v1",
              formatVersion: 1,
              generation: 1,
              viewer: "someone-else",
              pullRequests: [],
            },
          }]);
          await expect(target.readPullRequests()).rejects.toThrow(
            "index has an invalid shape",
          );

          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: {
              schema: "commonfabric.github-connector.pull-request-index.v1",
              formatVersion: 1,
              generation: 1,
              viewer: "ianh",
              lastCompleteCollectionAt: "2026-08-21T01:00:00.000Z",
              pullRequests: [],
            },
          }]);
          await expect(target.readLastComplete()).rejects.toThrow(
            "index has an invalid shape",
          );

          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: {
              schema: "commonfabric.github-connector.pull-request-index.v1",
              formatVersion: 1,
              generation: 1,
              viewer: "ianh",
              generatedAt: "2026-08-21T01:01:00.000Z",
              pullRequests: [],
            },
          }]);
          await expect(target.readLastComplete()).rejects.toThrow(
            "index has an invalid shape",
          );

          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: {
              schema: "commonfabric.github-connector.pull-request-index.v1",
              formatVersion: 1,
              generation: 1,
              viewer: "ianh",
              pullRequests: [{}],
            },
          }]);
          await expect(target.readPullRequests()).rejects.toThrow(
            "pull-request row is invalid: 0",
          );

          await writeGithubFabricCells(connection, [{
            cell: target.cells.index,
            value: {
              formatVersion: 1,
              generation: 1,
              viewer: "ianh",
              pullRequests: [],
            },
          }]);
          await expect(target.readPullRequests()).rejects.toThrow(
            "index has an invalid shape",
          );
        } finally {
          await fixture.close();
        }
      });
    });
  });

  describe("open()", () => {
    it("rejects an incomplete connector source before opening cells", async () => {
      const connection = {} as GithubFabricConnection;
      await expect(GithubFabricTarget.open(connection, {
        host: " ",
        account: "ianh",
      })).rejects.toThrow("must name a host and account");
      await expect(GithubFabricTarget.open(connection, {
        host: "api.github.com",
        account: "ianh\nother",
      })).rejects.toThrow("must not contain line breaks");
    });
  });
});

describe("Fabric storage", () => {
  const cell = {
    getAsNormalizedFullLink: () => ({ id: "of:fid1:test" }),
  } as unknown as Cell<unknown>;

  it("does nothing when an atomic write has no entries", async () => {
    const connection = {} as GithubFabricConnection;
    await expect(writeGithubFabricCells(connection, [])).resolves
      .toBeUndefined();
  });

  it("aborts the transaction when preparing a write fails", async () => {
    const failure = new Error("write failed");
    let abortedWith: unknown;
    let editCount = 0;
    let writeCount = 0;
    let commitCount = 0;
    const connection = {
      runtime: {
        edit: () => {
          editCount++;
          return {
            writeValueOrThrow: () => {
              writeCount++;
              if (writeCount === 2) throw failure;
            },
            abort: (error: unknown) => {
              abortedWith = error;
            },
            commit: () => {
              commitCount++;
              return createTransactionCommitReceipt(
                Promise.resolve({ error: undefined }),
              );
            },
          };
        },
      },
    } as unknown as GithubFabricConnection;
    const secondCell = {
      getAsNormalizedFullLink: () => ({ id: "of:fid1:second" }),
    } as unknown as Cell<unknown>;

    await expect(writeGithubFabricCells(connection, [
      { cell, value: { order: 1 } },
      { cell: secondCell, value: { order: 2 } },
    ]))
      .rejects.toThrow("write failed");
    expect(abortedWith).toBe(failure);
    expect(editCount).toBe(1);
    expect(writeCount).toBe(2);
    expect(commitCount).toBe(0);
  });

  it("reports every supported transaction commit error shape", async () => {
    const cases: Array<[unknown, string]> = [
      [new Error("error object"), "error object"],
      ["string error", "string error"],
      [{ message: "record error" }, "record error"],
      [{ message: "" }, "Fabric transaction commit failed"],
    ];
    for (const [error, message] of cases) {
      const connection = {
        runtime: {
          edit: () => ({
            writeValueOrThrow: () => {},
            abort: () => {},
            commit: () =>
              createTransactionCommitReceipt(Promise.resolve({ error })),
          }),
        },
      } as unknown as GithubFabricConnection;

      await expect(writeGithubFabricCells(connection, [{ cell, value: {} }]))
        .rejects.toThrow(message);
    }
  });

  it("normalizes Fabric cell identifiers", () => {
    expect(githubFabricCellId(cell)).toBe("fid1:test");
    const plain = {
      getAsNormalizedFullLink: () => ({ id: "fid1:plain" }),
    } as unknown as Cell<unknown>;
    expect(githubFabricCellId(plain)).toBe("fid1:plain");
  });
});
