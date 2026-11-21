import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// The witnessed-chain cases (`cfc-transformed-by-input-witness-compiled.test.ts`)
// run steps that each write a store once. A state machine is the other
// shape: one endorsed handler that reads the state it then writes, again and
// again, with an endorsed projection released when the handler wrote
// everything the projection read. These cases run that shape as a compiled
// pattern over each way of storing the state, and pin which of them keep the
// input witness. `patterns/examples/cfc-exchange-rules/sealed-state-machine.tsx`
// is the worked example built on the result, and
// `SEALED-STATE-MACHINE-FINDINGS.md` beside it reads these cases.

const signer = await Identity.fromPassphrase(
  "runner-cfc-input-witness-state-machine",
);
const space = signer.did();

const MAIN = `/// <cts-enable />
import {
  type Confidential,
  type Default,
  handler,
  lift,
  type MaxConfidentiality,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

// Each rule releases what one projection computed over inputs \`step\`
// wrote.
export const releaseText = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "projectText",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "step",
        },
      },
    }],
  },
  post: { dropClause: true },
});
export const releaseRecord = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "projectRecord",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "step",
        },
      },
    }],
  },
  post: { dropClause: true },
});
export const releaseCurrent = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "projectCurrent",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "step",
        },
      },
    }],
  },
  post: { dropClause: true },
});
export const machineRules = exchangeRules([
  releaseText,
  releaseRecord,
  releaseCurrent,
]);

// A second policy, which releases nothing this program computes.
export const releaseNothing = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "noSuchFunction",
      },
    }],
  },
  post: { dropClause: true },
});
export const otherRules = exchangeRules([releaseNothing]);

type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof machineRules>]>;
type Other<T> = Confidential<T, readonly [PolicyOf<typeof otherRules>]>;
type PublicText = MaxConfidentiality<string, readonly []>;

interface Rec {
  count: number;
  log: number[];
  note: string;
}

interface Stores {
  text: Writable<Sealed<string>>;
  partial: Writable<Sealed<Rec>>;
  whole: Writable<Sealed<Rec>>;
  blind: Writable<Sealed<Rec>>;
  cursor: Writable<Sealed<number>>;
  even: Writable<Sealed<Rec>>;
  odd: Writable<Sealed<Rec>>;
  relayed: Writable<Sealed<string>>;
  notice: Writable<PublicText>;
  hint?: Other<string>;
}

const grown = (rec: Rec): Rec => ({
  count: rec.count + 1,
  log: [...rec.log, rec.count],
  note: rec.note + "x",
});

// The endorsed writer. Each \`kind\` advances one store.
export const step = handler<{ kind: string; text?: string }, Stores>(
  ({ kind, text: sent }, stores) => {
    if (kind === "text") {
      // A scalar, read and then set.
      stores.text.set(String(stores.text.get() ?? "") + "x");
    } else if (kind === "partial") {
      // A record, read and then set with one field changed.
      const rec = stores.partial.get();
      stores.partial.set({ ...rec, log: [...rec.log], count: rec.count + 1 });
    } else if (kind === "whole") {
      // A record, read and then set with every field changed.
      stores.whole.set(grown(stores.whole.get()));
    } else if (kind === "blind") {
      // A record set whole without reading it. The scalar is read so that
      // the run reads something labeled.
      const size = String(stores.text.get() ?? "").length;
      stores.blind.set({ count: size, log: [size], note: "set" });
    } else if (kind === "blind-then-read") {
      const rec = stores.blind.get();
      stores.blind.set({ ...rec, log: [...rec.log], count: rec.count + 1 });
    } else if (kind === "alternate") {
      // Two records and a scalar cursor: read the current record, set the
      // other one whole, and advance the cursor.
      const at = Number(stores.cursor.get() ?? 0);
      const parity = at % 2;
      const rec = (parity === 0 ? stores.even.get() : stores.odd.get()) as Rec;
      if (parity === 0) stores.odd.set(grown(rec));
      else stores.even.set(grown(rec));
      stores.cursor.set(at + 1);
    } else if (kind === "announce") {
      // The scalar advanced, and a literal written to a public store.
      stores.text.set(String(stores.text.get() ?? "") + "x");
      stores.notice.set("moved");
    } else if (kind === "announce-only") {
      // A literal written to a public store, and no sealed store read.
      stores.notice.set("hello");
    } else if (kind === "relayed") {
      // A scalar set from the event's payload.
      stores.relayed.set(String(stores.relayed.get() ?? "") + (sent ?? ""));
    }
  },
);

// Not the endorsed writer: sends the endorsed writer a payload it read from
// a value labeled with another policy.
export const relay = handler<
  void,
  { hint: Other<string>; to: Stream<{ kind: string; text?: string }> }
>((_, { hint, to }) => {
  to.send({ kind: "relayed", text: String(hint) });
});

const shown = (rec: Rec | undefined): string =>
  rec === undefined ? "" : rec.count + ":" + (rec.log ?? []).length;

// The endorsed projections, one for each way the state is stored.
export const projectText = lift((text: string | undefined): string =>
  "text " + (text ?? "")
);
export const projectRecord = lift((rec: Rec | undefined): string =>
  "rec " + shown(rec)
);
export const projectCurrent = lift((
  input: { cursor: number; even: Rec; odd: Rec } | undefined,
): string =>
  "at " + shown((input?.cursor ?? 0) % 2 === 0 ? input?.even : input?.odd)
);

const publish = handler<void, { from: string; to: Writable<PublicText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

type Room = Writable<Default<PublicText, "">>;
interface Input {
  text: Writable<Default<Sealed<string>, "">>;
  partial: Writable<Default<Sealed<Rec>, { count: 0; log: []; note: "" }>>;
  whole: Writable<Default<Sealed<Rec>, { count: 0; log: []; note: "" }>>;
  blind: Writable<Default<Sealed<Rec>, { count: 0; log: []; note: "" }>>;
  cursor: Writable<Default<Sealed<number>, 0>>;
  even: Writable<Default<Sealed<Rec>, { count: 0; log: []; note: "" }>>;
  odd: Writable<Default<Sealed<Rec>, { count: 0; log: []; note: "" }>>;
  relayed: Writable<Default<Sealed<string>, "">>;
  notice: Writable<Default<PublicText, "">>;
  hint: Default<Other<string>, "h">;
  roomText: Room;
  roomTextAgain: Room;
  roomPartial: Room;
  roomWhole: Room;
  roomBlind: Room;
  roomBlindAgain: Room;
  roomAlternate1: Room;
  roomAlternate2: Room;
  roomAlternate3: Room;
  roomRelayed: Room;
}

export default pattern<Input>((input) => {
  const { text, partial, whole, blind, cursor, even, odd, relayed } = input;
  const stores = {
    text, partial, whole, blind, cursor, even, odd, relayed,
    notice: input.notice,
  };
  const stepStream = step(stores);
  const views = {
    text: projectText(text),
    partial: projectRecord(partial),
    whole: projectRecord(whole),
    blind: projectRecord(blind),
    alternate: projectCurrent({ cursor, even, odd }),
    relayed: projectText(relayed),
  };
  return {
    ...views,
    notice: input.notice,
    roomText: input.roomText,
    roomTextAgain: input.roomTextAgain,
    roomPartial: input.roomPartial,
    roomWhole: input.roomWhole,
    roomBlind: input.roomBlind,
    roomBlindAgain: input.roomBlindAgain,
    roomAlternate1: input.roomAlternate1,
    roomAlternate2: input.roomAlternate2,
    roomAlternate3: input.roomAlternate3,
    roomRelayed: input.roomRelayed,
    step: stepStream,
    // The endorsed writer bound to a value another policy labels as well.
    taintedStep: step({ ...stores, hint: input.hint }),
    relay: relay({ hint: input.hint, to: stepStream }),
    publishText: publish({ from: views.text, to: input.roomText }),
    publishTextAgain: publish({ from: views.text, to: input.roomTextAgain }),
    publishPartial: publish({ from: views.partial, to: input.roomPartial }),
    publishWhole: publish({ from: views.whole, to: input.roomWhole }),
    publishBlind: publish({ from: views.blind, to: input.roomBlind }),
    publishBlindAgain: publish({
      from: views.blind,
      to: input.roomBlindAgain,
    }),
    publishAlternate1: publish({
      from: views.alternate,
      to: input.roomAlternate1,
    }),
    publishAlternate2: publish({
      from: views.alternate,
      to: input.roomAlternate2,
    }),
    publishAlternate3: publish({
      from: views.alternate,
      to: input.roomAlternate3,
    }),
    publishRelayed: publish({ from: views.relayed, to: input.roomRelayed }),
  };
});
`;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: MAIN }],
};

