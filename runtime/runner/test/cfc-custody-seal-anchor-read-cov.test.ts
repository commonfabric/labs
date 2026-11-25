import { expect } from "@std/expect";

import { commitCustodySeal } from "../src/cfc/custody-seal.ts";
import type { Runtime } from "../src/runtime.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type {
  IMemorySpaceAddress,
  IReadOptions,
} from "../src/storage/interface.ts";
import { internalVerifierRead } from "../src/storage/reactivity-log.ts";
import {
  alice,
  honestStance,
  P,
  prepareCustodySeal,
  S,
  setup,
  trustedClick,
} from "./support/custody-seal-fixture.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * Has each transaction `runtime` opens once `anchor` exists fail every read
 * of the anchor's document that is not a verifier read with `failure`. The
 * transaction that creates the anchor opens before it exists, and is left to
 * succeed.
 */
const failLabeledReadsOfAnchor = (
  runtime: Runtime,
  anchor: NormalizedFullLink,
  failure: Error,
) => {
  const edit = runtime.edit.bind(runtime);
  runtime.edit = (...args) => {
    const probe = edit();
    const exists = probe.readValueOrThrow(anchor) !== undefined;
    probe.abort();
    const tx = edit(...args);
    if (!exists) return tx;
    const { read, readOrThrow } = tx;
    const failsRead = (
      address: IMemorySpaceAddress,
      options: IReadOptions | undefined,
    ) =>
      options?.meta !== internalVerifierRead &&
      address.space === anchor.space && address.id === anchor.id;
    tx.read = (address, options) => {
      if (failsRead(address, options)) throw failure;
      return read.call(tx, address, options);
    };
    tx.readOrThrow = (address, options) => {
      if (failsRead(address, options)) throw failure;
      return readOrThrow.call(tx, address, options);
    };
    return tx;
  };
};

describe("commitCustodySeal()", () => {
  it("rejects with the failure of the entry's labeled read of the anchor when it is not a read-ceiling refusal", async () => {
    const fixture = await setup();
    try {
      const runtime = fixture.runtimes.get(alice)!;
      const draft = await fixture.draft(alice, honestStance);
      const prepared = await prepareCustodySeal(draft, fixture.room(alice, P));
      const anchor = runtime.getCell(S, {
        custodyAnchor: { policy: prepared.policy, instance: prepared.instance },
      }).getAsNormalizedFullLink();
      const failure = new Error("the anchor cannot be read");
      failLabeledReadsOfAnchor(runtime, anchor, failure);

      const error = await commitCustodySeal(prepared.consent, trustedClick())
        .catch((error: unknown) => error);

      expect(error).toBe(failure);
    } finally {
      await fixture.dispose();
    }
  });
});
