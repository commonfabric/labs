import {
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { expect } from "@std/expect";

import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  type Options,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import {
  agentFabricCauses,
  AgentFabricTarget,
  createAgentFabricCells,
} from "../src/fabric.ts";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentOwnerSchema,
  agentPrincipalSchema,
  cellHasOwnerProtection,
  pushStableCellGraph,
  readStableCellGraphValue,
  stableCellId,
} from "../src/fabric-graph.ts";
import {
  materializeStableArrayCells,
  planStableArrayCells,
} from "../src/array-cell-identity.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "../src/protocol.ts";
import type { AgentSessionCommandReceipt } from "../src/commands.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SourceDescriptor,
} from "../src/types.ts";
import { commandReceiptCause, sessionKey } from "../src/session-contract.ts";
import {
  type GitCommandRunner,
  GitContextResolver,
} from "../src/git-context.ts";

async function publishedManifestCell(
  connection: Parameters<typeof readStableCellGraphValue>[0],
  target: AgentFabricTarget,
  nativeSessionId: string,
): Promise<Cell<unknown>> {
  const index = await readStableCellGraphValue(
    connection,
    target.cells.allIndex,
    new Map(),
    { preserveLinkFields: new Set(["manifest"]) },
  ) as Record<string, unknown>;
  const row = (index.sessions as Array<Record<string, unknown>>).find(
    (session) => session.nativeSessionId === nativeSessionId,
  );
  if (!row || !isLinkRef(row.manifest)) {
    throw new Error(`session manifest link is unavailable: ${nativeSessionId}`);
  }
  return connection.runtime.getCellFromLink(
    linkRefPayload(row.manifest) as Parameters<
      Runtime["getCellFromLink"]
    >[0],
  );
}

Deno.test("Fabric target validates a discovered checkout", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector checkout validation test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const connection = {
    runtime,
    spaceDid: signer.did(),
    ownerDid: signer.did(),
  };
  const calls: string[][] = [];
  let receivedSignal: AbortSignal | undefined;
  const gitContext = new GitContextResolver(
    (args, signal) => {
      calls.push(args);
      receivedSignal = signal;
      return Promise.resolve({
        code: 0,
        stdout: "/requested-checkout\n",
      });
    },
    () => new Date("2026-08-21T00:00:00.000Z"),
    (path) => Promise.resolve(path),
  );
  const controller = new AbortController();
  try {
    const target = await AgentFabricTarget.open(connection, gitContext);
    assertEquals(
      await target.validateCheckout(
        "/requested-checkout",
        controller.signal,
      ),
      true,
    );
    assertEquals(calls, [[
      "-C",
      "/requested-checkout",
      "rev-parse",
      "--show-toplevel",
    ]]);
    assertStrictEquals(receivedSignal, controller.signal);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

const EMULATED_AUDIENCE = "did:key:z6Mk-agent-connector-isolation-test";

class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.#sharedServer = server;
    return manager;
  }

  #sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.#sharedServer;
  }
}

