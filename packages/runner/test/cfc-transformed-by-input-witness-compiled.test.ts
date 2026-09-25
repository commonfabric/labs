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
// honest chain to releasing while the shapes that launder still refuse.

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
}

export default pattern<Rooms>(
  ({ roomTally, roomRelay, roomAppended, roomForged }) => {
    const ballot = WitnessedChain({} as any);
    return {
      tally: ballot.tally,
      roomTally,
      roomRelay,
      roomAppended,
      roomForged,
      submit: ballot.submit,
      commit: ballot.commit,
      forge: ballot.forge,
      append: ballot.append,
      publishTally: publish({ from: ballot.tally, to: roomTally }),
      publishRelay: publish({ from: ballot.relayTally, to: roomRelay }),
      publishAppended: publish({ from: ballot.tally, to: roomAppended }),
      publishForged: publish({ from: ballot.tally, to: roomForged }),
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

// The committed input with no default: the commit step creates the container,
// and the diff writes it empty before it writes the members.
const FRESH = (() => {
  expect(CHAIN_SOURCE).toContain(DEFAULTED_COMMITTED);
  return program(
    CHAIN_SOURCE.replace(
      DEFAULTED_COMMITTED,
      "committed: Writable<Sealed<Committed>>;",
    ),
  );
})();

type Chain = {
  tally: string;
  roomTally: string;
  roomRelay: string;
  roomAppended: string;
  roomForged: string;
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
      });
    });
  }
});
