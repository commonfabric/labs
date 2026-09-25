// Agent-sessions debug view: pattern behavior. Shared fixtures live in
// `debug_view_support.ts`; see there for why the suite spans several files.

import type { RawDataProvenance } from "../../debug-view/main.tsx";
import { resolvedSchema } from "../../../../runner/test/schema-ref-helpers.ts";
import { SESSION_PAGE_SIZE } from "../../debug-view/presentation.ts";
import type { Cell } from "../../../../runner/src/builder/types.ts";
import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentOwnerSchema,
} from "@commonfabric/agents-connector/fabric-graph";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  cellLinkCells,
  cellLinkIds,
  countSessionRawDataLinks,
  DebugArgumentSchema,
  deployDebugPiece,
  deployRawDataPiece,
  identity,
  loadRawDataView,
  materializeCell,
  newSharedServer,
  publishedSessionTableRows,
  readRawDataProvenance,
  renderedAriaSortValues,
  renderedNodes,
  renderedTableCells,
  renderedText,
  sessionSnapshot,
  SharedServerStorageManager,
  sourceDescriptor,
  tableRowWithFirstCell,
  tableWithHeaders,
} from "./debug_view_support.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "@commonfabric/runner/cfc/trust-authority";

Deno.test("debug pattern accepts empty target cells before collection", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-empty-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const piece = await deployDebugPiece(manager, target);

    assertEquals(typeof piece.id, "string");
    assertEquals(
      JSON.stringify(manager.getArgument(piece.getCell()).getRaw()).includes(
        "SessionIndexInput",
      ),
      false,
    );
    // The stored link schema rides as a content-addressed reference;
    // recompose it and locate the definitions by shape — recomposition
    // derives `$defs` names from content hashes, not the authored ones.
    const argumentSchema = resolvedSchema(
      manager.getArgument(piece.getCell()).getAsNormalizedFullLink().schema,
    ) as DebugArgumentSchema;
    const definitions = Object.values(
      argumentSchema.$defs ?? {},
      // deno-lint-ignore no-explicit-any
    ) as any[];
    const sessionIndexInput = definitions.find((definition) =>
      definition?.properties?.sources && definition?.properties?.sessions
    );
    assertEquals(sessionIndexInput !== undefined, true);
    for (const field of ["sources", "sessions"] as const) {
      const item = sessionIndexInput?.properties?.[field]?.items;
      assertEquals(
        item?.asCell?.includes("opaque"),
        true,
      );
      assertEquals(
        item?.anyOf,
        undefined,
      );
    }
    const publishedSessionInput = definitions.find((definition) =>
      definition?.properties?.active && definition?.properties?.archived
    );
    assertEquals(publishedSessionInput !== undefined, true);
    for (const field of ["active", "archived"] as const) {
      const alternatives = publishedSessionInput?.properties?.[field]?.anyOf ??
        [];
      // deno-lint-ignore no-explicit-any
      assertEquals(
        alternatives.some((schema: any) =>
          schema.type === "null" ||
          (Array.isArray(schema.type) && schema.type.includes("null"))
        ),
        true,
      );
    }
    assertEquals(
      publishedSessionInput?.required?.includes("driver") ?? false,
      false,
    );
    assertEquals(piece.name(), "Agent sessions");
    assertEquals(await piece.result.get(["sourceCount"]), 0);
    assertEquals(await piece.result.get(["sessionCount"]), 0);
    assertEquals(await piece.result.get(["activityCount"]), 0);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern renders sessions published after deployment", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-publish-after-deploy-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const piece = await deployDebugPiece(manager, target);
    const snapshot = sessionSnapshot();
    snapshot.summary.archived = null;
    snapshot.summary.active = null;
    snapshot.normalizedMessages[0].createdAt = null;
    snapshot.normalizedMessages[0].textPreview = null;
    const source = sourceDescriptor();
    source.id = "claude";
    source.driver = "claude-agent-sdk";
    source.capabilities.modes = [
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "auto",
    ];
    source.capabilities.configOptions = {
      model: { type: "string" },
    };

    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();

    const result = await piece.result.get() as Record<string, unknown>;
    assertEquals(await piece.result.get(["sessionCount"]), 1);
    assertEquals(countSessionRawDataLinks(result["$UI"]), 1);
    assertEquals(
      renderedNodes(result["$UI"]).some((node) =>
        node.name === "cf-badge" && renderedText(node.children) === "unknown"
      ),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern submits commands and links row data to separate views", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-command-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  let actingPrincipal = session.as.did();
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    trustSnapshotProvider: () => ({
      id: `principal:${actingPrincipal}`,
      actingPrincipal,
    }),
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const source = sourceDescriptor();
    const snapshot = sessionSnapshot();
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    const firstActivity = {
      id: "activity-1",
      at: "2026-07-20T00:01:00.000Z",
      type: "host-started",
      message: "Host startup completed",
      details: {
        phase: "startup",
        sessionCount: 1,
        capabilities: ["read", "write"],
      },
    };
    const health = {
      service: "agents-host",
      status: "ready",
      startedAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:01:00.000Z",
      target: {
        spaceDid: session.space,
        ownerDid: session.as.did(),
        cells: {
          recentIndex: "recent-index",
          allIndex: "all-index",
          health: "health",
          commands: "commands",
          receipts: "receipts",
        },
      },
      commandProcessing: {
        accepting: true,
        pendingReceiptPublications: 0,
        failedCommands: 0,
      },
      sources: [{
        ...source,
        status: "ready",
        sessionCount: 1,
        complete: true,
        errors: [],
      }],
      activity: [firstActivity],
    };
    await target.publishHealth(health);
    const piece = await deployDebugPiece(manager, target);
    await runtime.settled();
    const resultCell = await piece.result.getCell();
    const resultLink = resultCell.getAsNormalizedFullLink();
    const resultInspect = runtime.edit();
    const storedResult = resultInspect.readOrThrow({
      space: resultLink.space,
      id: resultLink.id,
      path: [],
      ...(resultLink.scope !== undefined && { scope: resultLink.scope }),
    }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
    assertEquals(
      storedResult.cfc?.labelMap?.entries?.some((entry) =>
        JSON.stringify(entry).includes("confidentiality") &&
        JSON.stringify(entry).includes(session.as.did())
      ),
      true,
    );
    resultInspect.abort();
    const resultAttack = runtime.edit();
    setCfcTrustSnapshot(resultAttack, {
      id: "principal:did:key:other-debug-owner",
      actingPrincipal: "did:key:other-debug-owner",
    });
    resultCell.withTx(resultAttack).setRawUntyped({ compromised: true });
    resultAttack.prepareCfc();
    const resultAttackCommit = await resultAttack.commit();
    assertEquals(resultAttackCommit.error !== undefined, true);

    let result = await piece.result.get() as Record<string, unknown>;
    const commandButton = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Command"
    );
    const selectTarget = materializeCell(commandButton?.props?.onClick);
    assertEquals(
      typeof (selectTarget as { send?: unknown } | undefined)?.send,
      "function",
    );
    (selectTarget as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const form = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-form"
    );
    const prompt = renderedNodes(form?.children).find((node) =>
      node.name === "cf-textarea"
    );
    const promptCell = prompt?.props?.["$value"];
    assertEquals(
      typeof (promptCell as { set?: unknown } | undefined)?.set,
      "function",
    );
    const promptTx = runtime.edit();
    (promptCell as Cell<string>).withTx(promptTx).set(
      "Continue from the deployed debug view",
    );
    const promptCommit = await promptTx.commit();
    if (promptCommit.error) throw promptCommit.error;
    await runtime.settled();

    const review = materializeCell(form?.props?.["oncf-submit"]);
    assertEquals(
      typeof (review as { send?: unknown } | undefined)?.send,
      "function",
    );
    (review as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const modal = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-modal"
    );
    assertEquals(materializeCell(modal?.props?.["$open"]), true);
    const sendButton = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-button" &&
      renderedText(node.children) === "Send command"
    );
    const send = materializeCell(sendButton?.props?.onClick);
    assertEquals(
      typeof (send as { send?: unknown } | undefined)?.send,
      "function",
    );
    actingPrincipal = "did:key:other-owner";
    (send as { send: (event: unknown) => void }).send({});
    await runtime.settled();
    assertEquals(await target.pollCommands(), []);

    actingPrincipal = session.as.did();
    (send as { send: (event: unknown) => void }).send({});
    await runtime.settled();
    const actionValues = await target.pollCommands();
    assertEquals(actionValues.length, 1);
    assertEquals(typeof actionValues[0], "string");
    const command = JSON.parse(String(actionValues[0]));
    assertEquals(command.schema, "commonfabric.agent-connector.command");
    assertEquals(command.sourceId, source.id);
    assertEquals(
      command.nativeSessionId,
      snapshot.summary.nativeSessionId,
    );
    assertEquals(command.type, "prompt");
    assertEquals(
      command.payload,
      { text: "Continue from the deployed debug view" },
    );
    const commandLink = target.cells.commands.getAsNormalizedFullLink();
    const protectedCommandLink = target.cells.commands.resolveAsCell()
      .getAsNormalizedFullLink();
    const inspect = runtime.edit();
    const stored = inspect.readOrThrow({
      space: protectedCommandLink.space,
      id: protectedCommandLink.id,
      path: [],
      ...(protectedCommandLink.scope !== undefined && {
        scope: protectedCommandLink.scope,
      }),
    }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
    assertEquals(
      stored.cfc?.labelMap?.entries?.some((entry) =>
        JSON.stringify(entry).includes("confidentiality") &&
        JSON.stringify(entry).includes(session.as.did())
      ),
      true,
    );
    inspect.abort();

    await target.publishReceipt({
      schema: "commonfabric.agent-connector.command-receipt",
      ownerDid: session.as.did(),
      commandId: command.id,
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "in-flight",
      claimedAt: "2026-07-20T00:02:00.000Z",
    });
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const commandTable = tableWithHeaders(result["$UI"], [
      "ID",
      "Source",
      "Session",
      "Type",
      "Created",
      "Payload",
    ]);
    const receiptTable = tableWithHeaders(result["$UI"], [
      "Command",
      "Source",
      "Session",
      "Status",
      "Updated",
      "Details",
    ]);
    const activityTable = tableWithHeaders(result["$UI"], [
      "Time",
      "Type",
      "Source",
      "Message",
      "Details",
    ]);
    assertEquals(commandTable !== undefined, true);
    assertEquals(receiptTable !== undefined, true);
    assertEquals(activityTable !== undefined, true);

    for (const table of [commandTable!, receiptTable!, activityTable!]) {
      assertEquals(
        renderedNodes(table.children).some((node) => node.name === "details"),
        false,
      );
      assertEquals(cellLinkCells(table, "Raw data").length, 1);
    }

    const commandRawLink = cellLinkCells(commandTable, "Raw data")[0];
    assertEquals(
      await loadRawDataView(runtime, commandRawLink),
      { text: "Continue from the deployed debug view" },
    );
    const commandProvenance = await readRawDataProvenance(
      runtime,
      commandRawLink,
    );
    assertEquals(commandProvenance.provenance.fabric.space, session.space);
    assertEquals(
      commandProvenance.provenance.fabric.entity.includes(
        target.commandCellId(),
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.origin.includes(
        "owner's protected command queue",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.processing.includes(
        "JSON-decodes string action values",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "cf inspect value-at",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "Recursively run the commands below for every $link",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--seq REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--seq LINK_REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "A missing space uses the containing space",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--scope 'LINK_SCOPE_KEY'",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--scope '<resolved $link.scope>'",
      ),
      false,
    );
    assertEquals(
      commandProvenance.rendered.includes("Where this data comes from"),
      true,
    );

    const receiptRow = tableRowWithFirstCell(receiptTable!, command.id)!;
    const receiptRawLink = cellLinkCells(receiptRow, "Raw data")[0];
    const receiptRawLinkId = cellLinkIds(receiptRow, "Raw data")[0];
    const initialReceiptDetails = await loadRawDataView(
      runtime,
      receiptRawLink,
    ) as Record<string, unknown>;
    assertEquals(initialReceiptDetails.error, undefined);
    assertEquals(
      typeof (initialReceiptDetails.receipt as Record<string, unknown>).id,
      "string",
    );
    const receiptProvenance = await readRawDataProvenance(
      runtime,
      receiptRawLink,
    );
    assertEquals(receiptProvenance.provenance.fabric.space, session.space);
    assertEquals(
      receiptProvenance.provenance.origin.includes(
        "publishReceipt()",
      ),
      true,
    );
    assertEquals(
      receiptProvenance.provenance.retrievalCommand.includes(
        "# The row's receipt field points to the complete receipt document:",
      ),
      true,
    );
    assertEquals(
      receiptProvenance.provenance.retrievalCommand.includes(
        "--seq RECEIPT_REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      receiptProvenance.rendered.includes("Retrieve it independently"),
      true,
    );

    const activityRow = tableRowWithFirstCell(
      activityTable!,
      firstActivity.at,
    )!;
    const activityRawLink = cellLinkCells(activityRow, "Raw data")[0];
    const activityRawLinkId = cellLinkIds(activityRow, "Raw data")[0];
    assertEquals(
      await loadRawDataView(runtime, activityRawLink),
      firstActivity.details,
    );
    const activityProvenance = await readRawDataProvenance(
      runtime,
      activityRawLink,
    );
    assertEquals(activityProvenance.provenance.fabric.space, session.space);
    assertEquals(
      activityProvenance.provenance.origin.includes(
        "bounded in-memory activity list",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.processing.includes(
        "only the activity record's details field",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.retrievalCommand.includes(
        "Recursively run the commands below for every $link",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.retrievalCommand.includes(
        "--seq REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.retrievalCommand.includes(
        "--seq LINK_REVISION_SEQ",
      ),
      true,
    );

    await target.publishReceipt({
      schema: "commonfabric.agent-connector.command-receipt",
      ownerDid: session.as.did(),
      commandId: "other-command",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "succeeded",
      completedAt: "2026-07-20T00:03:00.000Z",
    });
    await target.publishReceipt({
      schema: "commonfabric.agent-connector.command-receipt",
      ownerDid: session.as.did(),
      commandId: command.id,
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "failed",
      completedAt: "2026-07-20T00:04:00.000Z",
      error: {
        code: "provider-error",
        message: "Provider rejected the command",
        retryable: false,
      },
    });
    const updatedActivityDetails = {
      phase: "ready",
      sessionCount: 2,
    };
    await target.publishHealth({
      ...health,
      updatedAt: "2026-07-20T00:05:00.000Z",
      activity: [{
        id: "activity-2",
        at: "2026-07-20T00:05:00.000Z",
        type: "collection-completed",
        message: "Collection completed",
        details: { sessionCount: 2 },
      }, {
        ...firstActivity,
        details: updatedActivityDetails,
      }],
    });
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const updatedReceiptTable = tableWithHeaders(result["$UI"], [
      "Command",
      "Source",
      "Session",
      "Status",
      "Updated",
      "Details",
    ])!;
    const updatedActivityTable = tableWithHeaders(result["$UI"], [
      "Time",
      "Type",
      "Source",
      "Message",
      "Details",
    ])!;
    const updatedReceiptRow = tableRowWithFirstCell(
      updatedReceiptTable,
      command.id,
    )!;
    const updatedActivityRow = tableRowWithFirstCell(
      updatedActivityTable,
      firstActivity.at,
    )!;
    assertEquals(renderedTableCells(updatedReceiptRow)[3], "failed");
    assertEquals(
      cellLinkIds(updatedReceiptRow, "Raw data")[0],
      receiptRawLinkId,
    );
    assertEquals(
      cellLinkIds(updatedActivityRow, "Raw data")[0],
      activityRawLinkId,
    );

    const updatedReceiptDetails = await loadRawDataView(
      runtime,
      cellLinkCells(updatedReceiptRow, "Raw data")[0],
    ) as Record<string, unknown>;
    assertEquals(updatedReceiptDetails.error, {
      code: "provider-error",
      message: "Provider rejected the command",
      retryable: false,
    });
    assertEquals(
      typeof (updatedReceiptDetails.receipt as Record<string, unknown>).id,
      "string",
    );
    assertEquals(
      await loadRawDataView(
        runtime,
        cellLinkCells(updatedActivityRow, "Raw data")[0],
      ),
      updatedActivityDetails,
    );

    const pageCommands = Array.from(
      { length: 25 },
      (_, index) =>
        JSON.stringify({
          ...command,
          id: `page-command-${index}`,
          createdAt: `2026-07-20T00:${String(index).padStart(2, "0")}:00.000Z`,
          payload: { sequence: index },
        }),
    );
    let commandTx = runtime.edit();
    target.cells.commands.resolveAsCell()
      .asSchema(agentOwnerSchema(session.as.did(), false)).withTx(commandTx)
      .setRawUntyped(pageCommands);
    commandTx.prepareCfc();
    let commandCommit = await commandTx.commit();
    if (commandCommit.error) throw commandCommit.error;
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const fullCommandPage = tableWithHeaders(result["$UI"], [
      "ID",
      "Source",
      "Session",
      "Type",
      "Created",
      "Payload",
    ])!;
    assertEquals(cellLinkCells(fullCommandPage, "Raw data").length, 25);
    const shiftedCommandRow = tableRowWithFirstCell(
      fullCommandPage,
      "page-command-1",
    )!;
    const shiftedCommandLinkId = cellLinkIds(
      shiftedCommandRow,
      "Raw data",
    )[0];

    commandTx = runtime.edit();
    target.cells.commands.resolveAsCell()
      .asSchema(agentOwnerSchema(session.as.did(), false)).withTx(commandTx)
      .setRawUntyped([
        ...pageCommands,
        JSON.stringify({
          ...command,
          id: "page-command-25",
          createdAt: "2026-07-20T00:25:00.000Z",
          payload: { sequence: 25 },
        }),
      ]);
    commandTx.prepareCfc();
    commandCommit = await commandTx.commit();
    if (commandCommit.error) throw commandCommit.error;
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const shiftedCommandPage = tableWithHeaders(result["$UI"], [
      "ID",
      "Source",
      "Session",
      "Type",
      "Created",
      "Payload",
    ])!;
    assertEquals(cellLinkCells(shiftedCommandPage, "Raw data").length, 25);
    const shiftedCommandRowAfterAppend = tableRowWithFirstCell(
      shiftedCommandPage,
      "page-command-1",
    )!;
    assertEquals(
      cellLinkIds(shiftedCommandRowAfterAppend, "Raw data")[0],
      shiftedCommandLinkId,
    );
    assertEquals(
      await loadRawDataView(
        runtime,
        cellLinkCells(shiftedCommandRowAfterAppend, "Raw data")[0],
      ),
      { sequence: 1 },
    );

    const attack = runtime.edit();
    setCfcTrustSnapshot(attack, {
      id: "principal:did:key:other-owner",
      actingPrincipal: "did:key:other-owner",
    });
    attack.writeValueOrThrow(commandLink, []);
    attack.prepareCfc();
    const attackResult = await attack.commit();
    assertEquals(attackResult.error !== undefined, true);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern bounds raw-data links to one session page", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-session-page-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const trailingSessionCount = 5;
  const sessionCount = SESSION_PAGE_SIZE * 3 + trailingSessionCount;
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    await target.publish([{
      source: sourceDescriptor(),
      sessions: Array.from(
        { length: sessionCount },
        (_, index) =>
          sessionSnapshot(
            index + 1,
            index < SESSION_PAGE_SIZE + 5
              ? "Selected session"
              : "Other session",
          ),
      ),
      errors: [],
      complete: true,
    }]);
    const recentIndexValue = target.cells.index.getRaw();
    const firstIndexSession = recentIndexValue &&
        typeof recentIndexValue === "object" &&
        !Array.isArray(recentIndexValue) &&
        "sessions" in recentIndexValue &&
        Array.isArray(recentIndexValue.sessions)
      ? recentIndexValue.sessions[0]
      : undefined;
    if (!isLinkRef(firstIndexSession)) {
      throw new Error("recent index session row link is missing");
    }
    // Represent a publication that wrote the manifest before its replacement
    // index row.
    const staleIndexRow = runtime.getCellFromLink({
      ...linkRefPayload(firstIndexSession),
      space: session.space,
      path: [],
    });
    const staleIndexTx = runtime.edit();
    setCfcImplementationIdentity(staleIndexTx, {
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    staleIndexRow.withTx(staleIndexTx).key("driver").set(
      "claude-agent-sdk",
    );
    staleIndexTx.prepareCfc();
    const staleIndexCommit = await staleIndexTx.commit();
    if (staleIndexCommit.error) throw staleIndexCommit.error;
    const piece = await deployDebugPiece(manager, target);
    await runtime.settled();

    assertEquals(
      await piece.result.get(["sessionCount"]),
      sessionCount,
    );
    let result = await piece.result.get();
    const firstPageRows = publishedSessionTableRows(
      (result as Record<string, unknown>)["$UI"],
    );
    assertEquals(
      renderedTableCells(firstPageRows[0]),
      [
        "Source",
        "Title ↕",
        "Status",
        "Sync",
        "Idle for ↕",
        "Worktree ↕",
        "Data",
      ],
    );
    assertEquals(renderedAriaSortValues(firstPageRows[0]), []);
    const initialTitles = firstPageRows.slice(1).map((row) =>
      renderedTableCells(row)[1]
    );
    const openedRawSessionLink = cellLinkCells(
      (result as Record<string, unknown>)["$UI"],
      "Raw data",
    )[0];
    assertEquals(openedRawSessionLink !== undefined, true);
    const openedRawSession = openedRawSessionLink.resolveAsCell();
    await runtime.start(openedRawSession);
    await openedRawSession.pull();
    const titleSortButton = renderedNodes(
      (result as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Title ↕"
    );
    const titleSort = materializeCell(titleSortButton?.props?.onClick);
    assertEquals(
      typeof (titleSort as { send?: unknown } | undefined)?.send,
      "function",
    );
    (titleSort as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get();
    assertEquals(
      renderedAriaSortValues(
        publishedSessionTableRows(
          (result as Record<string, unknown>)["$UI"],
        )[0],
      ),
      ["ascending"],
    );
    const ascendingTitleButton = renderedNodes(
      (result as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Title ↑"
    );
    const descendingTitleSort = materializeCell(
      ascendingTitleButton?.props?.onClick,
    );
    assertEquals(
      typeof (descendingTitleSort as { send?: unknown } | undefined)?.send,
      "function",
    );
    (descendingTitleSort as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get();
    assertEquals(
      renderedAriaSortValues(
        publishedSessionTableRows(
          (result as Record<string, unknown>)["$UI"],
        )[0],
      ),
      ["descending"],
    );
    assertEquals(
      publishedSessionTableRows(
        (result as Record<string, unknown>)["$UI"],
      ).slice(1).map((row) => renderedTableCells(row)[1]),
      initialTitles.toSorted((left, right) =>
        right.localeCompare(left, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
    );
    const firstPageLinkIds = cellLinkIds(
      (result as Record<string, unknown>)["$UI"],
      "Raw data",
    );
    assertEquals(
      countSessionRawDataLinks((result as Record<string, unknown>)["$UI"]),
      SESSION_PAGE_SIZE,
    );
    assertEquals(firstPageLinkIds.length, SESSION_PAGE_SIZE);
    const firstPageRunnerCount = runtime.runner.cancels.size;
    const nextButton = renderedNodes(
      (result as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Next"
    );
    const nextPage = materializeCell(nextButton?.props?.onClick);
    assertEquals(
      typeof (nextPage as { send?: unknown } | undefined)?.send,
      "function",
    );
    (nextPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const secondResult = await piece.result.get();
    const secondPageLinkIds = cellLinkIds(
      (secondResult as Record<string, unknown>)["$UI"],
      "Raw data",
    );
    assertEquals(
      countSessionRawDataLinks(
        (secondResult as Record<string, unknown>)["$UI"],
      ),
      SESSION_PAGE_SIZE,
    );
    assertNotEquals(secondPageLinkIds, firstPageLinkIds);
    const firstPageIds = new Set(firstPageLinkIds);
    assertEquals(
      secondPageLinkIds.every((id) => !firstPageIds.has(id)),
      true,
    );
    assertEquals(
      runtime.runner.cancels.size <= firstPageRunnerCount + 1,
      true,
    );
    openedRawSession.key("load").send({});
    await runtime.settled();
    await openedRawSession.pull();
    const openedRawSessionJson = JSON.parse(
      String(openedRawSession.key("rawJson").get()),
    );
    assertEquals(openedRawSessionJson.manifest.nativeSessionId, "session-1");
    const sessionRawSource = await readRawDataProvenance(
      runtime,
      openedRawSessionLink,
    );
    assertEquals(sessionRawSource.provenance.fabric.space, session.space);
    assertEquals(
      sessionRawSource.provenance.origin.includes(
        'connector source "codex:test"',
      ),
      true,
    );
    assertEquals(
      sessionRawSource.provenance.providerRetrieval?.includes(
        'producing driver "codex-app-server"',
      ),
      true,
    );
    assertEquals(
      sessionRawSource.provenance.providerRetrieval?.includes(
        '"threadId":"session-1"',
      ),
      true,
    );
    const openedRawRunnerCount = runtime.runner.cancels.size;
    (nextPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const thirdResult = await piece.result.get();
    const thirdPageLinkIds = cellLinkIds(
      (thirdResult as Record<string, unknown>)["$UI"],
      "Raw data",
    );
    assertEquals(
      countSessionRawDataLinks(
        (thirdResult as Record<string, unknown>)["$UI"],
      ),
      SESSION_PAGE_SIZE,
    );
    assertEquals(thirdPageLinkIds.length, SESSION_PAGE_SIZE);
    assertEquals(runtime.runner.cancels.size, openedRawRunnerCount);
    (nextPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const lastResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks((lastResult as Record<string, unknown>)["$UI"]),
      trailingSessionCount,
    );
    assertEquals(
      runtime.runner.cancels.size < openedRawRunnerCount,
      true,
    );
    const filterInput = renderedNodes(
      (lastResult as Record<string, unknown>)["$UI"],
    ).find((node) => node.name === "cf-input");
    const filter = filterInput?.props?.["$value"];
    assertEquals(
      typeof (filter as { set?: unknown } | undefined)?.set,
      "function",
    );
    const filterTx = runtime.edit();
    (filter as Cell<string>).withTx(filterTx).set("No matching session");
    await filterTx.commit();
    await runtime.settled();

    const filteredResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks(
        (filteredResult as Record<string, unknown>)["$UI"],
      ),
      0,
    );
    const previousButton = renderedNodes(
      (filteredResult as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Previous"
    );
    const previousPage = materializeCell(previousButton?.props?.onClick);
    assertEquals(
      typeof (previousPage as { send?: unknown } | undefined)?.send,
      "function",
    );
    (previousPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const previousResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks(
        (previousResult as Record<string, unknown>)["$UI"],
      ),
      0,
    );
    const clearFilterTx = runtime.edit();
    (filter as Cell<string>).withTx(clearFilterTx).set("");
    await clearFilterTx.commit();
    await runtime.settled();

    const unfilteredResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks(
        (unfilteredResult as Record<string, unknown>)["$UI"],
      ),
      SESSION_PAGE_SIZE,
    );
    const firstPageButton = renderedNodes(
      (unfilteredResult as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Previous"
    );
    const firstPage = materializeCell(firstPageButton?.props?.onClick);
    assertEquals(
      typeof (firstPage as { send?: unknown } | undefined)?.send,
      "function",
    );
    (firstPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();
    (firstPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const returnedResult = await piece.result.get();
    assertEquals(
      cellLinkIds(
        (returnedResult as Record<string, unknown>)["$UI"],
        "Raw data",
      ),
      firstPageLinkIds,
    );
    assertEquals(
      runtime.runner.cancels.size <= openedRawRunnerCount,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern resumes sessions published while it was stopped", async () => {
  const server = newSharedServer();
  const spaceName = `debug-resume-published-${crypto.randomUUID()}`;
  let debugPieceId = "";

  const deploySession = await createSession({ identity, spaceName });
  const deployStorage = SharedServerStorageManager.connectTo(server, {
    as: deploySession.as,
  });
  const deployRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: deployStorage,
  });
  try {
    const manager = new PiecesController(deploySession, deployRuntime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime: deployRuntime,
      spaceDid: deploySession.space,
      ownerDid: deploySession.as.did(),
    });
    debugPieceId = (await deployDebugPiece(manager, target)).id;
    await deployStorage.synced();
  } finally {
    await deployRuntime.dispose();
    await deployStorage.close();
  }

  const publishSession = await createSession({ identity, spaceName });
  const publishStorage = SharedServerStorageManager.connectTo(server, {
    as: publishSession.as,
  });
  const publishRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: publishStorage,
  });
  try {
    const target = await AgentFabricTarget.open({
      runtime: publishRuntime,
      spaceDid: publishSession.space,
      ownerDid: publishSession.as.did(),
    });
    const snapshots = Array.from({ length: SESSION_PAGE_SIZE }, (_, index) => {
      const snapshot = sessionSnapshot(index + 1);
      snapshot.summary.archived = null;
      snapshot.summary.active = null;
      return snapshot;
    });
    await target.publish([{
      source: sourceDescriptor(),
      sessions: snapshots,
      errors: [],
      complete: true,
    }]);
    await publishStorage.synced();
  } finally {
    await publishRuntime.dispose();
    await publishStorage.close();
  }

  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const manager = new PiecesController(readerSession, readerRuntime);
    await manager.synced();
    const piece = await manager.get(debugPieceId, false);
    await manager.startPiece(piece.getCell());
    const result = await piece.result.get() as Record<string, unknown>;

    assertEquals(await piece.result.get(["sessionCount"]), SESSION_PAGE_SIZE);
    assertEquals(countSessionRawDataLinks(result["$UI"]), SESSION_PAGE_SIZE);
    const publishedRows = publishedSessionTableRows(result["$UI"]);
    assertEquals(publishedRows.length, SESSION_PAGE_SIZE + 1);
    assertEquals(
      renderedTableCells(publishedRows[1]).slice(0, 4),
      ["codex:test", "Sharded session 1", "unknown", "complete"],
    );
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
  }
});

Deno.test("debug pattern loads connector child cells on a cold replica", async () => {
  const server = newSharedServer();
  const spaceName = `debug-cold-${crypto.randomUUID()}`;
  const sessionCount = SESSION_PAGE_SIZE + 1;
  let debugPieceId = "";
  let rawPieceId = "";
  let manifestDocumentId = "";
  let eventChunkDocumentId = "";
  let lastSessionRowDocumentId = "";
  let indexSourceRowDocumentId = "";
  try {
    const writerSession = await createSession({ identity, spaceName });
    const writerStorage = SharedServerStorageManager.connectTo(server, {
      as: writerSession.as,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    try {
      const manager = new PiecesController(writerSession, writerRuntime);
      await manager.synced();
      const target = await AgentFabricTarget.open({
        runtime: writerRuntime,
        spaceDid: writerSession.space,
        ownerDid: writerSession.as.did(),
      });
      debugPieceId = (await deployDebugPiece(manager, target)).id;
      const source = sourceDescriptor();
      await target.publish([{
        source,
        sessions: Array.from(
          { length: sessionCount },
          (_, index) => sessionSnapshot(index + 1),
        ),
        errors: [],
        complete: true,
      }]);
      const allIndexValue = target.cells.allIndex.getRaw();
      const allIndexSources = allIndexValue &&
          typeof allIndexValue === "object" &&
          !Array.isArray(allIndexValue) &&
          "sources" in allIndexValue &&
          Array.isArray(allIndexValue.sources)
        ? allIndexValue.sources
        : [];
      const allIndexSessions = allIndexValue &&
          typeof allIndexValue === "object" &&
          !Array.isArray(allIndexValue) &&
          "sessions" in allIndexValue &&
          Array.isArray(allIndexValue.sessions)
        ? allIndexValue.sessions
        : [];
      const indexSourceRow = allIndexSources[0];
      if (!isLinkRef(indexSourceRow)) {
        throw new Error("complete index source row link is missing");
      }
      const indexSourceRowId = linkRefPayload(indexSourceRow).id;
      if (typeof indexSourceRowId !== "string") {
        throw new Error("complete index source row ID is missing");
      }
      indexSourceRowDocumentId = indexSourceRowId;
      const lastSessionRow = allIndexSessions.at(-1);
      if (!isLinkRef(lastSessionRow)) {
        throw new Error("complete index session row link is missing");
      }
      const lastSessionRowId = linkRefPayload(lastSessionRow).id;
      if (typeof lastSessionRowId !== "string") {
        throw new Error("complete index session row ID is missing");
      }
      lastSessionRowDocumentId = lastSessionRowId;
      await target.publishHealth({
        service: "agents-host",
        status: "ready",
        startedAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
        target: { spaceDid: writerSession.space, cells: {} },
        commandProcessing: {
          accepting: true,
          pendingReceiptPublications: 0,
          failedCommands: 0,
        },
        sources: [{
          ...source,
          status: "ready",
          sessionCount,
          complete: true,
          errors: [],
        }],
        activity: [{
          id: "activity-1",
          at: "2026-07-20T00:01:00.000Z",
          type: "sync-completed",
          message: "Full collection completed",
          details: { capabilities: source.capabilities },
        }],
      });
      const firstSessionRow = allIndexSessions[0];
      if (!isLinkRef(firstSessionRow)) {
        throw new Error("first complete index session row link is missing");
      }
      const firstSessionCell = writerRuntime.getCellFromLink(
        linkRefPayload(firstSessionRow) as unknown as Parameters<
          Runtime["getCellFromLink"]
        >[0],
      );
      await firstSessionCell.sync();
      const firstSessionValue = firstSessionCell.getRaw();
      const manifestLink = firstSessionValue &&
          typeof firstSessionValue === "object" &&
          !Array.isArray(firstSessionValue) &&
          "manifest" in firstSessionValue
        ? firstSessionValue.manifest
        : undefined;
      if (!isLinkRef(manifestLink)) {
        throw new Error("first session manifest link is missing");
      }
      const manifest = writerRuntime.getCellFromLink(
        linkRefPayload(manifestLink) as unknown as Parameters<
          Runtime["getCellFromLink"]
        >[0],
      );
      await manifest.sync();
      manifestDocumentId = manifest.getAsNormalizedFullLink().id;
      const manifestValue = manifest.getRaw();
      const firstDescriptorLink = manifestValue &&
          typeof manifestValue === "object" &&
          !Array.isArray(manifestValue) &&
          "chunks" in manifestValue &&
          Array.isArray(manifestValue.chunks)
        ? manifestValue.chunks[0]
        : undefined;
      if (!isLinkRef(firstDescriptorLink)) {
        throw new Error("session manifest chunk descriptor link is missing");
      }
      const descriptorCell = writerRuntime.getCellFromLink(
        linkRefPayload(firstDescriptorLink) as unknown as Parameters<
          Runtime["getCellFromLink"]
        >[0],
      );
      await descriptorCell.sync();
      const descriptorValue = descriptorCell.getRaw();
      const eventChunkLink = descriptorValue &&
          typeof descriptorValue === "object" &&
          !Array.isArray(descriptorValue) &&
          "link" in descriptorValue
        ? descriptorValue.link
        : undefined;
      if (!isLinkRef(eventChunkLink)) {
        throw new Error("session chunk link is missing");
      }
      const eventChunkId = linkRefPayload(eventChunkLink).id;
      if (typeof eventChunkId !== "string") {
        throw new Error("session chunk ID is missing");
      }
      eventChunkDocumentId = eventChunkId;
      rawPieceId = (await deployRawDataPiece(manager, manifest)).id;
      await writerStorage.synced();
    } finally {
      await writerRuntime.dispose();
      await writerStorage.close();
    }

    const readerSession = await createSession({ identity, spaceName });
    const readerStorage = SharedServerStorageManager.connectTo(server, {
      as: readerSession.as,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const manager = new PiecesController(readerSession, readerRuntime);
      await manager.synced();
      const controller = manager;
      server.returnedEntityIds.length = 0;
      const piece = await controller.get(debugPieceId, true);

      assertEquals(piece.id, debugPieceId);
      assertEquals(piece.name(), "Agent sessions");
      assertEquals(await piece.result.get(["sourceCount"]), 1);
      assertEquals(
        await piece.result.get(["sessionCount"]),
        sessionCount,
      );
      assertEquals(await piece.result.get(["activityCount"]), 1);
      const debugResult = await piece.result.get();
      assertEquals(
        countSessionRawDataLinks(
          (debugResult as Record<string, unknown>)["$UI"],
        ),
        SESSION_PAGE_SIZE,
      );
      const publishedRows = publishedSessionTableRows(
        (debugResult as Record<string, unknown>)["$UI"],
      );
      assertEquals(publishedRows.length, SESSION_PAGE_SIZE + 1);
      assertEquals(
        renderedTableCells(publishedRows[1]).slice(0, 4),
        ["codex:test", "Sharded session 1", "active", "complete"],
      );
      assertEquals(
        server.returnedEntityIds.includes(manifestDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(eventChunkDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(lastSessionRowDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(indexSourceRowDocumentId),
        false,
      );
      assertEquals(
        renderedText(
          (debugResult as Record<string, unknown>)["$UI"],
        ).includes("Session indexes"),
        true,
      );
      const topLevelRawLinks = cellLinkCells(
        (debugResult as Record<string, unknown>)["$UI"],
        "Open raw data",
      );
      assertEquals(topLevelRawLinks.length, 5);
      const expectedTopLevelOrigins = [
        "AgentsHost.health()",
        "preceding seven days",
        "all non-deleted session-row links",
        "owner-confidential command queue",
        "latest 200 receipt-row links",
      ];
      for (const [index, link] of topLevelRawLinks.entries()) {
        if (index === 2) continue;
        const rawSource = await readRawDataProvenance(readerRuntime, link);
        assertEquals(rawSource.provenance.fabric.space, writerSession.space);
        assertEquals(
          rawSource.provenance.origin.includes(
            expectedTopLevelOrigins[index],
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "cf inspect value-at",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "inspect pull",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "inspect history",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes("--force"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes("--full-depth"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "--seq REVISION_SEQ",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes("CF_API_URL"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes("CF_IDENTITY"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes(
            "MEMORY_DUMP_ENABLED must be true",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes(
            "exact raw SQLite scope key",
          ),
          true,
        );
        assertEquals(
          rawSource.rendered.includes("Where this data comes from"),
          true,
        );
        assertEquals(
          rawSource.rendered.includes("Declared scope"),
          true,
        );
      }

      const completeIndexRawViewLink = topLevelRawLinks[2];
      if (!completeIndexRawViewLink) {
        throw new Error("complete index raw view is missing");
      }
      const completeIndexRawView = completeIndexRawViewLink.resolveAsCell();
      await readerRuntime.start(completeIndexRawView);
      await completeIndexRawView.pull();
      server.returnedEntityIds.length = 0;
      completeIndexRawView.key("load").send({});
      await readerRuntime.settled();
      await completeIndexRawView.pull();
      const completeIndexJson = JSON.parse(
        String(completeIndexRawView.key("rawJson").get()),
      );
      const completeIndexSource = await readRawDataProvenance(
        readerRuntime,
        completeIndexRawViewLink,
      );
      assertEquals(
        completeIndexSource.provenance.origin.includes(
          expectedTopLevelOrigins[2],
        ),
        true,
      );
      assertEquals(
        completeIndexSource.provenance.retrievalCommand.includes(
          "cf inspect value-at",
        ),
        true,
      );
      const firstRawSession = completeIndexJson.sessions[0];
      assertEquals(
        isLinkRef(firstRawSession),
        true,
      );
      assertEquals(
        typeof linkRefPayload(firstRawSession).id,
        "string",
      );
      assertEquals(
        server.returnedEntityIds.includes(manifestDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(eventChunkDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(lastSessionRowDocumentId),
        false,
      );

      server.returnedEntityIds.length = 0;
      const rawPiece = await controller.get(rawPieceId, true);
      const rawPieceValue = await rawPiece.result.get() as Record<
        string,
        unknown
      >;
      assertEquals(
        rawPieceValue.rawJson,
        "Loading raw conversation data…",
      );
      const sessionProvenance = rawPieceValue.provenance as RawDataProvenance;
      assertEquals(sessionProvenance.fabric.space, writerSession.space);
      assertEquals(
        sessionProvenance.origin.includes(
          'connector source "codex:test"',
        ),
        true,
      );
      assertEquals(
        sessionProvenance.providerRetrieval?.includes(
          "reads the producing driver from the session manifest",
        ),
        true,
      );
      assertEquals(
        sessionProvenance.retrievalCommand.includes(
          "every $link in the manifest",
        ),
        true,
      );
      assertEquals(
        sessionProvenance.retrievalCommand.includes(
          "Recursively follow every $link",
        ),
        true,
      );
      assertEquals(
        renderedText(rawPieceValue["$UI"]).includes(
          "Retrieve it from the provider",
        ),
        true,
      );
      assertEquals(
        server.returnedEntityIds.includes(manifestDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(eventChunkDocumentId),
        false,
      );
      const rawResult = await rawPiece.result.getCell();
      rawResult.key("load").send({});
      await readerRuntime.settled();
      const rawJson = await rawPiece.result.get(["rawJson"]);
      const raw = JSON.parse(String(rawJson));
      const loadedSessionProvenance = await rawPiece.result.get([
        "provenance",
      ]) as RawDataProvenance;
      assertEquals(
        loadedSessionProvenance.providerRetrieval?.includes(
          'producing driver "codex-app-server"',
        ),
        true,
      );
      assertEquals(
        loadedSessionProvenance.providerRetrieval?.includes('"thread/read"'),
        true,
      );
      assertEquals(raw.manifest.nativeSessionId, "session-1");
      assertEquals(raw.manifest.metadata.labels[0], "debug");
      assertEquals(raw.manifest.normalized.messages[0].textPreview, "hello");
      assertEquals(raw.eventChunks[0].events[0].content[0].text, "hello");
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  } finally {
    await server.close();
  }
});