async function assertOwnerProtectedGraph(
  runtime: Runtime,
  root: Cell<unknown>,
  ownerDid: string,
): Promise<number> {
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const cell = pending.shift()!;
    const cellLink = cell.getAsNormalizedFullLink();
    const key = JSON.stringify({
      space: cellLink.space,
      id: cellLink.id,
      scope: cellLink.scope,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    await cell.sync();
    await runtime.storageManager.synced();
    assertEquals(
      cellHasOwnerProtection(runtime.readTx(), cell, ownerDid),
      true,
      String(cellLink.id),
    );
    const visit = (value: unknown): void => {
      if (isLinkRef(value)) {
        const link = linkRefPayload(value);
        if (typeof link.id === "string") {
          pending.push(runtime.getCellFromLink(
            {
              ...link,
              space: link.space ?? cellLink.space,
              scope: link.scope ?? cellLink.scope,
              path: [],
            } as Parameters<Runtime["getCellFromLink"]>[0],
          ));
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(visit);
      }
    };
    visit(cell.getRaw());
  }
  return seen.size;
}

Deno.test("Fabric target publishes sessions and command receipts", async () => {
  const signer = await Identity.fromPassphrase("agent connector target test");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const writeReceiptIndex = async (value: Record<string, unknown>) => {
      const plan = await planStableArrayCells({ ownerDid: space, ...value }, {
        spaceDid: space,
        agentConnector: "receipt-index-test-array-elements",
      });
      await pushStableCellGraph(connection, [{
        cell: target.cells.receipts,
        value: (materializeCell) =>
          materializeStableArrayCells(
            plan,
            materializeCell,
          ) as Record<string, unknown>,
      }]);
    };
    const source: SourceDescriptor = {
      id: "codex:test",
      driver: "codex-app-server",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: false,
        setConfigOption: false,
      },
    };
    const snapshot: NativeSessionSnapshot = {
      summary: {
        nativeSessionId: "session-1",
        title: "First session",
        cwd: null,
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: new Date().toISOString(),
        archived: false,
        active: false,
        raw: { id: "session-1", title: "First session" },
      },
      events: [{ type: "message", text: "hello" }],
      normalizedMessages: [{
        id: "message-1",
        role: "user",
        kind: "message",
        createdAt: "2026-07-17T10:00:00.000Z",
        textPreview: "hello",
        rawIndex: 0,
      }],
      complete: true,
      revision: "1",
    };

    const collected = [{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }];
    assertEquals(await target.publish(collected), 1);
    const index = await readStableCellGraphValue(
      connection,
      target.cells.index,
    ) as Record<string, unknown>;
    assertEquals(index.schema, AGENT_CONNECTOR_SCHEMAS.sessionIndex);
    assertEquals(
      (index.sessions as Array<Record<string, unknown>>).map((session) => ({
        key: session.key,
        driver: session.driver,
        title: session.title,
        archived: session.archived,
        active: session.active,
        syncStatus: session.syncStatus,
      })),
      [{
        key: "codex%3Atest/session-1",
        driver: "codex-app-server",
        title: "First session",
        archived: false,
        active: false,
        syncStatus: "complete",
      }],
    );
    const publishedSession =
      (index.sessions as Array<Record<string, unknown>>)[0];
    const publishedManifest = publishedSession.manifest as Record<
      string,
      unknown
    >;
    assertEquals(publishedManifest.nativeSessionId, "session-1");
    assertEquals(publishedManifest.driver, "codex-app-server");
    const publishedChunk = (publishedManifest.chunks as Array<
      Record<string, unknown>
    >)[0].link as Record<string, unknown>;
    assertEquals(publishedChunk.events, [{ type: "message", text: "hello" }]);
    const firstManifestCell = await publishedManifestCell(
      connection,
      target,
      "session-1",
    );
    assertEquals(await target.publish(collected), 1);
    const unchangedManifestCell = await publishedManifestCell(
      connection,
      target,
      "session-1",
    );
    assertEquals(
      unchangedManifestCell.getAsNormalizedFullLink(),
      firstManifestCell.getAsNormalizedFullLink(),
    );

    const reconfiguredSource: SourceDescriptor = {
      ...source,
      driver: "acp",
    };
    assertEquals(
      await target.publish([{
        source: reconfiguredSource,
        sessions: [snapshot],
        errors: [],
        complete: true,
      }]),
      1,
    );
    const reconfiguredIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const reconfiguredSession =
      (reconfiguredIndex.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(reconfiguredSession.driver, "acp");
    assertEquals(
      (reconfiguredSession.manifest as Record<string, unknown>).driver,
      "acp",
    );

    assertEquals(
      await target.publish([{
        source,
        sessions: [],
        errors: [{
          nativeSessionId: snapshot.summary.nativeSessionId,
          message: "session read failed",
        }],
        complete: false,
      }]),
      1,
    );
    const partialIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (partialIndex.sessions as Array<Record<string, unknown>>).map((
        entry,
      ) => ({
        nativeSessionId: entry.nativeSessionId,
        syncStatus: entry.syncStatus,
      })),
      [{ nativeSessionId: "session-1", syncStatus: "partial" }],
    );

    await target.publishReceipt({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      ownerDid: space,
      commandId: "command-1",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "succeeded",
      claimedAt: "2026-07-17T10:01:00.000Z",
      completedAt: "2026-07-17T10:01:01.000Z",
    });
    assertEquals((await target.readReceipt("command-1"))?.status, "succeeded");
    assertEquals(await target.readReceipt("missing-command"), undefined);
    const receipts = await readStableCellGraphValue(
      connection,
      target.cells.receipts,
    ) as Record<string, unknown>;
    assertEquals(
      (receipts.receipts as Array<Record<string, unknown>>).map((receipt) => ({
        commandId: receipt.commandId,
        status: receipt.status,
      })),
      [{ commandId: "command-1", status: "succeeded" }],
    );

    const malformedReceipt = runtime.getCell(
      space,
      commandReceiptCause(space, space, "malformed-command"),
      agentOwnerSchema(space),
    );
    const malformedReceiptTx = runtime.edit();
    malformedReceiptTx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    malformedReceipt.withTx(malformedReceiptTx).set({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      ownerDid: space,
      commandId: "malformed-command",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "not-a-status",
    });
    malformedReceipt.withTx(malformedReceiptTx).applyCfcSchemaToExistingValue();
    malformedReceiptTx.prepareCfc();
    const malformedReceiptCommit = await malformedReceiptTx.commit();
    if (malformedReceiptCommit.error) throw malformedReceiptCommit.error;
    await assertRejects(
      () => target.readReceipt("malformed-command"),
      Error,
      "command receipt status is invalid",
    );

    const wrongOwnerReceipt = runtime.getCell(
      space,
      commandReceiptCause(space, space, "wrong-owner-command"),
      agentOwnerSchema(space),
    );
    const wrongOwnerReceiptTx = runtime.edit();
    wrongOwnerReceiptTx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    wrongOwnerReceipt.withTx(wrongOwnerReceiptTx).set({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      ownerDid: "did:key:another-owner",
      commandId: "wrong-owner-command",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "succeeded",
    });
    wrongOwnerReceipt.withTx(wrongOwnerReceiptTx)
      .applyCfcSchemaToExistingValue();
    wrongOwnerReceiptTx.prepareCfc();
    const wrongOwnerReceiptCommit = await wrongOwnerReceiptTx.commit();
    if (wrongOwnerReceiptCommit.error) throw wrongOwnerReceiptCommit.error;
    await assertRejects(
      () => target.readReceipt("wrong-owner-command"),
      Error,
      "command receipt belongs to another owner",
    );

    const unprotectedReceipt = runtime.getCell(
      space,
      commandReceiptCause(space, space, "unprotected-command"),
      undefined,
    );
    const unprotectedReceiptTx = runtime.edit();
    unprotectedReceipt.withTx(unprotectedReceiptTx).setRawUntyped({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      ownerDid: space,
      commandId: "unprotected-command",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "succeeded",
    });
    const unprotectedReceiptCommit = await unprotectedReceiptTx.commit();
    if (unprotectedReceiptCommit.error) throw unprotectedReceiptCommit.error;
    await assertRejects(
      () => target.readReceipt("unprotected-command"),
      Error,
      "refusing to trust an unprotected command receipt",
    );

    const malformedIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: space,
      receipts: "not-an-array",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await writeReceiptIndex(malformedIndex);
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          ownerDid: space,
          commandId: "command-2",
          sourceId: source.id,
          nativeSessionId: snapshot.summary.nativeSessionId,
          status: "succeeded",
        }),
      Error,
      "command receipt index has an invalid shape",
    );
    assertEquals(
      await readStableCellGraphValue(connection, target.cells.receipts),
      malformedIndex,
    );

    const validRow = structuredClone(
      (receipts.receipts as Array<Record<string, unknown>>)[0],
    );
    const malformedRows: Array<{
      value: Record<string, unknown>;
      message: string;
    }> = [
      {
        value: { ...validRow, status: "not-a-status" },
        message: "command receipt index row 0 status is invalid",
      },
      {
        value: { ...validRow, receipt: {} },
        message: "command receipt index row receipt link is invalid",
      },
      {
        value: { ...validRow, error: { code: "broken" } },
        message: "command receipt index row 0 error is invalid",
      },
      {
        value: { ...validRow, nativeSessionId: " session-1 " },
        message: "nativeSessionId is not normalized",
      },
      {
        value: { ...validRow, ownerDid: "did:key:another-owner" },
        message: "command receipt index row belongs to another owner",
      },
    ];
    for (const malformed of malformedRows) {
      const malformedRowIndex = {
        schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
        ownerDid: space,
        receipts: [malformed.value],
        updatedAt: "2026-07-20T00:00:00.000Z",
      };
      await writeReceiptIndex(malformedRowIndex);
      await assertRejects(
        () =>
          target.publishReceipt({
            schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
            ownerDid: space,
            commandId: "command-2",
            sourceId: source.id,
            nativeSessionId: snapshot.summary.nativeSessionId,
            status: "succeeded",
          }),
        Error,
        malformed.message,
      );
      assertEquals(
        await readStableCellGraphValue(connection, target.cells.receipts),
        malformedRowIndex,
      );
    }

    const malformedTimestampIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: space,
      receipts: [validRow],
      updatedAt: "not-a-timestamp",
    };
    await writeReceiptIndex(malformedTimestampIndex);
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          ownerDid: space,
          commandId: "command-2",
          sourceId: source.id,
          nativeSessionId: snapshot.summary.nativeSessionId,
          status: "succeeded",
        }),
      Error,
      "command receipt index has an invalid shape",
    );

    const oversizedIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: space,
      receipts: Array.from({ length: 201 }, () => structuredClone(validRow)),
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await writeReceiptIndex(oversizedIndex);
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          ownerDid: space,
          commandId: "command-2",
          sourceId: source.id,
          nativeSessionId: snapshot.summary.nativeSessionId,
          status: "succeeded",
        }),
      Error,
      "command receipt index exceeds 200 rows",
    );

    const receivedCommands = Promise.withResolvers<unknown[]>();
    const commandWriterAuthorization = {
      __ctWriterIdentityOf: {
        file: "agent-sessions-debug/main.tsx",
        moduleIdentity: "fid1:target-test-command-writer",
        path: ["sendOwnerAgentCommand"],
      },
    };
    await target.bindCommandCell(
      target.cells.commands,
      commandWriterAuthorization,
    );
    const cancel = await target.subscribeCommands((commands) => {
      if (commands.length > 0) receivedCommands.resolve(commands);
    });
    try {
      const command = JSON.stringify({ id: "command-2" });
      const tx = runtime.edit();
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity:
          commandWriterAuthorization.__ctWriterIdentityOf.moduleIdentity,
        sourceFile: commandWriterAuthorization.__ctWriterIdentityOf.file,
        bindingPath: commandWriterAuthorization.__ctWriterIdentityOf.path,
      });
      target.cells.commands.withTx(tx).set([command]);
      tx.prepareCfc();
      const result = await tx.commit();
      if (result.error) throw result.error;
      assertEquals(await receivedCommands.promise, [command]);
      assertEquals(await target.pollCommands(), [command]);
    } finally {
      cancel();
    }

    const firstHealthCommitStarted = Promise.withResolvers<void>();
    const releaseFirstHealthCommit = Promise.withResolvers<void>();
    const originalEdit = runtime.edit;
    let blockNextCommit = true;
    runtime.edit = function () {
      const tx = originalEdit.call(this);
      if (blockNextCommit) {
        blockNextCommit = false;
        const originalCommit = tx.commit.bind(tx);
        tx.commit = async () => {
          firstHealthCommitStarted.resolve();
          await releaseFirstHealthCommit.promise;
          return await originalCommit();
        };
      }
      return tx;
    };
    let firstHealth: Promise<void> | undefined;
    let secondHealth: Promise<void> | undefined;
    try {
      firstHealth = target.publishHealth({ generation: "first" });
      await firstHealthCommitStarted.promise;
      let secondHealthStarted = false;
      const secondHealthValue: Record<string, unknown> = {};
      Object.defineProperty(secondHealthValue, "generation", {
        enumerable: true,
        get() {
          secondHealthStarted = true;
          return "second";
        },
      });
      secondHealth = target.publishHealth(secondHealthValue);
      assertFalse(secondHealthStarted);
    } finally {
      releaseFirstHealthCommit.resolve();
      await Promise.allSettled(
        [firstHealth, secondHealth].filter(
          (operation): operation is Promise<void> => operation !== undefined,
        ),
      );
      runtime.edit = originalEdit;
    }
    await Promise.all([firstHealth!, secondHealth!]);
    const serializedHealth = await readStableCellGraphValue(
      connection,
      target.cells.health,
    ) as Record<string, unknown>;
    assertEquals(serializedHealth.generation, "second");

    const invalidIndexScope = {
      spaceDid: space,
      agentConnector: "invalid-index-test-array-elements",
    };
    const validCheckout = {
      root: "/repo",
      gitRepo: null,
      gitBranch: null,
      gitHeadSha: null,
      gitRemotes: [],
      observedAt: "2026-08-21T00:00:00.000Z",
    };
    const writeInvalidIndex = async (
      session: Record<string, unknown>,
      sources = index.sources,
      checkouts = index.checkouts,
    ) => {
      const invalidIndex = {
        ...index,
        sources,
        checkouts,
        sessions: [session],
      };
      const [invalidRecentPlan, invalidAllPlan] = await Promise.all([
        planStableArrayCells(
          { ...invalidIndex, bucket: "recent" },
          invalidIndexScope,
        ),
        planStableArrayCells(
          { ...invalidIndex, bucket: "all" },
          invalidIndexScope,
        ),
      ]);
      await pushStableCellGraph(connection, [{
        cell: target.cells.index,
        value: (materializeCell) =>
          materializeStableArrayCells(
            invalidRecentPlan,
            materializeCell,
          ) as Record<string, unknown>,
      }, {
        cell: target.cells.allIndex,
        value: (materializeCell) =>
          materializeStableArrayCells(
            invalidAllPlan,
            materializeCell,
          ) as Record<string, unknown>,
      }]);
    };
    const { driver: _driver, ...driverlessSession } = publishedSession;
    await writeInvalidIndex(driverlessSession);
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has no driver",
    );
    await writeInvalidIndex([] as unknown as Record<string, unknown>);
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has an invalid shape",
    );
    await writeInvalidIndex({
      ...publishedSession,
      ownerDid: "did:key:another-owner",
    });
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has an invalid shape",
    );
    await writeInvalidIndex({ ...publishedSession, key: "wrong/session" });
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has an invalid shape",
    );
    await writeInvalidIndex(publishedSession, [{
      ...(index.sources as Array<Record<string, unknown>>)[0],
      id: "Codex:Test",
    }]);
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index source 0 has an invalid shape",
    );
    await writeInvalidIndex({
      ...publishedSession,
      sourceId: "Codex:Test",
    });
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has an invalid shape",
    );
    await writeInvalidIndex({
      ...publishedSession,
      nativeSessionId: " session-1 ",
    });
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has an invalid shape",
    );
    await writeInvalidIndex(publishedSession, index.sources, {});
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index has an invalid shape",
    );
    await writeInvalidIndex(
      publishedSession,
      index.sources,
      [{ ...validCheckout, root: "repo" }],
    );
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index checkout 0 has an invalid shape",
    );
    await writeInvalidIndex(
      publishedSession,
      index.sources,
      [{
        ...validCheckout,
        gitRemotes: [{ name: "origin", urls: [42] }],
      }],
    );
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index checkout 0 has an invalid shape",
    );
    await writeInvalidIndex(
      publishedSession,
      index.sources,
      [{
        ...validCheckout,
        observedAt: "not-a-timestamp",
      }],
    );
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index checkout 0 has an invalid shape",
    );
    await writeInvalidIndex(
      publishedSession,
      index.sources,
      [{ ...validCheckout, root: "C:\\repo" }],
    );
    assertEquals(await target.publish(collected), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("Fabric target releases graph storage after every session", async () => {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
  const identity = await Identity.fromPassphrase(
    "agent graph storage release test",
  );
  const session = await createSession({
    identity,
    spaceName: `agent-graph-release-${crypto.randomUUID()}`,
  });
  const mainStorage = SharedServerStorageManager.connectTo(server, {
    as: session.as,
  });
  const graphStorage = SharedServerStorageManager.connectTo(server, {
    as: session.as,
  });
  const mainRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: mainStorage,
  });
  const graphRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: graphStorage,
  });
  let releases = 0;
  let releaseFails = false;
  let wrongOwner = false;
  const connection = {
    runtime: mainRuntime,
    spaceDid: session.space,
    ownerDid: identity.did(),
  };
  const graphConnection = {
    runtime: graphRuntime,
    spaceDid: session.space,
    ownerDid: identity.did(),
  };
  try {
    const target = await AgentFabricTarget.open(
      connection,
      undefined,
      () =>
        Promise.resolve({
          connection: wrongOwner
            ? { ...graphConnection, ownerDid: "did:key:other-owner" }
            : graphConnection,
          release: async () => {
            releases++;
            await graphStorage.close();
            if (releaseFails) {
              throw new Error("graph release failed");
            }
          },
        }),
    );
    const source: SourceDescriptor = {
      id: "codex:test",
      driver: "codex-app-server",
      capabilities: {
        inventory: true,
        read: true,
        prompt: false,
        cancel: false,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    };
    const snapshot = (nativeSessionId: string): NativeSessionSnapshot => ({
      summary: {
        nativeSessionId,
        title: nativeSessionId,
        cwd: null,
        createdAt: null,
        updatedAt: new Date().toISOString(),
        archived: false,
        active: false,
        raw: { nativeSessionId },
      },
      events: [{ type: "message", nativeSessionId }],
      normalizedMessages: [],
      complete: true,
    });

    assertEquals(
      await target.publish([{
        source,
        sessions: [snapshot("session-1"), snapshot("session-2")],
        errors: [],
        complete: true,
      }]),
      2,
    );
    assertEquals(releases, 2);
    const index = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (index.sessions as Array<Record<string, unknown>>).map((entry) =>
        entry.nativeSessionId
      ),
      ["session-1", "session-2"],
    );

    releaseFails = true;
    await expect(target.publish([{
      source,
      sessions: [snapshot("session-3")],
      errors: [],
      complete: true,
    }])).rejects.toThrow("graph release failed");
    expect(releases).toBe(3);
    expect(await readStableCellGraphValue(connection, target.cells.allIndex))
      .toEqual(index);

    wrongOwner = true;
    const error = await assertRejects(
      () =>
        target.publish([{
          source,
          sessions: [snapshot("session-3")],
          errors: [],
          complete: true,
        }]),
      AggregateError,
      "agent session publication and graph storage release failed",
    );
    assertEquals(
      error.errors.map((failure) => (failure as Error).message),
      [
        "agent graph session must use the target space and owner",
        "graph release failed",
      ],
    );
    expect(releases).toBe(4);
  } finally {
    await graphRuntime.dispose();
    await mainRuntime.dispose();
    await graphStorage.close();
    await mainStorage.close();
  }
});

