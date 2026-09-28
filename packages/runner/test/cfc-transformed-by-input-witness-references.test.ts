import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// A chain of endorsed steps whose committed values are lists of objects. The
// runtime stores an object pushed into, or set within, a list as an entity
// document of its own, and the list holds a reference to it. A two-level
// guard, `tally ← commit ← submit`, asks the commit step's inputs to carry the
// submit step's stamp, and those inputs are read through the references: the
// list's slots, and the entity documents behind them. These cases hold the
// honest chain to releasing through them, and every shape that puts a value
// the submit step did not write in front of the commit step to refusing.

const signer = await Identity.fromPassphrase(
  "runner-cfc-input-witness-references",
);
const space = signer.did();

const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";

// The guard, spelled once per depth: `tallyBallot`, then what it read, then
// what that read.
const guard = (symbols: readonly string[]): string =>
  symbols.reduceRight<string>(
    (inner, symbol) =>
      `{
        type: "${TRANSFORMED_BY}",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "${symbol}",
        },${inner === "" ? "" : `\n        inputWitness: ${inner},`}
      }`,
    "",
  );

const TWO_LEVEL = guard(["tallyBallot", "commit", "submit"]);
const ONE_LEVEL = guard(["tallyBallot", "commit"]);

// The room store sits beside the chain rather than inside it, as in
// `cfc-transformed-by-input-witness-compiled.test.ts`: it admits only public
// values, so a publish into it is where the release rule gets its chance.
const MAIN = `/// <cts-enable />
import { Default, handler, pattern, Writable } from "commonfabric";
import Chain, { type RoomText } from "./chain.tsx";

const publish = handler<void, { from: string; to: Writable<RoomText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

export default pattern<{ room: Writable<Default<RoomText, "">> }>(
  ({ room }) => {
    const chain = Chain({} as any);
    return {
      tally: chain.tally,
      room,
      submit: chain.submit,
      submitOther: chain.submitOther,
      commit: chain.commit,
      plant: chain.plant,
      rewrite: chain.rewrite,
      relinkForged: chain.relinkForged,
      relinkSubmitted: chain.relinkSubmitted,
      assemble: chain.assemble,
      copyList: chain.copyList,
      dupPush: chain.dupPush,
      dupList: chain.dupList,
      dropLast: chain.dropLast,
      publish: publish({ from: chain.tally, to: room }),
    };
  },
);
`;

// Where the commit step puts the briefs: in a list of its own, or, nested,
// in a list of objects inside a list of objects.
const FLAT = {
  committed: "briefs: Brief[];",
  empty: "{ briefs: [] }",
  commit: "briefs: copied,",
  briefs: "committed?.briefs ?? []",
};
const NESTED = {
  committed: "rounds: Sealed<{ briefs: Brief[] }>[];",
  empty: "{ rounds: [] }",
  commit: "rounds: [{ briefs: copied }],",
  briefs: "(committed?.rounds ?? []).flatMap((round) => round?.briefs ?? [])",
};

