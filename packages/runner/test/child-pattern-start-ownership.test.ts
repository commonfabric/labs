import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

// A computation that returns a pattern launches a child piece under an address
// derived from the computation's own result cell. Every later run of that
// computation reaches the same address and hands the running child a new
// pattern identity rather than installing a registration of its own, so one
// registration is shared by every run. Stopping that registration is what
// recovers the child when a run's setup does not become durable: the next run
// finds nothing registered and materializes the child again. A compensation
// narrowed to the run that installed the registration would recover nothing
// here, because the runs that follow install none.

const signer = await Identity.fromPassphrase("child pattern start ownership");
const space = signer.did();

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string };
};
type PublishTransactVerdict = (response: TransactResponse) => void;
type TestMemoryServer = {
  transact(
    message: TransactMessage,
    publishVerdict?: PublishTransactVerdict,
  ): Promise<TransactResponse>;
};

// Hold the first commit whose payload mentions a marker, and decide its outcome
// later. Every other commit passes through, so the runs that follow the held one
// settle while it waits.
function holdCommitCarrying(
  storageManager: ReturnType<typeof StorageManager.emulate>,
  marker: string,
): {
  held: Promise<void>;
  reject(): void;
  restore(): void;
} {
  const server = (storageManager as unknown as { server(): TestMemoryServer })
    .server();
  const original = server.transact.bind(server);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holding = false;

  server.transact = (message, publishVerdict) => {
    if (!holding && JSON.stringify(message).includes(marker)) {
      holding = true;
      held.resolve();
      return release.promise.then(() => {
        const response: TransactResponse = {
          type: "response",
          requestId: message.requestId,
          error: {
            name: "ConflictError",
            message: "forced child ownership test conflict",
          },
        };
        publishVerdict?.(response);
        return response;
      });
    }
    return original(message, publishVerdict);
  };

  return {
    held: held.promise,
    reject: () => release.resolve(),
    restore: () => {
      server.transact = original;
    },
  };
}

describe("a computation-produced child", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it.ignore("converges after a superseded setup commit is rejected", async () => {
    // FLAGGED OPEN SEMANTIC (L3(a) keyless close-out, 2026-08-27; register
    // OW45 carries the ruling context): this scenario's convergence mechanism
    // WAS the durable keyless pointer churn the owner ruled out. Pre-guard,
    // every re-derivation of the child durably re-stamped a fresh per-source
    // `keyless:` patternIdentity in its own setup transaction; the held/
    // rejected commit was that stamp write, the cascade stayed narrow, and the
    // running child's meta watcher converged the graph to whichever stamp
    // stood. Post-guard the handing run's durable footprint is its
    // piece-instantiate transaction (child argument + computation result), so
    // the injected rejection cascades through every subsequent run's commits
    // ("pending dependency not resolved"): durable AND local state roll back
    // to the pre-bump child coherently, the commit-error callbacks release the
    // child and clear the materialization memo — and then the world is
    // quiescent: the producing lift's inputs are unchanged, so nothing
    // re-derives the child. Recovery here needs a re-run trigger for a
    // computation whose consequence commit was rejected (the client-side
    // cousin of the register's §3d mark-vs-effects question), and inventing
    // one is an owner decision, not a build decision — flagged, not filled.
    // The registration-ownership half this file exists for (shared
    // registration, stop-based recovery) is still exercised by the runner
    // battery's live paths; this end-to-end convergence pin waits on the
    // ruling.

    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const childPattern = pattern<{ source: number }>(({ source }) => ({
      doubled: lift((value: number) => value * 2)(source),
    }));
    const produceChild = lift((source: number) => childPattern({ source }));
    const rootPattern = pattern(() => {
      const source = cell(1);
      return { source, child: produceChild(source) };
    });

    const setupTx = runtime.edit();
    const rootCell = runtime.getCell<{ source: number; child: unknown }>(
      space,
      "child ownership root",
      undefined,
      setupTx,
    );
    const root = runtime.run(setupTx, rootPattern, {}, rootCell);
    await setupTx.commit().settled;
    await runtime.idle();
    const stopReading = root.key("child").sink(() => {});

    try {
      await runtime.idle();
      const registrationsWithChild = runtime.runner.cancels.size;
      expect(registrationsWithChild).toBeGreaterThan(1);

      // The run that hands the child the pattern for source 2 has its commit
      // held. The run for source 3 supersedes it and commits normally.
      const supersededRun = holdCommitCarrying(
        storageManager,
        "/patternIdentity",
      );
      try {
        const bumpTx = runtime.edit();
        root.key("source").withTx(bumpTx).set(2);
        await bumpTx.commit().settled;
        await supersededRun.held;

        // The third write only has to reach the local replica for the
        // computation to re-run. Its commit queues behind the held one, so
        // awaiting it here would deadlock.
        const thirdTx = runtime.edit();
        root.key("source").withTx(thirdTx).set(3);
        const thirdCommit = thirdTx.commit().settled;
        await runtime.idle();

        supersededRun.reject();
        expect((await thirdCommit).error).toBeUndefined();
        await runtime.idle();
      } finally {
        supersededRun.restore();
      }

      await runtime.idle();
      await root.pull();

      expect(runtime.runner.cancels.size).toBe(registrationsWithChild);
      expect(root.key("child").key("doubled").get()).toBe(6);
    } finally {
      stopReading();
    }
  });
});