Deno.test("Fabric target data is owner-scoped and owner-confidential", async () => {
  const owner = await Identity.fromPassphrase("agent connector data owner");
  const otherOwner = await Identity.fromPassphrase(
    "agent connector other data owner",
  );
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = owner.did();
  try {
    const connection = { runtime, spaceDid: space, ownerDid: owner.did() };
    const ownerCells = createAgentFabricCells(connection);
    const otherCells = createAgentFabricCells({
      runtime,
      spaceDid: space,
      ownerDid: otherOwner.did(),
    });
    assertNotEquals(
      ownerCells.health.getAsNormalizedFullLink().id,
      otherCells.health.getAsNormalizedFullLink().id,
    );

    const target = await AgentFabricTarget.open(connection);
    for (
      const cell of [
        target.cells.index,
        target.cells.allIndex,
        target.cells.health,
        target.cells.receipts,
      ]
    ) {
      assertEquals(
        cellHasOwnerProtection(runtime.readTx(), cell, owner.did()),
        true,
      );
    }
    await target.publishHealth({
      status: "ready",
      localWorkspace: "/private/owner/worktree",
    });
    const healthLink = target.cells.health.getAsNormalizedFullLink();
    const inspect = runtime.edit();
    const stored = inspect.readOrThrow({
      space: healthLink.space,
      id: healthLink.id,
      path: [],
      ...(healthLink.scope !== undefined && { scope: healthLink.scope }),
    }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
    assertEquals(
      stored.cfc?.labelMap?.entries?.some((entry) =>
        JSON.stringify(entry).includes("confidentiality") &&
        JSON.stringify(entry).includes(owner.did())
      ),
      true,
    );
    inspect.abort();

    const attack = runtime.edit();
    attack.setCfcTrustSnapshot({
      id: `principal:${otherOwner.did()}`,
      actingPrincipal: otherOwner.did(),
    });
    attack.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    attack.writeValueOrThrow(healthLink, {
      status: "compromised",
    });
    attack.prepareCfc();
    const attackResult = await attack.commit();
    assertEquals(attackResult.error !== undefined, true);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("shared-space agent discovery and commands are owner-isolated", async () => {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
  const owner = await Identity.fromPassphrase("shared agent graph owner");
  const otherOwner = await Identity.fromPassphrase(
    "shared agent graph other owner",
  );
  const ownerSession = await createSession({
    identity: owner,
    spaceName: `shared-agent-graph-${crypto.randomUUID()}`,
  });
  const ownerStorage = SharedServerStorageManager.connectTo(server, {
    as: ownerSession.as,
  });
  const ownerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: ownerStorage,
  });
  let otherRuntime: Runtime | undefined;
  let otherStorage: SharedServerStorageManager | undefined;
  try {
    const target = await AgentFabricTarget.open({
      runtime: ownerRuntime,
      spaceDid: ownerSession.space,
      ownerDid: owner.did(),
    });
    await target.bindCommandCell(target.cells.commands, {
      __ctWriterIdentityOf: {
        file: "agent-sessions-debug/main.tsx",
        moduleIdentity: "fid1:owner-command-writer",
        path: ["sendOwnerAgentCommand"],
      },
    });
    const source: SourceDescriptor = {
      id: "codex:test",
      driver: "codex-app-server",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: false,
        setConfigOption: false,
      },
    };
    const snapshot: NativeSessionSnapshot = {
      summary: {
        nativeSessionId: "private-session",
        title: "Private session",
        cwd: "/private/owner/workspace",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:01:00.000Z",
        archived: false,
        active: true,
        raw: {},
      },
      events: [{
        type: "message",
        id: "private-message",
        role: "user",
        content: "private prompt",
      }],
      normalizedMessages: [{
        id: "private-message",
        role: "user",
        kind: "text",
        createdAt: "2026-08-25T00:01:00.000Z",
        textPreview: "private prompt",
        rawIndex: 0,
      }],
      complete: true,
    };
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    await ownerStorage.synced();
    assertEquals(
      (await assertOwnerProtectedGraph(
        ownerRuntime,
        target.cells.allIndex,
        owner.did(),
      )) > 5,
      true,
    );

    const otherSession = await createSession({
      identity: otherOwner,
      spaceDid: ownerSession.space,
    });
    otherStorage = SharedServerStorageManager.connectTo(server, {
      as: otherSession.as,
    });
    otherRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherStorage,
    });
    const otherTarget = await AgentFabricTarget.open({
      runtime: otherRuntime,
      spaceDid: otherSession.space,
      ownerDid: otherOwner.did(),
    });
    const otherIndex = await readStableCellGraphValue(
      {
        runtime: otherRuntime,
        spaceDid: otherSession.space,
        ownerDid: otherOwner.did(),
      },
      otherTarget.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(otherIndex.sessions, []);
    assertNotEquals(
      target.cells.allIndex.getAsNormalizedFullLink().id,
      otherTarget.cells.allIndex.getAsNormalizedFullLink().id,
    );

    const causes = agentFabricCauses(ownerSession.space, owner.did());
    const ownerCommands = otherRuntime.getCell(
      ownerSession.space,
      causes.commands,
    );
    await ownerCommands.sync();
    await otherStorage.synced();

    const attack = otherRuntime.edit();
    ownerCommands.withTx(attack).setRawUntyped([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      ownerDid: owner.did(),
      id: "other-owner-command",
    }]);
    let rejected = false;
    try {
      attack.prepareCfc();
      rejected = (await attack.commit()).error !== undefined;
    } catch {
      rejected = true;
      attack.abort();
    }
    assertEquals(rejected, true);
  } finally {
    await otherRuntime?.dispose();
    await otherStorage?.close();
    await ownerRuntime.dispose();
    await ownerStorage.close();
    await server.close();
  }
});

