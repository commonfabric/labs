/// <cts-enable />
/**
 * One piece shared by two users, each in a runtime of their own. Each writes
 * their own per-user secret and must read only their own through every
 * computed result, though none of the results declares a scope: Bob, before
 * writing, sees nothing of Alice's, and Alice, after Bob writes, still sees
 * her own.
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import InferredResultScope, {
  type InferredResultScopeOutput,
} from "./main.tsx";

interface Setup {
  probe: InferredResultScopeOutput;
}

export const setup = pattern(() => ({ probe: InferredResultScope({}) }));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const set_secret = action(() => {
    setup.probe.setSecret.send({ value: "alice-secret" });
    setup.probe.setNote.send({ value: "alice-note" });
  });
  const sees_own = assert(() =>
    setup.probe.passThrough === "alice-secret" &&
    setup.probe.shout === "ALICE-SECRET" &&
    setup.probe.tagged?.who === "alice-secret" &&
    setup.probe.coalesced === "alice-secret" &&
    setup.probe.holder?.note?.get() === "alice-note"
  );
  return {
    [TESTS]: [
      { action: set_secret },
      { assertion: sees_own },
      { label: "alice-set" },
      { await: "bob-set" },
      { assertion: sees_own },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const sees_nothing_of_alice = assert(() =>
    setup.probe.passThrough !== "alice-secret" &&
    setup.probe.shout !== "ALICE-SECRET" &&
    setup.probe.tagged?.who !== "alice-secret" &&
    setup.probe.coalesced !== "alice-secret" &&
    setup.probe.holder?.note?.get() !== "alice-note"
  );
  const set_secret = action(() => {
    setup.probe.setSecret.send({ value: "bob-secret" });
    setup.probe.setNote.send({ value: "bob-note" });
  });
  const sees_own = assert(() =>
    setup.probe.passThrough === "bob-secret" &&
    setup.probe.shout === "BOB-SECRET" &&
    setup.probe.tagged?.who === "bob-secret" &&
    setup.probe.coalesced === "bob-secret" &&
    setup.probe.holder?.note?.get() === "bob-note"
  );
  return {
    [TESTS]: [
      { await: "alice-set" },
      { assertion: sees_nothing_of_alice },
      { action: set_secret },
      { assertion: sees_own },
      { label: "bob-set" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
