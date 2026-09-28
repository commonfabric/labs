import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// `cfc-transformed-by-input-witness.test.ts` drives the input witnesses with
// raw transactions: a whole value written at a document root, read back with
// one recursive read. Compiled pattern code reaches the same mint another way.
// A handler's `set` goes through the diff, which writes only what changed
// beneath containers another transaction may have created, and a lift reads
// its argument through the schema traversal, one shallow read per node,
// scalar leaves included. These cases run the chain the design note names —
// the endorsed commit step, then the endorsed tally, then a publish into a
// room that admits only public values — as compiled patterns, and hold the
// honest chain to releasing while the shapes that launder still refuse. The
// rule pins two levels, the commit step and the submit step beneath it, so a
// brief other code adds is refused as well.

const signer = await Identity.fromPassphrase(
  "runner-cfc-input-witness-compiled",
);
const space = signer.did();

const CHAIN_PATH = new URL(
  "../../patterns/cfc-exchange-rules/witnessed-chain.tsx",
  import.meta.url,
);
const CHAIN_SOURCE = await Deno.readTextFile(CHAIN_PATH);
const DEFAULTED_COMMITTED =
  "committed: Writable<Default<Sealed<Committed>, { votes: [] }>>;";

// The room stores sit beside the chain rather than inside it, as in the
// pattern's own test: each admits only public values, so a publish into one
// is where the release rule gets its chance.
const MAIN = `/// <cts-enable />
import { Default, handler, pattern, Writable } from "commonfabric";
import WitnessedChain, { type RoomText } from "./witnessed-chain.tsx";

const publish = handler<void, { from: string; to: Writable<RoomText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

interface Rooms {
  roomTally: Writable<Default<RoomText, "">>;
  roomRelay: Writable<Default<RoomText, "">>;
  roomAppended: Writable<Default<RoomText, "">>;
  roomForged: Writable<Default<RoomText, "">>;
  roomPlanted: Writable<Default<RoomText, "">>;
}

export default pattern<Rooms>(
  ({ roomTally, roomRelay, roomAppended, roomForged, roomPlanted }) => {
    const ballot = WitnessedChain({} as any);
    return {
      tally: ballot.tally,
      roomTally,
      roomRelay,
      roomAppended,
      roomForged,
      roomPlanted,
      submit: ballot.submit,
      commit: ballot.commit,
      forge: ballot.forge,
      append: ballot.append,
      plant: ballot.plant,
      publishTally: publish({ from: ballot.tally, to: roomTally }),
      publishRelay: publish({ from: ballot.relayTally, to: roomRelay }),
      publishAppended: publish({ from: ballot.tally, to: roomAppended }),
      publishForged: publish({ from: ballot.tally, to: roomForged }),
      publishPlanted: publish({ from: ballot.tally, to: roomPlanted }),
    };
  },
);
`;

const program = (chainSource: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    {
      name: "/witnessed-chain.tsx",
      contents: `/// <cts-enable />\n${chainSource}`,
    },
  ],
});

// The committed input as the fixture declares it, with a default: the
// runtime's setup writes that default, so the commit step writes into a
// container another transaction created.
const DEFAULTED = program(CHAIN_SOURCE);

// The rule guarded on the tally's identity alone. Every refused case below
// releases under it, which is what shows that the witness, not some other
// gate, is what refuses them.
const SUBMIT_GUARD = `
        inputWitness: {
          type: "https://commonfabric.org/cfc/atom/TransformedBy",
          identity: {
            kind: "verified",
            moduleIdentity: THIS_POLICY.moduleIdentity,
            symbol: "submit",
          },
        },`;
const WITNESS_GUARD = `
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "commit",
        },${SUBMIT_GUARD}
      },`;
const IDENTITY_ONLY = (() => {
  expect(CHAIN_SOURCE).toContain(WITNESS_GUARD);
  return program(CHAIN_SOURCE.replace(WITNESS_GUARD, ""));
})();

// The rule pinning the commit step alone. The planted brief releases under
// it, which is what shows that the second level refuses it.
const ONE_LEVEL = (() => {
  expect(CHAIN_SOURCE).toContain(SUBMIT_GUARD);
  return program(CHAIN_SOURCE.replace(SUBMIT_GUARD, ""));
})();

