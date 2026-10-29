import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { UnreportedAuthoredBoundaryError } from "../src/storage/interface.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("v2 server authored seq");
const space = signer.did();

/**
 * A memory server that answers a graph query with its head and nothing more,
 * as one built before it reported authored commit boundaries does, whether or
 * not it advertises server execution.
 */
class HeadOnlyTransport extends ScriptedSessionTransport {
  readonly #serving: boolean;

  constructor(serving: boolean) {
    super({ name: "head-only", sessionId: "session:head-only", space });
    this.#serving = serving;
  }

  protected override helloFlags() {
    return { ...super.helloFlags(), serverExecution: this.#serving };
  }

  protected handle(message: ScriptedTransportMessage): void {
    if (message.type !== "graph.query") {
      throw new Error(`unexpected ${message.type}`);
    }
    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: { serverSeq: 7, entities: [] },
    });
  }
}

function managerOver(transport: HeadOnlyTransport): TestStorageManager {
  return TestStorageManager.create(
    { as: signer, memoryHost: new URL("memory://head-only") },
    new SingleSessionFactory(transport),
  );
}

describe("serverAuthoredSeq()", () => {
  it("rejects with an unreported-boundary error when the server serves without reporting authored boundaries", async () => {
    const manager = managerOver(new HeadOnlyTransport(true));
    try {
      await expect(manager.open(space).serverAuthoredSeq!(7)).rejects
        .toBeInstanceOf(UnreportedAuthoredBoundaryError);
    } finally {
      await manager.close();
    }
  });

  it("returns nothing when the server does not serve", async () => {
    const manager = managerOver(new HeadOnlyTransport(false));
    try {
      expect(await manager.open(space).serverAuthoredSeq!(7)).toBeUndefined();
    } finally {
      await manager.close();
    }
  });
});
