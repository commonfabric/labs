/** Covers public registry invariants enforced by debug-view deployment. */

import { assertRejects } from "@std/assert";

import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { deployAgentSessionsDebugView } from "../src/debug-view.ts";
import { identity, installDefaultPattern } from "./debug_view_support.ts";

Deno.test("debug deployment requires the public piece registry", async () => {
  const session = createSession({
    identity,
    spaceDid: (await Identity.generate()).did(),
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const removed = await runtime.editWithRetry((tx) => {
      defaultPattern.withTx(tx).asSchema(undefined).key("pieceRegistry")
        .setRawUntyped(undefined);
    });
    if (removed.error) throw removed.error;

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "default pattern does not expose pieceRegistry",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment reports a malformed piece registry", async () => {
  const session = createSession({
    identity,
    spaceDid: (await Identity.generate()).did(),
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const pieceRegistry = defaultPattern.asSchema(undefined)
      .key("pieceRegistry")
      .resolveAsCell();
    const malformedResult = await runtime.editWithRetry((tx) => {
      pieceRegistry.withTx(tx).setRawUntyped({ malformed: true });
    });
    if (malformedResult.error) throw malformedResult.error;
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "pieceRegistry is not an array",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects a replaced default pattern", async () => {
  const session = createSession({
    identity,
    spaceDid: (await Identity.generate()).did(),
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const replacementRoot = runtime.getCell(
      session.space,
      `replacement-default-pattern-${crypto.randomUUID()}`,
    );
    const replacementResult = await runtime.editWithRetry((tx) => {
      replacementRoot.withTx(tx).setRawUntyped({ replacement: true });
    });
    if (replacementResult.error) throw replacementResult.error;

    const originalGetDefaultPattern = manager.getDefaultPattern;
    let replaced = false;
    manager.getDefaultPattern = (async (runIt = true) => {
      const found = await originalGetDefaultPattern.call(manager, runIt);
      if (!replaced) {
        replaced = true;
        await manager.linkDefaultPattern(replacementRoot);
      }
      return found;
    }) as typeof manager.getDefaultPattern;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern changed during debug view deployment",
      );
    } finally {
      manager.getDefaultPattern = originalGetDefaultPattern;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects an in-place registry change", async () => {
  const session = createSession({
    identity,
    spaceDid: (await Identity.generate()).did(),
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalStartPiece = manager.startPiece;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let injectRegistryChange = false;
    let registryChangeInjected = false;
    manager.startPiece =
      (async (piece: Parameters<typeof originalStartPiece>[0]) => {
        await originalStartPiece.call(manager, piece);
        injectRegistryChange = true;
      }) as typeof manager.startPiece;
    runtime.editWithRetry = (async (action, maxRetries) => {
      if (injectRegistryChange && !registryChangeInjected) {
        registryChangeInjected = true;
        const change = await originalEditWithRetry((tx) => {
          defaultPattern.withTx(tx).key("pieceRegistry").setRawUntyped([]);
        });
        if (change.error) throw change.error;
      }
      return await originalEditWithRetry(action, maxRetries);
    }) as typeof runtime.editWithRetry;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern registry changed during debug view deployment",
      );
    } finally {
      manager.startPiece = originalStartPiece;
      runtime.editWithRetry = originalEditWithRetry;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