const source = (
  releaseGuard: string,
  shape: typeof FLAT = FLAT,
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: MAIN }, {
    name: "/chain.tsx",
    contents: `/// <cts-enable />
import {
  type Confidential,
  Default,
  handler,
  lift,
  type MaxConfidentiality,
  pattern,
  Writable,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const releaseTally = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [${releaseGuard}] },
  post: { dropClause: true },
});

export const ballotRules = exchangeRules([releaseTally]);

export interface Brief {
  vote: string;
}

export type Sealed<T> = Confidential<
  T,
  readonly [PolicyOf<typeof ballotRules>]
>;

export type RoomText = MaxConfidentiality<string, readonly []>;

export interface Committed {
  ${shape.committed}
}

/** The endorsed entry point: one fresh object per brief. */
export const submit = handler<Brief, { briefs: Writable<Sealed<Brief>[]> }>(
  (brief, { briefs }) => {
    briefs.push({ vote: brief.vote } as Sealed<Brief>);
  },
);

/** The endorsed step: copies each brief into a list of fresh objects. */
export const commit = handler<
  void,
  { briefs: Sealed<Brief>[]; committed: Writable<Sealed<Committed>> }
>((_, { briefs, committed }) => {
  const copied = (briefs ?? []).map((brief) => ({ vote: brief?.vote ?? "" }));
  committed.set({
    ${shape.commit}
  } as Sealed<Committed>);
});

/** The released computation: how many briefs approve. */
export const tallyBallot = lift((committed: Committed | undefined): string =>
  String(
    (${shape.briefs}).filter((brief) => brief?.vote === "approve")
      .length,
  )
);

/** Not the entry point: pushes a brief of its own choosing. */
export const plant = handler<void, { briefs: Writable<Sealed<Brief>[]> }>(
  (_, { briefs }) => {
    briefs.push({ vote: "approve" } as Sealed<Brief>);
  },
);

/** Not the entry point: rewrites a submitted brief's vote in place. */
export const rewrite = handler<void, { briefs: Writable<Sealed<Brief>[]> }>(
  (_, { briefs }) => {
    briefs.key(0).key("vote").set("approve");
  },
);

/** Not the entry point: points the first slot at a brief it wrote. */
export const relinkForged = handler<
  void,
  { briefs: Writable<Sealed<Brief>[]>; decoy: Writable<Sealed<Brief>> }
>((_, { briefs, decoy }) => {
  decoy.set({ vote: "approve" } as Sealed<Brief>);
  briefs.key(0).set(decoy);
});

/**
 * Not the entry point: points the first slot at a brief the entry point
 * wrote into another list.
 */
export const relinkSubmitted = handler<
  void,
  { briefs: Writable<Sealed<Brief>[]>; others: Writable<Sealed<Brief>[]> }
>((_, { briefs, others }) => {
  briefs.key(0).set(others.key(0));
});

/** Not the entry point: writes the whole list of briefs. */
export const assemble = handler<void, { briefs: Writable<Sealed<Brief>[]> }>(
  (_, { briefs }) => {
    briefs.set([{ vote: "approve" }, { vote: "approve" }] as Sealed<Brief>[]);
  },
);

/** Not the entry point: copies the entry point's list over this one. */
export const copyList = handler<
  void,
  { briefs: Writable<Sealed<Brief>[]>; others: Sealed<Brief>[] }
>((_, { briefs, others }) => {
  briefs.set([...(others ?? [])] as Sealed<Brief>[]);
});

/** Not the entry point: pushes a copy of the first reference. */
export const dupPush = handler<
  void,
  { briefs: Writable<Sealed<Brief>[]> }
>((_, { briefs }) => {
  briefs.push(briefs.key(0) as any);
});

/** Not the entry point: sets the list to its references and a duplicate. */
export const dupList = handler<
  void,
  { briefs: Writable<Sealed<Brief>[]> }
>((_, { briefs }) => {
  // The references as stored, rather than the briefs they name.
  const stored = (briefs as any).getRaw() as Sealed<Brief>[];
  briefs.set([...stored, stored[0]]);
});

/** Not the entry point: drops the last brief, keeping the rest in place. */
export const dropLast = handler<
  void,
  { briefs: Writable<Sealed<Brief>[]> }
>((_, { briefs }) => {
  const stored = (briefs as any).getRaw() as Sealed<Brief>[];
  briefs.set(stored.slice(0, -1));
});

// \`others\` sits inside an object of its own: two inputs defaulting to the
// same empty list are stored as one list.
interface ChainInput {
  briefs: Writable<Default<Sealed<Brief>[], []>>;
  pool: Writable<Default<{ others: Sealed<Brief>[] }, { others: [] }>>;
  decoy: Writable<Default<Sealed<Brief>, { vote: "" }>>;
  committed: Writable<Default<Sealed<Committed>, ${shape.empty}>>;
}

export default pattern<ChainInput>(
  ({ briefs, pool, decoy, committed }) => {
    const others = pool.key("others");
    return {
    tally: tallyBallot(committed),
    submit: submit({ briefs }),
    submitOther: submit({ briefs: others }),
    commit: commit({ briefs, committed }),
    plant: plant({ briefs }),
    rewrite: rewrite({ briefs }),
    relinkForged: relinkForged({ briefs, decoy }),
    relinkSubmitted: relinkSubmitted({ briefs, others }),
    assemble: assemble({ briefs }),
    copyList: copyList({ briefs, others }),
    dupPush: dupPush({ briefs }),
    dupList: dupList({ briefs }),
    dropLast: dropLast({ briefs }),
    };
  },
);
`,
  }],
});

