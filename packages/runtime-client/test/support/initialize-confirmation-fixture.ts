/**
 * Runs the unchanged Shared Tape Lab wrapper and holds real native commits in
 * its state space and an unrelated producer's space. Confirmation gates make
 * initialization ordering observable without timing assertions.
 */

import { fromFileUrl } from "@std/path";
import { stub } from "@std/testing/mock";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type IExtendedStorageTransaction,
  Runtime,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { createCellRef } from "@/backends/utils.ts";
import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "../backends/build-processor.ts";

/** Installs the real wrapper, then holds a state edit beside a foreign producer. */
export async function createInitializeConfirmationFixture(options: {
  stored?: boolean;
  rejectEdit?: boolean;
  holdCoverage?: boolean;
} = {}) {
  const identity = await Identity.fromPassphrase("initialize-confirmation-A");
  const other = await Identity.fromPassphrase("initialize-confirmation-B");
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const storage = EmulatedStorageManager.connectTo(server, { as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverExecution: false },
  });
  const releaseA = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  const enteredA = Promise.withResolvers<void>();
  const enteredB = Promise.withResolvers<void>();
  let cancel: (() => void) | undefined;
  let restoreNetwork: (() => void) | undefined;
  let committing:
    | ReturnType<IExtendedStorageTransaction["commit"]>["settled"]
    | undefined;
  const close = async () => {
    releaseA.resolve();
    releaseB.resolve();
    await committing;
    cancel?.();
    await runtime.dispose();
    await storage.close();
    restoreNetwork?.();
    await server.close();
  };
  try {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(
          new URL(
            "../../../patterns/iframe-shared-tape-lab/main.tsx",
            import.meta.url,
          ),
        ),
        root: fromFileUrl(new URL("../../../patterns/", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: identity.did(),
    });
    const piece = runtime.getCell(
      identity.did(),
      "confirmation-piece",
      pattern.resultSchema,
    );
    const input = runtime.getCell<number>(other.did(), "confirmation-input");
    const output = runtime.getCell<number>(other.did(), "confirmation-output");
    await Promise.all([piece.sync(), input.sync(), output.sync()]);
    await runtime.editWithRetry((tx) => input.withTx(tx).set(7));
    const setup = runtime.edit();
    runtime.run(setup, pattern, {}, piece);
    runtime.prepareTxForCommit(setup);
    if ((await setup.commit().settled).error) {
      throw new Error("Wrapper setup failed");
    }
    await piece.pull();
    await runtime.scheduler.idleWithPendingCommits();
    const ui = piece.key("$UI").get() as {
      children: { props: { $context: Cell<unknown> } }[];
    };
    const processor = buildProcessor({
      runtime,
      identity,
      space: identity.did(),
    });
    const fields = await processor.handleCellFields({
      type: RequestType.CellFields,
      cell: createCellRef(ui.children[0].props.$context),
    });
    if (!fields.fields?.state) {
      throw new Error("Wrapper state reference missing");
    }
    const target = runtime.getCellFromLink(fields.fields.state);
    const initial = target.get() as {
      annotations: Record<string, FabricValue>[];
      assessments: FabricValue[];
    };
    const changed = {
      ...initial,
      annotations: initial.annotations.map((annotation, index) =>
        index === 0
          ? { ...annotation, note: "confirmed reattachment edit" }
          : annotation
      ),
    };
    const backing = target.resolveAsCell();
    if (options.stored === false) {
      await runtime.editWithRetry((tx) =>
        backing.withTx(tx).setRawUntyped(undefined)
      );
      await runtime.scheduler.idleWithPendingCommits();
    }
    const transact = server.transact.bind(server);
    let armA = false;
    let heldA = false;
    let heldB = false;
    const network = stub(server, "transact", async (message, publish) => {
      if (
        message.commit.operations.some((op) =>
          "id" in op && op.id === output.getAsNormalizedFullLink().id
        )
      ) {
        if (!heldB) {
          heldB = true;
          enteredB.resolve();
          await releaseB.promise;
        }
      } else if (armA && !heldA) {
        heldA = true;
        enteredA.resolve();
        await releaseA.promise;
        if (options.rejectEdit) {
          const response = {
            type: "response" as const,
            requestId: message.requestId,
            error: {
              name: "ConflictError",
              message: "withdraw optimistic state edit",
            },
          };
          publish?.(response);
          return response;
        }
      }
      return transact(message, publish);
    });
    restoreNetwork = () => network.restore();
    const action = (tx: IExtendedStorageTransaction) => {
      output.withTx(tx).set(input.withTx(tx).get());
    };
    cancel = runtime.scheduler.subscribe(action, {
      reads: [{ ...input.getAsNormalizedFullLink(), path: [] }],
      shallowReads: [],
      writes: [{ ...output.getAsNormalizedFullLink(), path: [] }],
    }, { isEffect: true, noDebounce: true });
    await enteredB.promise;
    armA = true;
    const update = runtime.edit();
    backing.withTx(update).set(changed);
    runtime.prepareTxForCommit(update);
    committing =
      update.commit({ holdSyncedUntilCovered: options.holdCoverage }).settled;
    await enteredA.promise;
    return {
      runtime,
      storage,
      identity,
      processor,
      target,
      initial,
      changed,
      request: {
        type: RequestType.CellInitialize,
        cell: createCellRef(target),
        value: initial,
      } as const,
      releaseA,
      releaseB,
      committing,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