// The committed input with no default: the commit step creates the container,
// and the diff writes it empty before it writes the members. Nothing in the
// document is labeled when the first brief is submitted, so the submit step
// reads nothing labeled and its first write is unattributed
// (docs/specs/cfc-transformed-by-input-witnesses.md, "An unattributed
// input"). The rule pins the commit step alone here.
const FRESH = (() => {
  expect(CHAIN_SOURCE).toContain(DEFAULTED_COMMITTED);
  return program(
    CHAIN_SOURCE.replace(
      DEFAULTED_COMMITTED,
      "committed: Writable<Sealed<Committed>>;",
    ).replace(SUBMIT_GUARD, ""),
  );
})();

type Chain = {
  tally: string;
  roomTally: string;
  roomRelay: string;
  roomAppended: string;
  roomForged: string;
  roomPlanted: string;
};

const runChain = async (
  source: RuntimeProgram,
  cause: string,
  body: (
    send: (stream: string, event?: unknown) => Promise<void>,
    read: () => Promise<Chain>,
  ) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  try {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(source, {
      space,
      tx,
    });
    const result = runtime.getCell<Chain>(space, cause, undefined, tx);
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    const send = async (stream: string, event?: unknown) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(event);
      expect((await sendTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
    };
    const read = async () => {
      await runtime.idle();
      return (await result.pull()) as Chain;
    };
    await body(send, read);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("input-witnessed TransformedBy through compiled patterns", () => {
  for (
    const [name, source] of [
      ["a defaulted committed input", DEFAULTED],
      ["a committed input the commit step creates", FRESH],
    ] as const
  ) {
    it(`releases the honest chain over ${name}`, async () => {
      await runChain(source, `witness-honest ${name}`, async (send, read) => {
        await send("submit", { vote: "approve" });
        await send("submit", { vote: "reject" });
        await send("commit");
        expect((await read()).tally).toBe("1");
        await send("publishTally");
        expect((await read()).roomTally).toBe("1");
      });
    });

    it(`releases a relay, a planted vote, and a forged list under the identity alone over ${name}`, async () => {
      const identityOnly = source === DEFAULTED ? IDENTITY_ONLY : program(
        CHAIN_SOURCE.replace(WITNESS_GUARD, "").replace(
          DEFAULTED_COMMITTED,
          "committed: Writable<Sealed<Committed>>;",
        ),
      );
      await runChain(
        identityOnly,
        `identity-only ${name}`,
        async (send, read) => {
          await send("submit", { vote: "approve" });
          await send("submit", { vote: "reject" });
          await send("commit");
          await send("publishRelay");
          expect((await read()).roomRelay).toBe("1");
          await send("append");
          await send("publishAppended");
          expect((await read()).roomAppended).toBe("2");
          await send("forge");
          await send("publishForged");
          expect((await read()).roomForged).toBe("2");
        },
      );
    });

    it(`refuses a relay, a planted vote, and a forged list over ${name}`, async () => {
      await runChain(source, `witness-refused ${name}`, async (send, read) => {
        await send("submit", { vote: "approve" });
        await send("submit", { vote: "reject" });
        await send("commit");
        // Unendorsed code copied the committed votes before the tally.
        await send("publishRelay");
        expect((await read()).roomRelay).toBe("");
        // Unendorsed code added a vote beside the committed ones.
        await send("append");
        expect((await read()).tally).toBe("2");
        await send("publishAppended");
        expect((await read()).roomAppended).toBe("");
        // Unendorsed code wrote the whole vote list.
        await send("forge");
        await send("publishForged");
        expect((await read()).roomForged).toBe("");
        // Unendorsed code added a brief, which the commit step then counted.
        // Only the defaulted input's rule pins the submit step.
        if (source !== DEFAULTED) return;
        await send("plant");
        await send("commit");
        expect((await read()).tally).toBe("2");
        await send("publishPlanted");
        expect((await read()).roomPlanted).toBe("");
      });
    });
  }

  it("releases a planted brief when the rule pins the commit step alone", async () => {
    await runChain(ONE_LEVEL, "one-level planted", async (send, read) => {
      await send("submit", { vote: "approve" });
      await send("submit", { vote: "reject" });
      await send("plant");
      await send("commit");
      expect((await read()).tally).toBe("2");
      await send("publishPlanted");
      expect((await read()).roomPlanted).toBe("2");
    });
  });
});