// The chain with the clause on each brief's field rather than on the brief:
// the lists, their slots, and the briefs' own roots carry no clause.
const onFields = (program: RuntimeProgram): RuntimeProgram => ({
  ...program,
  files: program.files.map((file) => {
    if (file.name !== "/chain.tsx") return file;
    const declared = "export interface Brief {\n  vote: string;\n}";
    expect(file.contents).toContain(declared);
    return {
      ...file,
      contents: file.contents
        .replace(
          declared,
          "export interface Brief {\n  vote: Sealed<string>;\n}",
        )
        .replaceAll("Sealed<Brief>", "Brief"),
    };
  }),
});

const TWO_LEVEL_PROGRAM = source(TWO_LEVEL);
const TWO_LEVEL_NESTED = source(TWO_LEVEL, NESTED);
const ONE_LEVEL_PROGRAM = source(ONE_LEVEL);

type Chain = { tally: string; room: string };

const runChain = async (
  program: RuntimeProgram,
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
    const pattern = await runtime.patternManager.compilePattern(program, {
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
      const { error } = await sendTx.commit();
      await runtime.idle();
      await result.pull();
      // The publish is where a refusal is the expected outcome, and the room
      // left empty is what shows it.
      if (stream !== "publish") expect(error).toBeUndefined();
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

// Two honest briefs, one approving.
const submitTwo = async (
  send: (stream: string, event?: unknown) => Promise<void>,
) => {
  await send("submit", { vote: "approve" });
  await send("submit", { vote: "reject" });
};

// Each laundering shape: what it does before the commit step runs, and the
// tally the commit step then computes. Every one of them releases under the
// one-level guard, which is what shows that the second level, and not some
// other gate, is what refuses it.
const LAUNDERING: readonly {
  name: string;
  launder: (
    send: (stream: string, event?: unknown) => Promise<void>,
  ) => Promise<void>;
  tally: string;
}[] = [
  {
    name: "an object other code pushed into the list",
    launder: async (send) => {
      await submitTwo(send);
      await send("plant");
    },
    tally: "2",
  },
  {
    name: "a submitted object other code rewrote after the link was written",
    launder: async (send) => {
      await send("submit", { vote: "reject" });
      await send("rewrite");
    },
    tally: "1",
  },
  {
    name: "a slot other code pointed at a document it wrote",
    launder: async (send) => {
      await send("submit", { vote: "reject" });
      await send("relinkForged");
    },
    tally: "1",
  },
  {
    name: "a slot other code pointed at an object submitted elsewhere",
    launder: async (send) => {
      await send("submit", { vote: "reject" });
      await send("submitOther", { vote: "approve" });
      await send("relinkSubmitted");
    },
    tally: "1",
  },
  {
    name: "a list other code wrote whole",
    launder: async (send) => {
      await send("assemble");
    },
    tally: "2",
  },
  {
    name: "a copy of a submitted reference other code pushed",
    launder: async (send) => {
      await submitTwo(send);
      await send("dupPush");
    },
    tally: "2",
  },
  {
    name: "a list other code set to its references and a duplicate",
    launder: async (send) => {
      await submitTwo(send);
      await send("dupList");
    },
    tally: "2",
  },
  {
    // The dropped brief is an approval, so the tally differs from the
    // honest one.
    name: "a list other code truncated",
    launder: async (send) => {
      await send("submit", { vote: "reject" });
      await send("submit", { vote: "approve" });
      await send("submit", { vote: "approve" });
      await send("dropLast");
    },
    tally: "1",
  },
  {
    name: "a list other code copied from submitted objects",
    launder: async (send) => {
      await send("submitOther", { vote: "approve" });
      await send("copyList");
    },
    tally: "1",
  },
];

describe("input witnesses through references", () => {
  it("releases the honest chain over a list of objects", async () => {
    await runChain(TWO_LEVEL_PROGRAM, "honest", async (send, read) => {
      await submitTwo(send);
      await send("commit");
      expect((await read()).tally).toBe("1");
      await send("publish");
      expect((await read()).room).toBe("1");
    });
  });

  it("releases the honest chain over a list of objects nested in one", async () => {
    await runChain(TWO_LEVEL_NESTED, "honest nested", async (send, read) => {
      await submitTwo(send);
      await send("commit");
      expect((await read()).tally).toBe("1");
      await send("publish");
      expect((await read()).room).toBe("1");
    });
  });

  it("releases the honest chain once the commit step has run again", async () => {
    await runChain(TWO_LEVEL_PROGRAM, "honest again", async (send, read) => {
      await submitTwo(send);
      await send("commit");
      await send("submit", { vote: "approve" });
      await send("commit");
      expect((await read()).tally).toBe("2");
      await send("publish");
      expect((await read()).room).toBe("2");
    });
  });

  it("refuses an object other code pushed, nested in a list of objects", async () => {
    await runChain(TWO_LEVEL_NESTED, "planted nested", async (send, read) => {
      await submitTwo(send);
      await send("plant");
      await send("commit");
      expect((await read()).tally).toBe("2");
      await send("publish");
      expect((await read()).room).toBe("");
    });
  });

  it("refuses a list other code truncated, nested in a list of objects", async () => {
    await runChain(TWO_LEVEL_NESTED, "truncated nested", async (send, read) => {
      await send("submit", { vote: "reject" });
      await send("submit", { vote: "approve" });
      await send("submit", { vote: "approve" });
      await send("dropLast");
      await send("commit");
      expect((await read()).tally).toBe("1");
      await send("publish");
      expect((await read()).room).toBe("");
    });
  });

  describe("with the clause on each brief's field", () => {
    // Nothing labels a slot, so which references the list holds is not a
    // confidential read of its own. The references are followed to the
    // briefs' confidential fields, and that is what makes each slot an input.
    it("refuses a copy of a submitted reference other code pushed", async () => {
      await runChain(onFields(TWO_LEVEL_PROGRAM), "fields dup", async (
        send,
        read,
      ) => {
        await submitTwo(send);
        await send("dupPush");
        await send("commit");
        expect((await read()).tally).toBe("2");
        await send("publish");
        expect((await read()).room).toBe("");
      });
    });

    it("releases the copy under a one-level guard", async () => {
      await runChain(onFields(ONE_LEVEL_PROGRAM), "fields dup one", async (
        send,
        read,
      ) => {
        await submitTwo(send);
        await send("dupPush");
        await send("commit");
        await send("publish");
        expect((await read()).room).toBe("2");
      });
    });

    it("releases nothing of the honest chain", async () => {
      // The submit step's slot stamp carries its join, which the slot's
      // ceiling, declaring nothing, does not admit, so the slot keeps no
      // writer and a followed reference there withholds the witness.
      await runChain(onFields(TWO_LEVEL_PROGRAM), "fields honest", async (
        send,
        read,
      ) => {
        await submitTwo(send);
        await send("commit");
        expect((await read()).tally).toBe("1");
        await send("publish");
        expect((await read()).room).toBe("");
      });
    });
  });

  for (const { name, launder, tally } of LAUNDERING) {
    it(`releases ${name} under a one-level guard`, async () => {
      await runChain(ONE_LEVEL_PROGRAM, `one-level ${name}`, async (
        send,
        read,
      ) => {
        await launder(send);
        await send("commit");
        expect((await read()).tally).toBe(tally);
        await send("publish");
        expect((await read()).room).toBe(tally);
      });
    });

    it(`refuses ${name} under a two-level guard`, async () => {
      await runChain(TWO_LEVEL_PROGRAM, `two-level ${name}`, async (
        send,
        read,
      ) => {
        await launder(send);
        await send("commit");
        expect((await read()).tally).toBe(tally);
        await send("publish");
        expect((await read()).room).toBe("");
      });
    });
  }
});