Deno.test("stable graph checks remote children before adoption", async () => {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
  const owner = await Identity.fromPassphrase("stable graph remote owner");
  const otherOwner = await Identity.fromPassphrase(
    "stable graph remote squatter",
  );
  const ownerSession = await createSession({
    identity: owner,
    spaceName: `stable-graph-remote-${crypto.randomUUID()}`,
  });
  const otherSession = await createSession({
    identity: otherOwner,
    spaceDid: ownerSession.space,
  });
  const otherStorage = SharedServerStorageManager.connectTo(server, {
    as: otherSession.as,
  });
  const otherRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: otherStorage,
  });
  let ownerRuntime: Runtime | undefined;
  let ownerStorage: SharedServerStorageManager | undefined;
  try {
    const childCause = { stableGraphTest: "remote-child" };
    const otherChild = otherRuntime.getCell(ownerSession.space, childCause);
    await otherChild.sync();
    await otherStorage.synced();
    const seed = otherRuntime.edit();
    otherChild.withTx(seed).setRawUntyped({ exposed: true });
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;
    await otherStorage.synced();

    ownerStorage = SharedServerStorageManager.connectTo(server, {
      as: ownerSession.as,
    });
    ownerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: ownerStorage,
    });
    const connection = {
      runtime: ownerRuntime,
      spaceDid: ownerSession.space,
      ownerDid: owner.did(),
    };
    const parent = ownerRuntime.getCell(
      ownerSession.space,
      { stableGraphTest: "remote-parent" },
      agentOwnerSchema(owner.did()),
    );
    await assertRejects(
      () =>
        pushStableCellGraph(connection, [{
          cell: parent,
          value: (materializeCell) => ({
            child: materializeCell(childCause, { exposed: false }),
          }),
        }]),
      Error,
      "refusing to adopt an unprotected stable graph cell",
    );

    assertEquals(otherChild.getRaw(), { exposed: true });
    assertEquals(parent.getRaw(), undefined);
  } finally {
    await ownerRuntime?.dispose();
    await ownerStorage?.close();
    await otherRuntime.dispose();
    await otherStorage.close();
    await server.close();
  }
});

