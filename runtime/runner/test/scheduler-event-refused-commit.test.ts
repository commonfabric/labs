import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EventCommitRefusedError } from "../src/scheduler/backpressure.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler event refused commit");
const space = signer.did();

type Refusal = { name: string; message: string; precondition?: string };

// Refuses the next commit reaching `server` with `refusal`, and lets every
// later one through.
function refuseNextTransact(
  server: MemoryV2Server.Server,
  refusal: Refusal,
): void {
  type Response = { type: "response"; requestId: string; error: Refusal };
  const transacting = server as unknown as {
    transact(
      message: { requestId: string },
      publish?: (response: Response) => void,
    ): Promise<Response>;
  };
  const original = transacting.transact.bind(transacting);
  let armed = true;
  transacting.transact = (message, publish) => {
    if (!armed) return original(message, publish);
    armed = false;
    const response: Response = {
      type: "response",
      requestId: message.requestId,
      error: refusal,
    };
    publish?.(response);
    return Promise.resolve(response);
  };
}

describe("scheduler-event-refused-commit", () => {
  let server: MemoryV2Server.Server;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let errors: Error[];
  let offers: Cell<string[]>;
  let stream: Cell<number>;
  let handlerRuns: number;

  async function open(): Promise<void> {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    runtime.scheduler.onError((error) => errors.push(error));
    const tx = runtime.edit();
    offers = runtime.getCell<string[]>(space, "offers", undefined, tx);
    offers.set([]);
    stream = runtime.getCell<number>(space, "receive", undefined, tx);
    stream.set(0);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    // Appends each event to `offers`, as an inbox's `receive` does.
    runtime.scheduler.addEventHandler((handlerTx, event) => {
      handlerRuns++;
      const current = offers.withTx(handlerTx).get() ?? [];
      offers.withTx(handlerTx).set([...current, String(event)]);
    }, stream.getAsNormalizedFullLink());
  }

  // Queues `event` on the stream and resolves with the status of the
  // transaction it settles on.
  function send(event: string): Promise<string> {
    const settled = Promise.withResolvers<string>();
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      event,
      undefined,
      (tx: IExtendedStorageTransaction) => settled.resolve(tx.status().status),
    );
    return settled.promise;
  }

  beforeEach(() => {
    server = newSharedServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    errors = [];
    handlerRuns = 0;
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storage.close();
    await server.close();
  });

  it("reports an `EventCommitRefusedError` for a non-retryable refusal", async () => {
    await open();
    refuseNextTransact(server, {
      name: "AuthorizationError",
      message: "not authorized",
    });

    expect(await send("offer")).toBe("error");
    await runtime.idle();

    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventCommitRefusedError);
    const refused = errors[0] as EventCommitRefusedError;
    expect(refused.rejection).toBe("non-retryable");
    expect((refused.cause as { name?: string }).name).toBe(
      "AuthorizationError",
    );
  });

  it("reports an `EventCommitRefusedError` for a permanent refusal", async () => {
    // The event has no origin that runs again to send it a second time.
    await open();
    refuseNextTransact(server, {
      name: "PreconditionFailedError",
      message: "origin not committed",
      precondition: "origin-committed",
    });

    expect(await send("offer")).toBe("error");
    await runtime.idle();

    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventCommitRefusedError);
    expect((errors[0] as EventCommitRefusedError).rejection).toBe(
      "permanent",
    );
  });

  it("reports nothing for a lost receipt race", async () => {
    // The same invocation already committed, so nothing was lost.
    await open();
    refuseNextTransact(server, {
      name: "PreconditionFailedError",
      message: "receipt exists",
      precondition: "receipt-exists",
    });

    await send("offer");
    await runtime.idle();

    expect(errors).toEqual([]);
  });

  it("reports nothing for a handler that aborts its own transaction", async () => {
    // The abort is the handler's own decision not to write.
    await open();
    const tx = runtime.edit();
    const aborting = runtime.getCell<number>(space, "aborting", undefined, tx);
    aborting.set(0);
    await tx.commit().settled;
    runtime.scheduler.addEventHandler((handlerTx) => {
      offers.withTx(handlerTx).set(["never"]);
      handlerTx.abort("the handler declines");
    }, aborting.getAsNormalizedFullLink());
    const settled = Promise.withResolvers<string>();
    runtime.scheduler.queueEvent(
      aborting.getAsNormalizedFullLink(),
      "offer",
      undefined,
      (tx: IExtendedStorageTransaction) => settled.resolve(tx.status().status),
    );

    expect(await settled.promise).toBe("error");
    await runtime.idle();

    expect(errors).toEqual([]);
  });

  it("reports nothing for a refusal re-running resolves", async () => {
    await open();
    refuseNextTransact(server, {
      name: "ConflictError",
      message: "stale confirmed read: of:offers at seq 1 conflicted with seq 2",
    });

    expect(await send("offer")).toBe("done");
    await runtime.idle();

    // The refused run, and the re-run whose commit lands.
    expect(handlerRuns).toBe(2);
    expect(errors).toEqual([]);
    expect(offers.get()).toEqual(["offer"]);
  });
});