type Machine = Record<string, string>;

/**
 * Runs the machine and hands `body` a `send` for its streams and a `read` of
 * its result. `advance` sends the endorsed writer one event of `kind`.
 */
const runMachine = async (
  cause: string,
  body: (
    advance: (kind: string) => Promise<void>,
    send: (stream: string, event?: unknown) => Promise<void>,
    read: () => Promise<Machine>,
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
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const result = runtime.getCell<Machine>(space, cause, undefined, tx);
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    const sendTo = async (stream: string, event?: unknown) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(event);
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
    };
    const read = async () => {
      await runtime.idle();
      return (await result.pull()) as Machine;
    };
    await body((kind) => sendTo("step", { kind }), sendTo, read);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("input-witnessed TransformedBy over a state machine", () => {
  it("releases a projection of a scalar the writer read and set, from its first write", async () => {
    await runMachine("scalar", async (advance, send, read) => {
      // The first write reads only the scalar's default.

      await advance("text");
      expect((await read()).text).toBe("text x");
      await send("publishText");
      expect((await read()).roomText).toBe("text x");

      await advance("text");
      await send("publishTextAgain");
      expect((await read()).roomTextAgain).toBe("text xx");
    });
  });

  it("refuses a second release into a store that holds the first, a known gap", async () => {
    await runMachine("scalar republished", async (advance, send, read) => {
      // The store keeps the first release. A store that took each release
      // would flip this to the second.

      await advance("text");
      await send("publishText");
      expect((await read()).roomText).toBe("text x");
      await advance("text");
      expect((await read()).text).toBe("text xx");
      await send("publishText");
      expect((await read()).roomText).toBe("text x");
    });
  });

  it("refuses a projection of a record the writer read and set in part", async () => {
    await runMachine("record in part", async (advance, send, read) => {
      await advance("partial");
      expect((await read()).partial).toBe("rec 1:0");
      await send("publishPartial");
      expect((await read()).roomPartial).toBe("");
    });
  });

  it("refuses a projection of a record the writer read and set with every field changed", async () => {
    await runMachine("record whole", async (advance, send, read) => {
      await advance("whole");
      await advance("whole");
      expect((await read()).whole).toBe("rec 2:2");
      await send("publishWhole");
      expect((await read()).roomWhole).toBe("");
    });
  });

  it("releases a projection of a record the writer set without reading it, until the writer reads and sets it", async () => {
    await runMachine("record blind", async (advance, send, read) => {
      await advance("text");
      await advance("blind");
      expect((await read()).blind).toBe("rec 1:1");
      await send("publishBlind");
      expect((await read()).roomBlind).toBe("rec 1:1");

      await advance("blind-then-read");
      expect((await read()).blind).toBe("rec 2:1");
      await send("publishBlindAgain");
      expect((await read()).roomBlindAgain).toBe("");
    });
  });

  it("releases a projection of two records the writer alternates between, each set without reading it", async () => {
    await runMachine("records alternated", async (advance, send, read) => {
      const rounds = [[1, "at 1:1"], [2, "at 2:2"], [3, "at 3:3"]] as const;
      for (const [round, expected] of rounds) {
        await advance("alternate");
        expect((await read()).alternate).toBe(expected);
        await send(`publishAlternate${round}`);
        expect((await read())[`roomAlternate${round}`]).toBe(expected);
      }
    });
  });

  it("refuses a move that also writes a public store", async () => {
    await runMachine("public beside sealed", async (advance, _send, read) => {
      // The run read the sealed scalar, so everything it writes carries the
      // scalar's clause, a literal included, and the whole commit is refused.

      await advance("announce");
      const machine = await read();
      expect(machine.notice).toBe("");
      expect(machine.text).toBe("text ");
    });
  });

  it("refuses the writer's public write in a run whose handler reads nothing sealed", async () => {
    await runMachine("public alone", async (advance, _send, read) => {
      // The handler body touches only the public store. Its binding names
      // the sealed stores, and that is enough for the write to be refused.

      await advance("announce-only");
      expect((await read()).notice).toBe("");
    });
  });

  it("refuses every write of a writer bound to a value another policy labels", async () => {
    await runMachine("writer tainted", async (_advance, send, read) => {
      // The binding reads the labeled value whether or not the handler uses
      // it, and the sealed store admits only its own policy's clause.

      await send("taintedStep", { kind: "text" });
      expect((await read()).text).toBe("text ");
    });
  });

  it("releases a projection of a scalar the writer set from a payload that carried a value another policy labels, a known gap", async () => {
    await runMachine("scalar relayed", async (_advance, send, read) => {
      // A client runtime delivers an event's payload without the label of
      // what the sender read, so the other policy's clause does not reach
      // the state. A fix would flip this to a refusal.

      await send("relay");
      expect((await read()).relayed).toBe("text h");
      await send("publishRelayed");
      expect((await read()).roomRelayed).toBe("text h");
    });
  });
});