Deno.test("Fabric target can defer its storage claim", async () => {
  const owner = await Identity.fromPassphrase(
    "agent connector deferred claim owner",
  );
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const connection = {
      runtime,
      spaceDid: owner.did(),
      ownerDid: owner.did(),
    };
    let gitContextCalls = 0;
    const target = await AgentFabricTarget.connect(connection, {
      beginObservation: () => {
        gitContextCalls++;
        throw new Error("git context must not be used before storage claim");
      },
      validateCheckout: () => {
        gitContextCalls++;
        throw new Error("git context must not be used before storage claim");
      },
    } as never);
    const rootValues = () => [
      target.cells.index.getRaw(),
      target.cells.allIndex.getRaw(),
      target.cells.health.getRaw(),
      target.cells.commands.getRaw(),
      target.cells.receipts.getRaw(),
    ];
    assertEquals(rootValues(), [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    await assertRejects(
      () => target.publish([]),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.publishHealth({ status: "starting" }),
      Error,
      "agent connector storage has not been claimed",
    );
    assertThrows(
      () => target.beginSessionObservation(),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.validateCheckout("/repo"),
      Error,
      "agent connector storage has not been claimed",
    );
    assertThrows(
      () => target.commandCellId(),
      Error,
      "agent connector storage has not been claimed",
    );
    assertThrows(
      () => target.receiptCellId(),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.bindCommandCell(target.cells.commands, {}),
      Error,
      "agent connector storage has not been claimed",
    );
    assertThrows(
      () => target.commandsAreBound(),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.readReceipt("command"),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.subscribeCommands(() => {}),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.pollCommands(),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.publishReceipt({} as never),
      Error,
      "agent connector storage has not been claimed",
    );
    await assertRejects(
      () => target.refreshSession({} as AgentDriver, "session"),
      Error,
      "agent connector storage has not been claimed",
    );

    assertEquals(rootValues(), [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    assertEquals(gitContextCalls, 0);
    await target.claimStorage();
    const claimedRootValues = rootValues();
    await target.claimStorage();
    assertEquals(rootValues(), claimedRootValues);
    await assertRejects(
      () => target.publish([], { observationSequence: 0 }),
      Error,
      "observationSequence must be a positive safe integer",
    );
    await assertRejects(
      () => target.bindCommandCell(target.cells.commands, {}),
      Error,
      "command writer authorization is invalid",
    );
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          ownerDid: "did:key:another-owner",
          commandId: "wrong-owner-command",
          sourceId: "codex:test",
          nativeSessionId: "session",
          status: "succeeded",
        }),
      Error,
      "command receipt belongs to another owner",
    );

    assertEquals(
      cellHasOwnerProtection(
        runtime.readTx(),
        target.cells.index,
        owner.did(),
      ),
      true,
    );
    assertEquals(
      cellHasOwnerProtection(
        runtime.readTx(),
        target.cells.receipts,
        owner.did(),
      ),
      true,
    );
    assertEquals(target.cells.commands.getRaw(), undefined);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("Fabric target refuses an unprotected owner root", async () => {
  const owner = await Identity.fromPassphrase("agent connector root owner");
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = (await Identity.fromPassphrase(
    "shared agent connector root space",
  )).did();
  try {
    const connection = { runtime, spaceDid: space, ownerDid: owner.did() };
    const cells = createAgentFabricCells(connection);
    const unprotectedIndex = runtime.getCell(
      space,
      agentFabricCauses(space, owner.did()).index,
      undefined,
    );
    const seed = runtime.edit();
    unprotectedIndex.withTx(seed).setRawUntyped({
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: owner.did(),
      bucket: "recent",
      generatedAt: "2026-08-25T00:00:00.000Z",
      generation: 0,
      sources: [],
      sessions: [],
    });
    const committed = await seed.commit();
    if (committed.error) throw committed.error;

    await assertRejects(
      () => AgentFabricTarget.open(connection),
      Error,
      "refusing to adopt an unprotected recent session index",
    );
    assertEquals(cells.allIndex.getRaw(), undefined);
    assertEquals(cells.health.getRaw(), undefined);
    assertEquals(cells.receipts.getRaw(), undefined);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("Fabric target refuses an owner root with another writer", async () => {
  const owner = await Identity.fromPassphrase(
    "agent connector wrong writer owner",
  );
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const otherWriter = "another-owner-scoped-pattern";
  try {
    const connection = {
      runtime,
      spaceDid: owner.did(),
      ownerDid: owner.did(),
    };
    const root = runtime.getCell(
      owner.did(),
      agentFabricCauses(owner.did(), owner.did()).index,
      agentPrincipalSchema(owner.did(), [otherWriter]),
    );
    const seed = runtime.edit();
    seed.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: otherWriter,
    });
    root.withTx(seed).set({
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: owner.did(),
      bucket: "recent",
      generatedAt: "2026-08-25T00:00:00.000Z",
      generation: 0,
      sources: [],
      sessions: [],
    });
    root.withTx(seed).applyCfcSchemaToExistingValue();
    seed.prepareCfc();
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;

    assertEquals(
      cellHasOwnerProtection(runtime.readTx(), root, owner.did()),
      true,
    );
    await assertRejects(
      () => AgentFabricTarget.open(connection),
      Error,
      "writeAuthorizedBy cannot be weakened",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("Fabric target binds only an empty owner command queue", async () => {
  const owner = await Identity.fromPassphrase("command queue binding owner");
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const writerAuthorization = {
    __ctWriterIdentityOf: {
      file: "agent-sessions-debug/main.tsx",
      moduleIdentity: "fid1:verified-command-writer",
      path: ["sendOwnerAgentCommand"],
    },
  };
  try {
    const rawCommandCell = runtime.getCell(
      owner.did(),
      agentFabricCauses(owner.did(), owner.did()).commands,
      undefined,
    );
    const seed = runtime.edit();
    rawCommandCell.withTx(seed).setRawUntyped(["pre-seeded-command"]);
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;
    const first = await AgentFabricTarget.open({
      runtime,
      spaceDid: owner.did(),
      ownerDid: owner.did(),
    });
    await assertRejects(
      () => first.bindCommandCell(first.cells.commands, writerAuthorization),
      Error,
      "refusing to adopt a populated command queue",
    );
    await assertRejects(
      () =>
        first.bindCommandCell(
          runtime.getCell(owner.did(), "redirected-command-queue"),
          writerAuthorization,
        ),
      Error,
      "not the connector's owner-scoped queue",
    );

    const secondOwner = await Identity.fromPassphrase(
      "empty command queue binding owner",
    );
    const secondStorage = StorageManager.emulate({ as: secondOwner });
    const secondRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: secondStorage,
    });
    try {
      const second = await AgentFabricTarget.open({
        runtime: secondRuntime,
        spaceDid: secondOwner.did(),
        ownerDid: secondOwner.did(),
      });
      await assertRejects(
        () => second.pollCommands(),
        Error,
        "no command queue has been bound",
      );
      await assertRejects(
        () => second.subscribeCommands(() => {}),
        Error,
        "no command queue has been bound",
      );
      const commandValueBefore = second.cells.commands.getRaw();
      const commandProtectionBefore = cellHasOwnerProtection(
        secondRuntime.readTx(),
        second.cells.commands,
        secondOwner.did(),
      );
      const originalEdit = secondRuntime.edit;
      secondRuntime.edit = function () {
        const tx = originalEdit.call(this);
        tx.commit = () => {
          const failure = Object.assign(
            new Error("command cell protection interrupted"),
            {
              name: "PreconditionFailedError" as const,
              precondition: "origin-committed" as const,
            },
          );
          tx.abort(failure);
          return Promise.resolve({ error: failure });
        };
        return tx;
      };
      try {
        await assertRejects(
          () =>
            second.bindCommandCell(
              second.cells.commands,
              writerAuthorization,
            ),
          Error,
          "could not protect the owner command cell: command cell protection interrupted",
        );
        assertEquals(second.cells.commands.getRaw(), commandValueBefore);
        assertEquals(
          cellHasOwnerProtection(
            secondRuntime.readTx(),
            second.cells.commands,
            secondOwner.did(),
          ),
          commandProtectionBefore,
        );
      } finally {
        secondRuntime.edit = originalEdit;
      }
      assertEquals(second.commandsAreBound(), false);
      await second.bindCommandCell(second.cells.commands, writerAuthorization);
      assertEquals(second.commandsAreBound(), true);
      assertEquals(await second.pollCommands(), []);
    } finally {
      await secondRuntime.dispose();
      await secondStorage.close();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("checkout publication preserves partial-refresh inventory", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector checkout publication test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const connection = {
    runtime,
    spaceDid: signer.did(),
    ownerDid: signer.did(),
  };
  let observedAt = "2026-08-21T00:00:00.000Z";
  let failExtraHead = false;
  let failSessionHead = false;
  let failSessionRoot = false;
  let sessionHead = "head-session-1";
  let cancelSessionLookup: AbortController | undefined;
  const runner: GitCommandRunner = (args, signal) => {
    const root = args[1];
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      if (root === "/session-repo" && failSessionRoot) {
        return Promise.reject(new Deno.errors.NotFound("git"));
      }
      if (root === "/session-repo" && cancelSessionLookup) {
        assertEquals(signal, cancelSessionLookup.signal);
        const reason = new Error("session Git lookup cancelled");
        cancelSessionLookup.abort(reason);
        return Promise.reject(reason);
      }
      return Promise.resolve({ code: 0, stdout: `${root}\n` });
    }
    if (command === "branch --show-current") {
      return Promise.resolve({ code: 0, stdout: "main\n" });
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve({
        code: 0,
        stdout: `git@github.com:common${root}.git\n`,
      });
    }
    if (command === "rev-parse HEAD") {
      const failed = failExtraHead && root === "/extra" ||
        failSessionHead && root === "/session-repo";
      return Promise.resolve({
        code: failed ? 128 : 0,
        stdout: root === "/session-repo" ? `${sessionHead}\n` : "head-extra\n",
      });
    }
    if (command === "remote -v") {
      return Promise.resolve({
        code: 0,
        stdout: `upstream\tgit@github.com:common${root}.git (fetch)\n`,
      });
    }
    return Promise.resolve({ code: 1, stdout: "" });
  };
  const gitContext = new GitContextResolver(
    runner,
    () => new Date(observedAt),
  );
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot: NativeSessionSnapshot = {
    summary: {
      nativeSessionId: "session-1",
      title: "Checkout session",
      cwd: "/session-repo",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1" },
    },
    events: [],
    normalizedMessages: [],
    complete: true,
  };
  const collected = [{
    source,
    sessions: [snapshot],
    errors: [],
    complete: true,
  }];
  const readIndex = () =>
    readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Promise<Record<string, unknown>>;
  let target: AgentFabricTarget;
  try {
    target = await AgentFabricTarget.open(connection, gitContext);
    await target.publish(collected, { checkoutDirectories: ["/extra"] });
    const first = await readIndex();
    const firstSession = (first.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(
      (first.checkouts as Array<Record<string, unknown>>).map((checkout) =>
        checkout.root
      ),
      ["/extra", "/session-repo"],
    );

    observedAt = "2026-08-22T00:00:00.000Z";
    await target.publish(collected, { preserveUntouchedStatus: true });
    const refreshed = await readIndex();
    const refreshedSession =
      (refreshed.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(refreshedSession.contentHash, firstSession.contentHash);
    assertEquals(
      (refreshed.checkouts as Array<Record<string, unknown>>).map((checkout) =>
        checkout.root
      ),
      ["/extra", "/session-repo"],
    );

    sessionHead = "head-session-2";
    observedAt = "2026-08-23T00:00:00.000Z";
    await target.publish(collected, { preserveUntouchedStatus: true });
    const changedHead = await readIndex();
    assertEquals(
      (changedHead.sessions as Array<Record<string, unknown>>)[0].contentHash,
      firstSession.contentHash,
    );
    const changedHeadCheckouts = changedHead.checkouts as Array<
      Record<string, unknown>
    >;
    assertEquals(
      changedHeadCheckouts.find((checkout) => checkout.root === "/session-repo")
        ?.gitHeadSha,
      "head-session-2",
    );

    failSessionHead = true;
    observedAt = "2026-08-24T00:00:00.000Z";
    await target.publish(collected, { preserveUntouchedStatus: true });
    const partialGit = await readIndex();
    assertEquals(partialGit.checkouts, changedHead.checkouts);
    failSessionHead = false;

    failSessionRoot = true;
    await target.publish(collected, { preserveUntouchedStatus: true });
    const failedRootLookup = await readIndex();
    assertEquals(failedRootLookup.checkouts, changedHead.checkouts);
    failSessionRoot = false;

    await target.publish(collected, { checkoutDirectories: [] });
    const authoritative = await readIndex();
    assertEquals(
      (authoritative.checkouts as Array<Record<string, unknown>>).map(
        (checkout) => checkout.root,
      ),
      ["/session-repo"],
    );

    cancelSessionLookup = new AbortController();
    const generationBeforeCancellation = authoritative.generation;
    await assertRejects(
      () =>
        target.publish(collected, {
          checkoutDirectories: [],
          signal: cancelSessionLookup?.signal,
        }),
      Error,
      "session Git lookup cancelled",
    );
    cancelSessionLookup = undefined;
    const afterCancellation = await readIndex();
    assertEquals(afterCancellation.generation, generationBeforeCancellation);
    assertEquals(afterCancellation.sessions, authoritative.sessions);

    failExtraHead = true;
    const generation = authoritative.generation;
    const changedSnapshot = {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        title: "Changed during failed checkout collection",
        raw: {
          ...snapshot.summary.raw,
          title: "Changed during failed checkout collection",
        },
      },
    };
    await assertRejects(
      () =>
        target.publish([{
          ...collected[0],
          sessions: [changedSnapshot],
        }], { checkoutDirectories: ["/extra"] }),
      Error,
      "Git command failed while observing checkout: rev-parse HEAD",
    );
    const afterFailure = await readIndex();
    assertEquals(afterFailure.generation, generation);
    assertEquals(afterFailure.checkouts, authoritative.checkouts);
    assertEquals(afterFailure.sessions, authoritative.sessions);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("publication finishes after its first graph commit", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector publication commit boundary test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot = (title: string): NativeSessionSnapshot => ({
    summary: {
      nativeSessionId: "session-1",
      title,
      cwd: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:01:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1", title },
    },
    events: [],
    normalizedMessages: [],
    complete: true,
  });
  const collected = (title: string) => [{
    source,
    sessions: [snapshot(title)],
    errors: [],
    complete: true,
  }];
  try {
    const target = await AgentFabricTarget.open(connection);
    await target.publish(collected("Before"));
    const controller = new AbortController();
    const originalEdit = runtime.edit;
    let manifestCommitObserved = false;
    runtime.edit = function () {
      const tx = originalEdit.call(this);
      let writesManifest = false;
      const originalWrite = tx.writeOrThrow.bind(tx);
      tx.writeOrThrow = (...args) => {
        if (
          args[0].path.at(-1) === "schema" &&
          args[1] === AGENT_CONNECTOR_SCHEMAS.session
        ) {
          writesManifest = true;
        }
        return originalWrite(...args);
      };
      const originalWriteValue = tx.writeValueOrThrow.bind(tx);
      tx.writeValueOrThrow = (...args) => {
        const value = args[1] as Record<string, unknown> | undefined;
        if (value?.schema === AGENT_CONNECTOR_SCHEMAS.session) {
          writesManifest = true;
        }
        return originalWriteValue(...args);
      };
      const originalCommit = tx.commit.bind(tx);
      tx.commit = async () => {
        const result = await originalCommit();
        if (writesManifest && !result.error) {
          manifestCommitObserved = true;
          controller.abort(new Error("cancelled after manifest commit"));
        }
        return result;
      };
      return tx;
    };
    try {
      await target.publish(collected("After"), {
        signal: controller.signal,
      });
    } finally {
      runtime.edit = originalEdit;
    }

    assertEquals(manifestCommitObserved, true);
    assertEquals(controller.signal.aborted, true);
    const index = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const session = (index.sessions as Array<Record<string, unknown>>)[0];
    const currentManifest = await publishedManifestCell(
      connection,
      target,
      "session-1",
    );
    const publishedManifest = await readStableCellGraphValue(
      connection,
      currentManifest,
    ) as Record<string, unknown>;
    assertEquals(session.title, "After");
    assertEquals(
      (publishedManifest.summary as Record<string, unknown>).title,
      "After",
    );
    assertEquals(session.contentHash, publishedManifest.snapshotHash);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("an interrupted publication leaves the prior session graph intact", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector interrupted graph test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot = (
    title: string,
    events: unknown[],
  ): NativeSessionSnapshot => ({
    summary: {
      nativeSessionId: "session-1",
      title,
      cwd: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:01:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1", title },
    },
    events,
    normalizedMessages: [],
    complete: true,
  });
  try {
    const target = await AgentFabricTarget.open(connection);
    const sharedDetail = { value: 1 };
    await target.publish([{
      source,
      sessions: [snapshot("Before", [{
        id: "event-1",
        type: "message",
        detail: sharedDetail,
      }, {
        id: "event-2",
        type: "message",
        detail: sharedDetail,
      }])],
      errors: [],
      complete: true,
    }]);
    const manifest = await publishedManifestCell(
      connection,
      target,
      "session-1",
    );

    const originalEdit = runtime.edit;
    runtime.edit = function () {
      const tx = originalEdit.call(this);
      let writesManifest = false;
      const originalWrite = tx.writeOrThrow.bind(tx);
      tx.writeOrThrow = (...args) => {
        if (
          args[0].path.at(-1) === "schema" &&
          args[1] === AGENT_CONNECTOR_SCHEMAS.session
        ) {
          writesManifest = true;
        }
        return originalWrite(...args);
      };
      const originalWriteValue = tx.writeValueOrThrow.bind(tx);
      tx.writeValueOrThrow = (...args) => {
        const value = args[1] as Record<string, unknown> | undefined;
        if (value?.schema === AGENT_CONNECTOR_SCHEMAS.session) {
          writesManifest = true;
        }
        return originalWriteValue(...args);
      };
      const originalCommit = tx.commit.bind(tx);
      tx.commit = () => {
        if (!writesManifest) return originalCommit();
        const failure = Object.assign(
          new Error("manifest commit interrupted"),
          {
            name: "PreconditionFailedError" as const,
            precondition: "origin-committed" as const,
          },
        );
        tx.abort(failure);
        return Promise.resolve({ error: failure });
      };
      return tx;
    };
    try {
      await assertRejects(
        () =>
          target.publish([{
            source,
            sessions: [snapshot("After", [{
              id: "event-1",
              type: "message",
              detail: { value: 1 },
            }, {
              id: "event-2",
              type: "message",
              detail: linkRefFrom({ path: ["0", "detail"] }),
            }])],
            errors: [],
            complete: true,
          }]),
        Error,
        "manifest commit interrupted",
      );
    } finally {
      runtime.edit = originalEdit;
    }

    const retained = await readStableCellGraphValue(
      connection,
      manifest,
    ) as Record<string, unknown>;
    assertEquals(
      (retained.summary as Record<string, unknown>).title,
      "Before",
    );
    const descriptor = (retained.chunks as Array<Record<string, unknown>>)[0];
    const chunk = descriptor.link as Record<string, unknown>;
    assertEquals(descriptor.contentHash, chunk.contentHash);
    assertEquals(chunk.events, [{
      id: "event-1",
      type: "message",
      detail: { value: 1 },
    }, {
      id: "event-2",
      type: "message",
      detail: { value: 1 },
    }]);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalidLaterSession = snapshot("Invalid", [circular]);
    invalidLaterSession.summary = {
      ...invalidLaterSession.summary,
      nativeSessionId: "session-2",
    };
    await assertRejects(
      () =>
        target.publish([{
          source,
          sessions: [
            snapshot("Not committed", [{ id: "replacement" }]),
            invalidLaterSession,
          ],
          errors: [],
          complete: true,
        }]),
      Error,
      "Conversion refuses a circular reference",
    );
    const retainedAfterLaterFailure = await readStableCellGraphValue(
      connection,
      manifest,
    ) as Record<string, unknown>;
    assertEquals(
      (retainedAfterLaterFailure.summary as Record<string, unknown>).title,
      "Before",
    );
    const retainedIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (retainedIndex.sessions as Array<Record<string, unknown>>)[0].title,
      "Before",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("session publication captures native values once", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector native value capture test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  let conversions = 0;
  const sharedNativeValue = {
    toJSON() {
      conversions++;
      return { value: `captured-${conversions}` };
    },
  };
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot: NativeSessionSnapshot = {
    summary: {
      nativeSessionId: "session-1",
      title: "Native values",
      cwd: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:01:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1" },
    },
    events: [{
      id: "event-1",
      first: sharedNativeValue,
      second: sharedNativeValue,
    }],
    normalizedMessages: [],
    complete: true,
  };
  try {
    const target = await AgentFabricTarget.open(connection);
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    assertEquals(conversions, 1);

    const manifest = await publishedManifestCell(
      connection,
      target,
      "session-1",
    );
    const published = await readStableCellGraphValue(
      connection,
      manifest,
    ) as Record<string, unknown>;
    const descriptor = (published.chunks as Array<
      Record<string, unknown>
    >)[0];
    const chunk = descriptor.link as Record<string, unknown>;
    assertEquals(chunk.events, [{
      id: "event-1",
      first: { value: "captured-1" },
      second: { value: "captured-1" },
    }]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("session publication captures its snapshot before the first commit", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector incremental session publication test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  let captures = 0;
  const events = ["one", "two", "three"].map((id) => ({
    toJSON() {
      captures++;
      return { id, text: "x".repeat(530_000) };
    },
  }));
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  try {
    const target = await AgentFabricTarget.open(connection);
    const capturesAtCommit: number[] = [];
    const originalEdit = runtime.edit;
    runtime.edit = function () {
      const tx = originalEdit.call(this);
      const originalCommit = tx.commit.bind(tx);
      tx.commit = async () => {
        capturesAtCommit.push(captures);
        return await originalCommit();
      };
      return tx;
    };
    try {
      await target.publish([{
        source,
        sessions: [{
          summary: {
            nativeSessionId: "session-1",
            title: "Incremental publication",
            cwd: null,
            createdAt: null,
            updatedAt: null,
            archived: false,
            active: false,
            raw: { id: "session-1" },
          },
          events,
          normalizedMessages: [],
          complete: true,
        }],
        errors: [],
        complete: true,
      }]);
    } finally {
      runtime.edit = originalEdit;
    }

    assertEquals(captures, 3);
    assertEquals(capturesAtCommit[0], 3);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("newer session refresh wins over an older full collection", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector observation ordering test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    const snapshot = (
      active: boolean | null,
      title: string,
      nativeSessionId = "session-1",
    ): NativeSessionSnapshot => ({
      summary: {
        nativeSessionId,
        title,
        cwd: null,
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:01:00.000Z",
        archived: null,
        active,
        raw: { id: nativeSessionId, title },
      },
      events: [],
      normalizedMessages: [],
      complete: true,
      revision: title,
    });

    const olderObservation = target.beginSessionObservation();
    const olderCollectionObserved = Promise.withResolvers<void>();
    const releaseOlderCollection = Promise.withResolvers<void>();
    const olderPublication = (async () => {
      const collected = [{
        source,
        sessions: [snapshot(true, "Running snapshot")],
        errors: [],
        complete: true,
      }];
      olderCollectionObserved.resolve();
      await releaseOlderCollection.promise;
      return await target.publish(collected, {
        observationSequence: olderObservation,
      });
    })();

    await olderCollectionObserved.promise;
    const refreshedSource: SourceDescriptor = {
      ...source,
      capabilities: {
        ...source.capabilities,
        setMode: false,
        modes: [],
      },
    };
    const driver = {
      source: refreshedSource,
      readSession: () => Promise.resolve(snapshot(null, "Terminal snapshot")),
    } as unknown as AgentDriver;
    try {
      await target.refreshSession(driver, "session-1");
    } finally {
      releaseOlderCollection.resolve();
    }
    await olderPublication;

    const index = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const published = (index.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(published.active, null);
    assertEquals(published.title, "Terminal snapshot");
    assertEquals(published.syncStatus, "complete");
    assertEquals(
      (published.capabilities as Record<string, unknown>).setMode,
      false,
    );
    assertEquals(
      ((index.sources as Array<Record<string, unknown>>)[0]
        .capabilities as Record<string, unknown>).setMode,
      false,
    );
    const manifest = published.manifest as Record<string, unknown>;
    const summary = manifest.summary as Record<string, unknown>;
    assertEquals(summary.active, null);
    assertEquals(summary.title, "Terminal snapshot");

    const olderCompleteObservation = target.beginSessionObservation();
    const newerCompleteObservation = target.beginSessionObservation();
    await target.publish([{
      source,
      sessions: [],
      errors: [],
      complete: true,
    }], { observationSequence: newerCompleteObservation });
    await target.publish([{
      source,
      sessions: [snapshot(true, "Obsolete snapshot", "session-2")],
      errors: [],
      complete: true,
    }], { observationSequence: olderCompleteObservation });
    const afterOlderCollection = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (afterOlderCollection.sessions as Array<Record<string, unknown>>).map(
        (session) => ({
          nativeSessionId: session.nativeSessionId,
          syncStatus: session.syncStatus,
        }),
      ),
      [{ nativeSessionId: "session-1", syncStatus: "deleted" }],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("newer session refresh wins over an older retained inventory", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector retained observation ordering test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  const gitContext = new GitContextResolver((args) => {
    const directory = args[1];
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      return Promise.resolve({ code: 0, stdout: `${directory}\n` });
    }
    if (command === "branch --show-current") {
      return Promise.resolve({ code: 0, stdout: `${directory.slice(1)}\n` });
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve({
        code: 0,
        stdout: `head-${directory.slice(1)}\n`,
      });
    }
    if (command === "remote -v") {
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return Promise.resolve({ code: 1, stdout: "" });
  }, () => new Date("2026-09-14T12:00:00.000Z"));
  try {
    const target = await AgentFabricTarget.open(connection, gitContext);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    const snapshot = (cwd: string, title: string): NativeSessionSnapshot => ({
      summary: {
        nativeSessionId: "session-1",
        title,
        cwd,
        createdAt: "2026-09-14T10:00:00.000Z",
        updatedAt: "2026-09-14T10:01:00.000Z",
        archived: false,
        active: false,
        raw: { id: "session-1", title },
      },
      events: [],
      normalizedMessages: [],
      complete: true,
      revision: title,
    });
    const initial = snapshot("/initial", "Initial snapshot");
    await target.publish([{
      source,
      sessions: [initial],
      errors: [],
      complete: true,
    }]);

    const olderObservation = target.beginSessionObservation();
    const driver = {
      source,
      readSession: () => Promise.resolve(snapshot("/new", "New snapshot")),
    } as unknown as AgentDriver;
    await target.refreshSession(driver, "session-1");
    await target.publish([{
      source,
      sessions: [],
      retained: [{ ...initial.summary, cwd: "/stale" }],
      errors: [],
      complete: true,
    }], { observationSequence: olderObservation });

    const index = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const published = (index.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(
      [
        published.title,
        published.gitWorktreeRoot,
        published.gitBranch,
        published.gitHeadSha,
      ],
      ["New snapshot", "/new", "new", "head-new"],
    );
    const manifest = published.manifest as Record<string, unknown>;
    assertEquals(
      (manifest.summary as Record<string, unknown>).title,
      "New snapshot",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a published pairing with a desktop start survives a driver that no longer knows it", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector desktop pairing persistence test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
        startSession: true,
        surfaces: ["headless", "desktop"],
      },
    };
    const snapshot = (
      revision: string,
      startedAs?: string,
    ): NativeSessionSnapshot => ({
      summary: {
        nativeSessionId: "app-made",
        title: "topic #7: the workbench",
        cwd: "/work/labs",
        createdAt: "2026-09-22T20:00:00.000Z",
        updatedAt: `2026-09-22T20:0${revision}:00.000Z`,
        archived: false,
        active: null,
        ...(startedAs ? { startedAs } : {}),
        raw: { id: "app-made", revision },
      },
      events: [],
      normalizedMessages: [],
      complete: true,
      revision,
    });
    const rowOf = async () => {
      const index = await readStableCellGraphValue(
        connection,
        target.cells.allIndex,
      ) as Record<string, unknown>;
      return (index.sessions as Array<Record<string, unknown>>)[0];
    };

    // The driver that opened the desktop start pairs the session it made.
    await target.publish([{
      source,
      sessions: [snapshot("1", "the-start-id")],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    assertEquals((await rowOf()).startedAs, "the-start-id");
    expect(
      (await target.publishedSessions()).get(sessionKey(source.id, "app-made"))
        ?.startedAs,
    ).toBe("the-start-id");

    // After a host restart the driver reads the session without the pairing
    // it no longer holds; the row keeps the one it was published with, so
    // the workbench that attached the session through its start keeps it.
    await target.publish([{
      source,
      sessions: [snapshot("2")],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const republished = await rowOf();
    assertEquals(republished.startedAs, "the-start-id");
    assertEquals(republished.updatedAt, "2026-09-22T20:02:00.000Z");

    // A post-command refresh reads the session the same way.
    const driver = {
      source,
      readSession: () => Promise.resolve(snapshot("3")),
    } as unknown as AgentDriver;
    await target.refreshSession(driver, "app-made");
    const refreshed = await rowOf();
    assertEquals(refreshed.startedAs, "the-start-id");
    assertEquals(refreshed.updatedAt, "2026-09-22T20:03:00.000Z");
    expect(
      (await target.publishedSessions()).get(sessionKey(source.id, "app-made"))
        ?.startedAs,
    ).toBe("the-start-id");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("publication refuses a stored index whose source surfaces are malformed", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector malformed surfaces test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
        startSession: true,
        surfaces: ["headless", "desktop"],
      },
    };
    await target.publish(
      [{ source, sessions: [], errors: [], complete: true }],
      { observationSequence: target.beginSessionObservation() },
    );
    // A surface that is not a string, written into the stored row past the
    // connector; a pattern reading `surfaces` would otherwise throw on it.
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    target.cells.allIndex.key("sources").key(0).key("capabilities").withTx(tx)
      .set({ ...source.capabilities, surfaces: "desktop" });
    tx.prepareCfc();
    const commit = await tx.commit();
    if (commit.error) throw commit.error;
    await assertRejects(
      () =>
        target.publish([], {
          observationSequence: target.beginSessionObservation(),
        }),
      Error,
      "has an invalid shape",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("publication refuses a stored index whose source capabilities are malformed", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector malformed capabilities test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    await target.publish(
      [{ source, sessions: [], errors: [], complete: true }],
      {
        observationSequence: target.beginSessionObservation(),
      },
    );
    // A capability flag that is not a boolean, written into the stored row
    // past the connector, as a row the connector never produced would be.
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    target.cells.allIndex.key("sources").key(0).key("capabilities").withTx(tx)
      .set({ ...source.capabilities, startSession: "yes" });
    tx.prepareCfc();
    const commit = await tx.commit();
    if (commit.error) throw commit.error;
    await assertRejects(
      () =>
        target.publish([], {
          observationSequence: target.beginSessionObservation(),
        }),
      Error,
      "has an invalid shape",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

/** A verified-writer authorization naming a handler in module `path`. */
function writerAuthorizationFor(path: string) {
  return {
    __ctWriterIdentityOf: {
      file: `${path}/main.tsx`,
      moduleIdentity: `fid1:verified-${path}`,
      path: ["sendCommand"],
    },
  };
}

Deno.test("Fabric target binds producer queues and reads commands from every bound queue", async () => {
  const owner = await Identity.fromPassphrase("producer queue binding owner");
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const pushAs = async (
    cell: Cell<unknown>,
    authorization: ReturnType<typeof writerAuthorizationFor>,
    value: string,
  ) => {
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: authorization.__ctWriterIdentityOf.moduleIdentity,
      sourceFile: authorization.__ctWriterIdentityOf.file,
      bindingPath: authorization.__ctWriterIdentityOf.path,
    });
    const queue = cell.withTx(tx);
    const existing = queue.getRawUntyped({ frozen: false });
    queue.setRawUntyped([...(Array.isArray(existing) ? existing : []), value]);
    tx.prepareCfc();
    const result = await tx.commit();
    if (result.error) throw result.error;
  };
  try {
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: owner.did(),
      ownerDid: owner.did(),
    });
    assertEquals(target.commandsAreBound(), false);
    await assertRejects(
      () => target.bindProducerCommandCell("workbench", { bogus: true }),
      Error,
      "command writer authorization is invalid",
    );

    const workbenchAuthorization = writerAuthorizationFor("workbench");
    const workbenchQueue = await target.bindProducerCommandCell(
      "workbench",
      workbenchAuthorization,
    );
    assertEquals(target.commandsAreBound(), true);
    assertNotEquals(
      stableCellId(workbenchQueue.resolveAsCell()),
      target.commandCellId(),
    );
    assertEquals(
      cellHasOwnerProtection(runtime.readTx(), workbenchQueue, owner.did()),
      true,
    );
    // A producer ID names one queue.
    await assertRejects(
      () => target.bindProducerCommandCell("workbench", workbenchAuthorization),
      Error,
      "command producer is already bound: workbench",
    );
    const ownerAuthorization = writerAuthorizationFor("debug-view");
    await target.bindCommandCell(target.cells.commands, ownerAuthorization);
    assertEquals(await target.pollCommands(), []);

    // Every queue bound before the subscription is read, and each delivery
    // names its queue's producer; the owner's queue names none. The
    // deliveries arrive through the cells' sinks, so the test waits for the
    // two it pushes rather than reading the list at a moment of its choosing.
    const received: Array<{ producer?: string; commands: unknown[] }> = [];
    const bothDelivered = Promise.withResolvers<void>();
    const cancel = await target.subscribeCommands((commands, producer) => {
      received.push({ producer, commands });
      const fromWorkbench = received.some((delivery) =>
        delivery.producer === "workbench" &&
        delivery.commands.includes("from-workbench")
      );
      const fromOwner = received.some((delivery) =>
        delivery.producer === undefined &&
        delivery.commands.includes("from-owner")
      );
      if (fromWorkbench && fromOwner) bothDelivered.resolve();
    });
    try {
      // A subscription covers the queues bound when it began, so binding
      // another while it is live is refused rather than silently unread.
      await assertRejects(
        () =>
          target.bindProducerCommandCell(
            "late",
            writerAuthorizationFor("late"),
          ),
        Error,
        "producer late queue cannot be bound while commands are subscribed",
      );
      await pushAs(workbenchQueue, workbenchAuthorization, "from-workbench");
      await pushAs(target.cells.commands, ownerAuthorization, "from-owner");
      await runtime.storageManager.synced();
      assertEquals(
        (await target.pollCommands()).toSorted(),
        ["from-owner", "from-workbench"],
      );
      await bothDelivered.promise;
    } finally {
      cancel();
    }
    // Once the subscription is cancelled, a queue can be bound again.
    await target.bindProducerCommandCell(
      "late",
      writerAuthorizationFor("late"),
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a session read this publication is not also retained", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector read wins over retention test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    const snapshot: NativeSessionSnapshot = {
      summary: {
        nativeSessionId: "session-1",
        title: "Read once",
        cwd: null,
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: "2026-09-11T10:01:00.000Z",
        archived: null,
        active: null,
        raw: { id: "session-1" },
      },
      events: [{ text: "hello" }],
      normalizedMessages: [],
      complete: true,
    };
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });

    // A collected source naming one session as both read (now a partial
    // transcript) and retained: the read is the session's outcome, so its
    // row is partial and the source counts it once.
    await target.publish([{
      source,
      sessions: [{ ...snapshot, events: [{ text: "hel" }], complete: false }],
      retained: [snapshot.summary],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const index = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (index.sessions as Array<Record<string, unknown>>).map((row) => [
        row.nativeSessionId,
        row.syncStatus,
      ]),
      [["session-1", "partial"]],
    );
    const sourceRow = (index.sources as Array<Record<string, unknown>>)[0];
    assertEquals(sourceRow.sessionCount, 1);
    assertEquals(sourceRow.errors, []);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a retained session's row carries the checkout's current Git context", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector retained git context test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  // The checkout as Git reports it, changed between publications.
  let branch = "main";
  let head = "head-1";
  let observedAt = "2026-09-14T12:00:00.000Z";
  let failObservation = false;
  const gitContext = new GitContextResolver(
    (args) => {
      const command = args.slice(2).join(" ");
      if (command === "rev-parse --show-toplevel") {
        if (failObservation) {
          return Promise.reject(new Deno.errors.NotFound("git"));
        }
        return Promise.resolve({ code: 0, stdout: "/repo\n" });
      }
      if (command === "branch --show-current") {
        return Promise.resolve({ code: 0, stdout: `${branch}\n` });
      }
      if (command === "rev-parse HEAD") {
        return Promise.resolve({ code: 0, stdout: `${head}\n` });
      }
      if (command === "remote -v") {
        return Promise.resolve({
          code: 0,
          stdout: "origin\tgit@github.com:common/repo.git (fetch)\n",
        });
      }
      if (command === "remote get-url upstream") {
        return Promise.resolve({ code: 1, stdout: "" });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    },
    () => new Date(observedAt),
  );
  try {
    const target = await AgentFabricTarget.open(connection, gitContext);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    const snapshot: NativeSessionSnapshot = {
      summary: {
        nativeSessionId: "session-1",
        title: "On a branch",
        cwd: "/repo",
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: "2026-09-11T10:01:00.000Z",
        archived: null,
        active: null,
        raw: { id: "session-1" },
      },
      events: [{ text: "hello" }],
      normalizedMessages: [],
      complete: true,
    };
    const readRow = async () => {
      const index = await readStableCellGraphValue(
        connection,
        target.cells.allIndex,
      ) as Record<string, unknown>;
      const row = (index.sessions as Array<Record<string, unknown>>)[0];
      const manifest = row.manifest as Record<string, unknown>;
      const checkouts = index.checkouts as Array<Record<string, unknown>>;
      return {
        branch: row.gitBranch,
        head: row.gitHeadSha,
        contentHash: row.contentHash,
        manifestBranch: (manifest.summary as Record<string, unknown>)
          .gitBranch,
        checkoutHead: checkouts.find((c) => c.root === "/repo")?.gitHeadSha,
      };
    };
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const read = await readRow();
    assertEquals(
      [read.branch, read.head, read.manifestBranch, read.checkoutHead],
      ["main", "head-1", "main", "head-1"],
    );

    // The checkout moves while the transcript does not: the retained row and
    // the checkout index follow it; the graph keeps its content and the
    // manifest the context of its last read.
    branch = "feature";
    head = "head-2";
    observedAt = "2026-09-14T12:05:00.000Z";
    await target.publish([{
      source,
      sessions: [],
      retained: [snapshot.summary],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const retained = await readRow();
    assertEquals(
      [
        retained.branch,
        retained.head,
        retained.manifestBranch,
        retained.checkoutHead,
      ],
      ["feature", "head-2", "main", "head-2"],
    );
    assertEquals(retained.contentHash, read.contentHash);

    // A failed observation keeps the row's last context, as a read does.
    failObservation = true;
    observedAt = "2026-09-14T12:10:00.000Z";
    await target.publish([{
      source,
      sessions: [],
      retained: [snapshot.summary],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const preserved = await readRow();
    assertEquals([preserved.branch, preserved.head], ["feature", "head-2"]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a subscription that fails on a later queue leaves no queue subscribed", async () => {
  const owner = await Identity.fromPassphrase(
    "producer subscription failure owner",
  );
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: owner.did(),
      ownerDid: owner.did(),
    });
    await target.bindCommandCell(
      target.cells.commands,
      writerAuthorizationFor("debug-view"),
    );
    await target.bindProducerCommandCell(
      "workbench",
      writerAuthorizationFor("workbench"),
    );

    // Each queue's sink delivers its current commands as the subscription
    // begins. The owner's queue is subscribed first; a callback that fails
    // on the producer's queue fails the subscription, and the owner's queue
    // is unsubscribed again rather than left delivering to nobody.
    const deliveries: Array<string | undefined> = [];
    await assertRejects(
      () =>
        target.subscribeCommands((_commands, producer) => {
          deliveries.push(producer);
          if (producer === "workbench") {
            throw new Error("workbench delivery refused");
          }
        }),
      Error,
      "workbench delivery refused",
    );
    assertEquals(deliveries, [undefined, "workbench"]);
    // Nothing is subscribed, so a queue can still be bound, and a
    // subscription that succeeds covers all three queues.
    await target.bindProducerCommandCell(
      "late",
      writerAuthorizationFor("late"),
    );
    const subscribed: Array<string | undefined> = [];
    const cancel = await target.subscribeCommands((_commands, producer) => {
      subscribed.push(producer);
    });
    try {
      assertEquals(subscribed, [undefined, "workbench", "late"]);
    } finally {
      cancel();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("receipts from different queues share a command ID without colliding", async () => {
  const owner = await Identity.fromPassphrase(
    "producer receipt identity owner",
  );
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = owner.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  const receipt = (
    overrides: Partial<AgentSessionCommandReceipt>,
  ): AgentSessionCommandReceipt => ({
    schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    ownerDid: space,
    commandId: "one",
    sourceId: "claude-code:test",
    nativeSessionId: "session-1",
    status: "succeeded",
    claimedAt: "2026-09-13T10:00:00.000Z",
    completedAt: "2026-09-13T10:00:01.000Z",
    ...overrides,
  });
  try {
    const target = await AgentFabricTarget.open(connection);
    await target.publishReceipt(receipt({}));
    await target.publishReceipt(receipt({
      producer: "workbench",
      status: "failed",
      error: { code: "refused", message: "no", retryable: false },
    }));
    // The owner's and the producer's receipts are distinct cells and rows.
    assertEquals((await target.readReceipt("one"))?.status, "succeeded");
    assertEquals((await target.readReceipt("one"))?.producer, undefined);
    assertEquals(
      (await target.readReceipt("one", "workbench"))?.status,
      "failed",
    );
    assertEquals(
      (await target.readReceipt("one", "workbench"))?.producer,
      "workbench",
    );
    assertEquals(await target.readReceipt("one", "dashboard"), undefined);
    const index = await readStableCellGraphValue(
      connection,
      target.cells.receipts,
    ) as { receipts: Array<Record<string, unknown>> };
    assertEquals(
      index.receipts.map((row) => [row.commandId, row.producer, row.status]),
      [["one", undefined, "succeeded"], ["one", "workbench", "failed"]],
    );
    // A later receipt for the producer's command replaces its own row only.
    await target.publishReceipt(receipt({
      producer: "workbench",
      status: "succeeded",
    }));
    const updated = await readStableCellGraphValue(
      connection,
      target.cells.receipts,
    ) as { receipts: Array<Record<string, unknown>> };
    assertEquals(
      updated.receipts.map((row) => [row.commandId, row.producer, row.status]),
      [["one", undefined, "succeeded"], ["one", "workbench", "succeeded"]],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("publication keeps an older retained session and vouches only for complete copies", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector retained session test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    const snapshot: NativeSessionSnapshot = {
      summary: {
        nativeSessionId: "session-1",
        title: "Read once",
        cwd: null,
        createdAt: "2000-01-01T10:00:00.000Z",
        updatedAt: "2000-01-01T10:01:00.000Z",
        archived: null,
        active: null,
        raw: { id: "session-1" },
      },
      events: [{ text: "hello" }],
      normalizedMessages: [],
      complete: true,
    };
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const recentIndex = await readStableCellGraphValue(
      connection,
      target.cells.index,
    ) as Record<string, unknown>;
    assertEquals(recentIndex.sessions, []);
    const before = await target.publishedSessions();
    const priorState = before.get("claude-code%3Atest/session-1");
    assertEquals(priorState, {
      driver: "claude-agent-sdk",
      updatedAt: "2000-01-01T10:01:00.000Z",
      archived: null,
      active: null,
      syncStatus: "complete",
    });
    const firstIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const firstHash =
      (firstIndex.sessions as Array<Record<string, unknown>>)[0].contentHash;

    await target.publish([{
      source,
      sessions: [],
      retained: [snapshot.summary],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const retainedIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const rows = retainedIndex.sessions as Array<Record<string, unknown>>;
    assertEquals(
      rows.map((row) => [row.nativeSessionId, row.syncStatus, row.contentHash]),
      [["session-1", "complete", firstHash]],
    );
    assertEquals(
      ((rows[0].manifest as Record<string, unknown>).summary as Record<
        string,
        unknown
      >).title,
      "Read once",
    );
    const sourceRow = (retainedIndex.sources as Array<Record<string, unknown>>)[
      0
    ];
    assertEquals(sourceRow.complete, true);
    assertEquals(sourceRow.sessionCount, 1);

    await target.publish([{
      source,
      sessions: [],
      retained: [{ ...snapshot.summary, nativeSessionId: "session-2" }],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const afterIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (afterIndex.sessions as Array<Record<string, unknown>>).map((row) => [
        row.nativeSessionId,
        row.syncStatus,
      ]),
      [["session-1", "stale"]],
    );
    const afterSource = (afterIndex.sources as Array<Record<string, unknown>>)[
      0
    ];
    assertEquals(afterSource.complete, false);
    assertEquals(afterSource.errors, [{
      nativeSessionId: "session-2",
      message: "retained session has no complete published copy",
    }]);

    // Retaining a session whose prior row is not complete is an error like a
    // failed read: the row is marked partial, not restored to complete.
    await target.publish([{
      source,
      sessions: [],
      retained: [snapshot.summary],
      errors: [],
      complete: true,
    }], { observationSequence: target.beginSessionObservation() });
    const partialIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (partialIndex.sessions as Array<Record<string, unknown>>).map((row) => [
        row.nativeSessionId,
        row.syncStatus,
        row.contentHash,
      ]),
      [["session-1", "partial", firstHash]],
    );
    const partialSource =
      (partialIndex.sources as Array<Record<string, unknown>>)[0];
    assertEquals(partialSource.complete, false);
    assertEquals(partialSource.errors, [{
      nativeSessionId: "session-1",
      message: "retained session has no complete published copy",
    }]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
