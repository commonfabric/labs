import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { spy, stub } from "@std/testing/mock";

import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentOwnerSchema,
} from "@commonfabric/agents-connector/fabric-graph";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";
import { createTransactionCommitReceipt } from "../../../../runtime/runner/src/storage/commit-receipt.ts";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
  protectOwnerDebugResult,
} from "../src/debug-view.ts";
import { identity, installDefaultPattern } from "./debug_view_support.ts";

const ALTERNATE_LOCATION = {
  rootPath: defaultDebugPatternLocation().rootPath,
  mainPath: fromFileUrl(
    new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
  ),
};

const REPLACEMENT_LOCATION = {
  rootPath: defaultDebugPatternLocation().rootPath,
  mainPath: fromFileUrl(
    new URL("./fixtures/replacement-debug-view.tsx", import.meta.url),
  ),
};

interface DeploymentFixture {
  session: Session;
  runtime: Runtime;
  manager: PiecesController;
  target: AgentFabricTarget;
}

/** Runs `body` against a fresh space with a target, then disposes both. */
async function withDeployment(
  body: (fixture: DeploymentFixture) => Promise<void>,
  options: { defaultPattern?: boolean } = {},
): Promise<void> {
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
    if (options.defaultPattern ?? true) await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    await body({ session, runtime, manager, target });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

interface Replacement extends DeploymentFixture {
  /** The piece of the view being replaced, which is running. */
  precedingId: string;
  controller: AbortController;
  reason: Error;
  isPreceding(piece: string | Cell<unknown>): boolean;
  /** Deploys the replacement view under `controller`. */
  replace(): Promise<string>;
  /** The owner's stored registration. */
  registration(): Cell<unknown>;
}

/**
 * Runs `body` with a view deployed from the alternate fixture, ready to be
 * replaced by one deployed from the replacement fixture.
 */
function withReplacement(
  body: (replacement: Replacement) => Promise<void>,
): Promise<void> {
  return withDeployment(async (fixture) => {
    const { session, runtime, manager, target } = fixture;
    const precedingId = await deployAgentSessionsDebugView(
      manager,
      target,
      ALTERNATE_LOCATION,
    );
    const controller = new AbortController();
    await body({
      ...fixture,
      precedingId,
      controller,
      reason: new Error("debug deployment cancelled"),
      isPreceding: (piece) =>
        typeof piece !== "string" && pieceId(piece) === precedingId,
      replace: () =>
        deployAgentSessionsDebugView(
          manager,
          target,
          REPLACEMENT_LOCATION,
          controller.signal,
        ),
      registration: () =>
        runtime.getCell(
          session.space,
          `agent-sessions-debug-registration:${session.as.did()}`,
        ),
    });
  });
}

/**
 * Aborts the replacement while it stops the view it supersedes, failing the
 * stops `stopFailure` names, and counts the stops of that view.
 */
function abortWhileStoppingPreceding(
  replacement: Replacement,
  stopFailure?: (stops: number) => Error | undefined,
): Disposable & { precedingStops(): number } {
  const { runtime, controller, reason, isPreceding } = replacement;
  const stopRunner = runtime.runner.stop.bind(runtime.runner);
  let stops = 0;
  const stopStub = stub(runtime.runner, "stop", (piece) => {
    stopRunner(piece);
    if (!isPreceding(piece)) return;
    stops++;
    if (stops === 1) controller.abort(reason);
    const failure = stopFailure?.(stops);
    if (failure !== undefined) throw failure;
  });
  return {
    [Symbol.dispose]: () => stopStub.restore(),
    precedingStops: () => stops,
  };
}

/** Resolves to the error `promise` rejects with. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => {
    throw new Error("the deployment unexpectedly succeeded");
  }, (error: unknown) => error);
}

describe("deployAgentSessionsDebugView()", () => {
  it("reports a space that cannot hold the default pattern it lacks", async () => {
    await withDeployment(async ({ session, manager, target }) => {
      using ensure = spy(manager, "ensureDefaultPattern");

      await expect(deployAgentSessionsDebugView(manager, target)).rejects
        .toThrow(`No space answers to ${session.space}`);
      expect(ensure.calls.length).toBe(1);
    }, { defaultPattern: false });
  });

  it("rejects a protected registration that is not a registration", async () => {
    await withDeployment(async ({ session, runtime, manager, target }) => {
      const ownerDid = session.as.did();
      const registration = runtime.getCell(
        session.space,
        `agent-sessions-debug-registration:${ownerDid}`,
      );
      for (
        const malformed of [
          "not a registration",
          {
            cause: "agent-sessions-debug:other",
            pieceId: 7,
            patternIdentity: "fid1:pattern",
            patternSymbol: "default",
            retiredCauses: [],
          },
        ]
      ) {
        const seeded = await runtime.editWithRetry((tx) => {
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: AGENT_CONNECTOR_WRITER_ID,
          });
          registration.withTx(tx).asSchema(agentOwnerSchema(ownerDid))
            .setRawUntyped(malformed);
        });
        if (seeded.error) throw seeded.error;

        await expect(
          deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
        ).rejects.toThrow("debug view registration is malformed");
        expect(registration.getRaw()).toEqual(malformed);
      }
    });
  });

  it("refuses a pattern the runtime gave no identity", async () => {
    await withDeployment(async ({ runtime, manager, target }) => {
      using _ref = stub(
        runtime.patternManager,
        "getArtifactEntryRef",
        () => undefined,
      );

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toThrow("debug view pattern has no identity");
    });
  });

  it("refuses a new piece it cannot find again after protecting it", async () => {
    await withDeployment(async ({ runtime, manager, target }) => {
      // Only the first lookup, which names the cause, finds the identity.
      const getArtifactEntryRef = runtime.patternManager.getArtifactEntryRef
        .bind(runtime.patternManager);
      let lookups = 0;
      using _ref = stub(
        runtime.patternManager,
        "getArtifactEntryRef",
        (value) => lookups++ === 0 ? getArtifactEntryRef(value) : undefined,
      );
      let created = 0;
      const setupPersistent = manager.setupPersistent.bind(manager);
      using _setup = stub(manager, "setupPersistent", (...args) => {
        created++;
        return setupPersistent(...args);
      });

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toThrow("new debug view disappeared after owner protection");
      expect(created).toBe(1);
    });
  });

  for (
    const [failing, message] of [
      ["stopping its runner", "runner stop rejected"],
      ["draining the runtime", "runtime drain rejected"],
    ] as const
  ) {
    it(`reports a failed start together with a cleanup that failed ${failing}`, async () => {
      await withDeployment(async ({ runtime, manager, target }) => {
        const startError = new Error("debug start rejected");
        const cleanupError = new Error(message);
        let startFailed = false;
        using _start = stub(manager, "startPiece", () => {
          startFailed = true;
          return Promise.reject(startError);
        });
        const stopRunner = runtime.runner.stop.bind(runtime.runner);
        using _stop = stub(runtime.runner, "stop", (piece) => {
          stopRunner(piece);
          if (startFailed && failing === "stopping its runner") {
            throw cleanupError;
          }
        });
        const idle = runtime.idle.bind(runtime);
        using _idle = stub(runtime, "idle", async () => {
          await idle();
          if (startFailed && failing === "draining the runtime") {
            throw cleanupError;
          }
        });

        const failure = await deployAgentSessionsDebugView(
          manager,
          target,
          ALTERNATE_LOCATION,
        ).then(() => undefined, (error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw failure;
        expect(failure.message).toBe("debug view startup and cleanup failed");
        const [started, cleanup] = failure.errors;
        expect(started).toBe(startError);
        expect(cleanup).toBeInstanceOf(AggregateError);
        expect(cleanup.message).toBe("debug view runner cleanup failed");
        expect(cleanup.errors).toEqual([cleanupError]);
      });
    });
  }

  it("stops a piece whose registration failed, and reports a failed stop", async () => {
    await withDeployment(async ({ runtime, manager, target }) => {
      const refused = new Error("public update refused");
      const stopError = new Error("runner stop rejected");
      let started = false;
      const startPiece = manager.startPiece.bind(manager);
      using _start = stub(manager, "startPiece", async (piece) => {
        await startPiece(piece);
        started = true;
      });
      const editWithRetry = runtime.editWithRetry.bind(runtime);
      using _edit = stub(
        runtime,
        "editWithRetry",
        (action, maxRetries) =>
          editWithRetry(
            started
              ? () => {
                throw refused;
              }
              : action,
            maxRetries,
          ),
      );
      const stopped: unknown[] = [];
      const stopRunner = runtime.runner.stop.bind(runtime.runner);
      using _stop = stub(runtime.runner, "stop", (piece) => {
        stopRunner(piece);
        if (!started) return;
        stopped.push(piece);
        throw stopError;
      });

      const failure = await deployAgentSessionsDebugView(
        manager,
        target,
        ALTERNATE_LOCATION,
      ).then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.message).toBe("debug view deployment and cleanup failed");
      const [registration, cleanup] = failure.errors;
      expect(registration.message).toBe(
        "Could not update public debug view registrations: " +
          "editWithRetry action threw: Error: public update refused",
      );
      expect(cleanup.errors).toEqual([stopError]);
      expect(stopped.length).toBe(1);
    });
  });

  it("keeps a piece running when its registration cannot be read back", async () => {
    await withDeployment(async ({ runtime, manager, target }) => {
      const unreadable = new Error("registration unreadable");
      let started = false;
      const startPiece = manager.startPiece.bind(manager);
      using _start = stub(manager, "startPiece", async (piece) => {
        await startPiece(piece);
        started = true;
      });
      const edit = runtime.edit.bind(runtime);
      using _edit = stub(runtime, "edit", (...args) => {
        if (started) throw unreadable;
        return edit(...args);
      });
      using stop = spy(runtime.runner, "stop");

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toBe(unreadable);
      expect(stop.calls.length).toBe(0);
    });
  });

  it("refuses a view whose arguments lack the owner's protection", async () => {
    await withDeployment(async ({ session, manager, target }) => {
      // The first deployment names the cause and arguments, then stops.
      const setupPersistent = manager.setupPersistent.bind(manager);
      let setup: Parameters<typeof setupPersistent> | undefined;
      const capture = stub(manager, "setupPersistent", (...args) => {
        setup = args;
        return Promise.reject(new Error("setup captured"));
      });
      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toThrow("setup captured");
      capture.restore();
      if (setup === undefined) throw new Error("setup was not reached");
      const squatted = await setupPersistent(...setup);
      await protectOwnerDebugResult(manager, squatted, session.as.did());

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toThrow(
        `refusing to adopt unprotected debug view arguments for ${session.as.did()}`,
      );
    });
  });

  it("refuses to protect a view that changed after it was read", async () => {
    await withDeployment(async ({ runtime, manager, target }) => {
      let created = false;
      const setupPersistent = manager.setupPersistent.bind(manager);
      using _setup = stub(manager, "setupPersistent", async (...args) => {
        const piece = await setupPersistent(...args);
        created = true;
        return piece;
      });
      let argumentId: string | undefined;
      const getArgument = manager.getArgument.bind(manager);
      using _argument = stub(manager, "getArgument", (piece) => {
        const argument = getArgument(piece);
        if (created) argumentId = argument.getAsNormalizedFullLink().id;
        return argument;
      });
      // Reads outside a transaction see other contents in the new arguments.
      const readTx = runtime.readTx.bind(runtime);
      const altered = new WeakSet<object>();
      using _read = stub(runtime, "readTx", (...args) => {
        const tx = readTx(...args);
        if (altered.has(tx)) return tx;
        altered.add(tx);
        const read = tx.readOrThrow.bind(tx);
        stub(
          tx,
          "readOrThrow",
          (address, options) =>
            address.id === argumentId && address.path.length === 0
              ? { stale: true }
              : read(address, options),
        );
        return tx;
      });
      using start = spy(manager, "startPiece");

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toThrow("debug view changed before owner protection");
      expect(start.calls.length).toBe(0);
    });
  });

  it("reports a refused commit of the new view's protection", async () => {
    await withDeployment(async ({ session, runtime, manager, target }) => {
      let createdId: string | undefined;
      const setupPersistent = manager.setupPersistent.bind(manager);
      using _setup = stub(manager, "setupPersistent", async (...args) => {
        const piece = await setupPersistent(...args);
        createdId = piece.getAsNormalizedFullLink().id;
        return piece;
      });
      // The first commit that writes the new view is refused.
      const refused = new Error("protection refused");
      const edit = runtime.edit.bind(runtime);
      let refusedCommits = 0;
      using _edit = stub(runtime, "edit", (...args) => {
        const tx = edit(...args);
        const commit = tx.commit.bind(tx);
        stub(tx, "commit", () => {
          const writesCreated = createdId !== undefined &&
            [...(tx.getWriteDetails?.(session.space) ?? [])].some((write) =>
              write.address.id === createdId
            );
          if (!writesCreated || refusedCommits++ > 0) return commit();
          tx.abort(refused);
          return createTransactionCommitReceipt(Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: "protection refused",
              reason: refused,
            },
          }));
        });
        return tx;
      });
      using start = spy(manager, "startPiece");

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toThrow(
        "could not protect the owner debug result: protection refused",
      );
      expect(refusedCommits).toBe(1);
      expect(start.calls.length).toBe(0);
    });
  });

  it("reports a view document it could not load", async () => {
    await withDeployment(async ({ runtime, manager, target, session }) => {
      const unavailable = new Error("replica unavailable");
      let bound = false;
      const bindCommandCell = target.bindCommandCell.bind(target);
      using _bind = stub(target, "bindCommandCell", async (...args) => {
        await bindCommandCell(...args);
        bound = true;
      });
      const provider = runtime.storageManager.open(session.space);
      const sync = provider.sync.bind(provider);
      using _sync = stub(
        provider,
        "sync",
        (...args) =>
          bound ? Promise.resolve({ error: unavailable }) : sync(...args),
      );

      await expect(
        deployAgentSessionsDebugView(manager, target, ALTERNATE_LOCATION),
      ).rejects.toBe(unavailable);
    });
  });

  for (const cancelled of [false, true]) {
    it(
      `reports a failed public-list cleanup after ${
        cancelled ? "cancellation" : "a refused registration"
      }`,
      async () => {
        await withDeployment(async ({ runtime, manager, target }) => {
          const controller = new AbortController();
          const reason = new Error("debug deployment cancelled");
          const privateRefused = new Error("private update refused");
          const cleanupRefused = new Error("list cleanup refused");
          let started = false;
          const startPiece = manager.startPiece.bind(manager);
          using _start = stub(manager, "startPiece", async (piece) => {
            await startPiece(piece);
            started = true;
          });
          const editWithRetry = runtime.editWithRetry.bind(runtime);
          let afterStart = 0;
          using _edit = stub(
            runtime,
            "editWithRetry",
            async (action, retries) => {
              if (!started) return await editWithRetry(action, retries);
              afterStart++;
              if (afterStart === 1) {
                const result = await editWithRetry(action, retries);
                if (cancelled) controller.abort(reason);
                return result;
              }
              const refusal = afterStart === 2 && !cancelled
                ? privateRefused
                : cleanupRefused;
              return await editWithRetry(() => {
                throw refusal;
              }, retries);
            },
          );

          const failure = await rejection(
            deployAgentSessionsDebugView(
              manager,
              target,
              ALTERNATE_LOCATION,
              controller.signal,
            ),
          );

          expect(failure).toBeInstanceOf(AggregateError);
          if (!(failure instanceof AggregateError)) throw failure;
          expect(failure.message).toBe(
            cancelled
              ? "debug view abort and public-list cleanup failed"
              : "debug view registration update and public-list cleanup failed",
          );
          const [first, cleanup] = failure.errors;
          if (cancelled) expect(first).toBe(reason);
          else expect(first.reason).toBe(privateRefused);
          expect(cleanup.reason).toBe(cleanupRefused);
        });
      },
    );
  }

  describe("when a replacement is cancelled after it stopped the view it supersedes", () => {
    it("restarts the superseded view and restores its registration", async () => {
      await withReplacement(async (replacement) => {
        const { manager, reason, isPreceding } = replacement;
        const original = replacement.registration().getRaw();
        using _stop = abortWhileStoppingPreceding(replacement);
        using start = spy(manager, "startPiece");

        expect(await rejection(replacement.replace())).toBe(reason);
        expect(replacement.registration().getRaw()).toEqual(original);
        expect(
          start.calls.filter((call) => isPreceding(call.args[0])).length,
        ).toBe(1);
      });
    });

    for (const stopFails of [false, true]) {
      it(
        `reports a superseded view that cannot restart${
          stopFails ? ", nor be stopped again" : ""
        }`,
        async () => {
          await withReplacement(async (replacement) => {
            const { manager, reason, isPreceding } = replacement;
            const startError = new Error("restart rejected");
            const stopError = new Error("second stop rejected");
            using _stop = abortWhileStoppingPreceding(
              replacement,
              (stops) => stopFails && stops === 2 ? stopError : undefined,
            );
            const startPiece = manager.startPiece.bind(manager);
            using _start = stub(
              manager,
              "startPiece",
              (piece) =>
                isPreceding(piece)
                  ? Promise.reject(startError)
                  : startPiece(piece),
            );

            const failure = await rejection(replacement.replace());

            expect(failure).toBeInstanceOf(AggregateError);
            if (!(failure instanceof AggregateError)) throw failure;
            if (stopFails) {
              expect(failure.message).toBe(
                "previous debug view restart and cleanup failed",
              );
              const [aborted, started, cleanup] = failure.errors;
              expect([aborted, started]).toEqual([reason, startError]);
              expect(cleanup.errors).toEqual([stopError]);
            } else {
              expect(failure.message).toBe(
                "previous debug view restart failed",
              );
              expect(failure.errors).toEqual([reason, startError]);
            }
          });
        },
      );
    }

    for (const stopFails of [false, true]) {
      it(
        `stops the restarted view when another registration replaced its own${
          stopFails ? ", and reports a failed stop" : ""
        }`,
        async () => {
          await withReplacement(async (replacement) => {
            const { session, runtime, manager, reason, isPreceding } =
              replacement;
            const ownerDid = session.as.did();
            const competing = {
              cause: "agent-sessions-debug:competing",
              pieceId: "fid1:competing-debug-piece",
              patternIdentity: "fid1:competing-debug-pattern",
              patternSymbol: "default",
              retiredCauses: [],
            };
            const stopError = new Error("second stop rejected");
            using _stop = abortWhileStoppingPreceding(
              replacement,
              (stops) => stopFails && stops === 2 ? stopError : undefined,
            );
            const registration = replacement.registration();
            const startPiece = manager.startPiece.bind(manager);
            using _start = stub(manager, "startPiece", async (piece) => {
              if (isPreceding(piece)) {
                const written = await runtime.editWithRetry((tx) => {
                  setCfcImplementationIdentity(tx, {
                    kind: "builtin",
                    builtinId: AGENT_CONNECTOR_WRITER_ID,
                  });
                  registration.withTx(tx).asSchema(agentOwnerSchema(ownerDid))
                    .setRawUntyped(competing);
                });
                if (written.error) throw written.error;
              }
              await startPiece(piece);
            });

            const failure = await rejection(replacement.replace());

            expect(registration.getRaw()).toEqual(competing);
            if (stopFails) {
              expect(failure).toBeInstanceOf(AggregateError);
              if (!(failure instanceof AggregateError)) throw failure;
              expect(failure.message).toBe("debug view abort cleanup failed");
              const [aborted, cleanup] = failure.errors;
              expect(aborted).toBe(reason);
              expect(cleanup.errors).toEqual([stopError]);
            } else {
              expect(failure).toBe(reason);
            }
          });
        },
      );
    }

    for (
      const outcome of [
        "stopped",
        "stop failed",
        "registration unreadable",
      ] as const
    ) {
      it(`reports a registration it could not restore (${outcome})`, async () => {
        await withReplacement(async (replacement) => {
          const { runtime, controller, reason } = replacement;
          const refused = new Error("rollback refused");
          const stopError = new Error("second stop rejected");
          using stops = abortWhileStoppingPreceding(
            replacement,
            (stops) =>
              outcome === "stop failed" && stops === 2 ? stopError : undefined,
          );
          const editWithRetry = runtime.editWithRetry.bind(runtime);
          let rollbackAttempted = false;
          let rollbackFailed = false;
          using _editWithRetry = stub(
            runtime,
            "editWithRetry",
            async (action, maxRetries) => {
              if (!controller.signal.aborted || rollbackAttempted) {
                return await editWithRetry(action, maxRetries);
              }
              rollbackAttempted = true;
              const result = await editWithRetry(() => {
                throw refused;
              }, maxRetries);
              rollbackFailed = true;
              return result;
            },
          );
          const edit = runtime.edit.bind(runtime);
          using _edit = stub(runtime, "edit", (...args) => {
            if (outcome === "registration unreadable" && rollbackFailed) {
              throw new Error("registration unreadable");
            }
            return edit(...args);
          });

          const failure = await rejection(replacement.replace());

          expect(failure).toBeInstanceOf(AggregateError);
          if (!(failure instanceof AggregateError)) throw failure;
          if (outcome === "stop failed") {
            expect(failure.message).toBe(
              "debug view rollback and cleanup failed",
            );
            expect(failure.errors[0]).toBe(reason);
            expect(failure.errors[2].errors).toEqual([stopError]);
          } else {
            expect(failure.message).toBe("debug view rollback failed");
            expect(failure.errors[0]).toBe(reason);
            expect(String(failure.errors[1].message)).toContain(
              "rollback refused",
            );
          }
          // The restarted view is stopped again only when the registration
          // is known not to name it.
          expect(stops.precedingStops()).toBe(
            outcome === "registration unreadable" ? 1 : 2,
          );
        });
      });
    }

    it("reports a public list it could not clean up", async () => {
      await withReplacement(async (replacement) => {
        const { runtime, controller, reason } = replacement;
        const refused = new Error("list cleanup refused");
        using _stop = abortWhileStoppingPreceding(replacement);
        const editWithRetry = runtime.editWithRetry.bind(runtime);
        let afterAbort = 0;
        using _editWithRetry = stub(
          runtime,
          "editWithRetry",
          (action, maxRetries) => {
            if (controller.signal.aborted && ++afterAbort === 2) {
              return editWithRetry(() => {
                throw refused;
              }, maxRetries);
            }
            return editWithRetry(action, maxRetries);
          },
        );

        const failure = await rejection(replacement.replace());

        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw failure;
        expect(failure.message).toBe("debug view public-list cleanup failed");
        expect(failure.errors[0]).toBe(reason);
        expect(String(failure.errors[1].message)).toContain(
          "list cleanup refused",
        );
      });
    });

    it("reports a failed stop together with a failed restart", async () => {
      await withReplacement(async (replacement) => {
        const { manager, reason, isPreceding } = replacement;
        const firstStopError = new Error("first stop rejected");
        const startError = new Error("restart rejected");
        using _stop = abortWhileStoppingPreceding(
          replacement,
          (stops) => stops === 1 ? firstStopError : undefined,
        );
        const startPiece = manager.startPiece.bind(manager);
        using _start = stub(
          manager,
          "startPiece",
          (piece) =>
            isPreceding(piece) ? Promise.reject(startError) : startPiece(piece),
        );

        const failure = await rejection(replacement.replace());

        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw failure;
        expect(failure.message).toBe("debug view cleanup and rollback failed");
        const [cleanup, rollback] = failure.errors;
        expect(cleanup.errors).toEqual([firstStopError]);
        expect(rollback.message).toBe("previous debug view restart failed");
        expect(rollback.errors).toEqual([reason, startError]);
      });
    });
  });

  it("keeps a registered replacement whose superseded view would not stop", async () => {
    await withReplacement(async (replacement) => {
      const { runtime, isPreceding } = replacement;
      const stopError = new Error("superseded stop rejected");
      const stopRunner = runtime.runner.stop.bind(runtime.runner);
      using _stop = stub(runtime.runner, "stop", (piece) => {
        stopRunner(piece);
        if (isPreceding(piece)) throw stopError;
      });

      const failure = await rejection(replacement.replace());

      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.message).toBe("debug view runner cleanup failed");
      expect(failure.errors).toEqual([stopError]);
      const registered = replacement.registration().getRaw();
      expect(registered).toMatchObject({
        retiredCauses: [expect.stringContaining("agent-sessions-debug:")],
      });
      expect(registered).not.toMatchObject({
        pieceId: replacement.precedingId,
      });
    });
  });
});
