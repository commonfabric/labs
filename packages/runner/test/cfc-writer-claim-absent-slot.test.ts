import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { isObjectOrArray } from "@commonfabric/utils/types";

// A `writeAuthorizedBy` claim is a property of the field's schema, not of
// its value (normative CFC §8.15.3): the write-authority set exists from the
// piece's creation and does not change per write. A pattern input declared
// `WriteAuthorizedBy<T, typeof writer>` with no default is such a field: it
// is absent until its writer's first write, and it is guarded while absent
// exactly as it is guarded afterwards. Three gaps, each a runtime-level
// test here:
//
// - A: with no claimed input carrying a default, setup persisted no envelope
//   for the argument document at all, so the claim was never stored and
//   every writer was admitted;
// - C: with the envelope stored (a sibling's default put it there), the
//   claimed slot got no label-map entry until a write touched it, so a
//   writer through a bare schema was not routed to the claim while the slot
//   was absent;
// - B: the named writer's first write, whose value links cells another
//   writer attested, must commit — the claim governs who writes the slot,
//   and a link's target keeps its own authorship.

const signer = await Identity.fromPassphrase("cfc-writer-claim-absent-slot");
const space = signer.did();

/** The builtin that attests a seat, standing in for a profile's handlers. */
const SEAT_WRITER = "cfc-writer-claim-absent-slot-seat";

/** A room whose claimed inputs have no default: they are `propose`'s to write. */
const ROOM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import {
  type Confidential,
  Default,
  handler,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const neverRelease = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: ["never-present-atom"] },
  post: { dropClause: true },
});
export const rules = exchangeRules([neverRelease]);
type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof rules>]>;

export interface Terms {
  question: string;
  seats: unknown[];
}

const propose = handler<
  { question: string; seats: unknown[] },
  { terms: Writable<Terms>; policy: Writable<Sealed<boolean>> }
>(({ question, seats }, { terms, policy }) => {
  if (terms.get() === undefined) terms.set({ question, seats });
  if (policy.get() === undefined) policy.set(true as Sealed<boolean>);
});

interface Input {
  /** No default: absent until \`propose\` writes it. */
  terms: Writable<WriteAuthorizedBy<Terms, typeof propose>>;
  /** No default, and labeled with the room's policy once written. */
  policy: Writable<WriteAuthorizedBy<Sealed<boolean>, typeof propose>>;
  /** An unclaimed input with a default, so the document has content. */
  box?: Default<Record<string, never>, Record<string, never>>;
}

interface Output {
  terms?: Terms;
  policy: Sealed<boolean>;
  box: Record<string, never>;
  propose: Stream<{ question: string; seats: unknown[] }>;
}

export default pattern<Input, Output>(({ terms, policy, box }) => ({
  terms,
  policy,
  box,
  propose: propose({ terms, policy }),
}));
`,
  }],
};

/**
 * The same room with one more claimed input that carries a default: the
 * shape that persists an envelope today, so the absent claimed slot's
 * gating can be measured apart from the envelope's existence.
 */
const ROOM_WITH_DEFAULTED_CLAIM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: ROOM.files[0].contents.replace(
      "  /** An unclaimed input with a default, so the document has content. */",
      `  /** A claimed input with a default, whose entry persists the envelope. */
  frozen?: Default<WriteAuthorizedBy<string, typeof propose>, "">;
  /** An unclaimed input with a default, so the document has content. */`,
    ).replace(
      "  box: Record<string, never>;\n  propose",
      "  box: Record<string, never>;\n  frozen: string;\n  propose",
    ).replace(
      "(({ terms, policy, box }) => ({\n  terms,",
      "(({ terms, policy, box, frozen }) => ({\n  frozen,\n  terms,",
    ),
  }],
};

type Terms = { question: string; seats: unknown[] };
type Room = {
  terms?: Terms;
  policy: boolean;
  box: Record<string, never>;
  frozen?: string;
};

/** Every `writeAuthorizedBy` claim in `schema`, keyed by its JSON pointer. */
const claimsIn = (schema: unknown): Map<string, unknown> => {
  const claims = new Map<string, unknown>();
  const walk = (node: unknown, pointer: string) => {
    if (!isObjectOrArray(node)) return;
    if (isObjectOrArray(node.ifc) && node.ifc.writeAuthorizedBy !== undefined) {
      claims.set(pointer, node.ifc.writeAuthorizedBy);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "ifc") continue;
      walk(child, `${pointer}/${key}`);
    }
  };
  walk(schema, "");
  return claims;
};

describe("a writer claim on an input with no default", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime(runtimePresets.patternTest({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {},
    }));
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const start = async (program: RuntimeProgram, name: string) => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const cell = runtime.getCell<Room>(space, name, undefined, tx);
    const running = runtime.run(tx, pattern, {}, cell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    await runtime.idle();
    await runtime.storageManager.synced();
    const argument = running.getArgumentCell<Room>()!;
    return { piece: running, argument };
  };

  /** The envelope stored for the argument document, as the commit sees it. */
  const storedEnvelope = (argument: Cell<Room>) => {
    const link = argument.getAsNormalizedFullLink();
    const tx = runtime.edit();
    try {
      return loadStoredCfcEnvelope(tx, {
        space: link.space,
        id: link.id,
        scope: link.scope,
      });
    } finally {
      tx.abort();
    }
  };

  const send = async (piece: Cell<Room>, event: unknown) => {
    (piece.key("propose") as unknown as { send: (e: unknown) => void }).send(
      event,
    );
    await runtime.idle();
    await piece.pull();
    await runtime.idle();
  };

  /**
   * A write by code of a member's own, which is not the room's writer: the
   * argument document addressed by its bare link, through a schema of the
   * writer's choosing, as a runtime holding WRITE on the space can address it.
   */
  const asMember = (
    write: (tx: IExtendedStorageTransaction) => void,
  ) =>
    runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "repoint",
        bindingPath: ["repoint"],
      });
      write(tx);
    });

  const bareLink = (argument: Cell<Room>, path: string[]) => {
    const { schema: _schema, ...bare } = argument.getAsNormalizedFullLink();
    return { ...bare, path: [...bare.path, ...path] };
  };

  const expectRefused = (error: unknown, what: string) => {
    expect(error, `${what}: ${JSON.stringify(error)}`).toMatchObject({
      name: "CfcCommitRefusalError",
      reasons: [expect.stringMatching(/^writeAuthorizedBy /)],
    });
  };

  /**
   * The member writes the gaps' cases against `argument`, and each write that
   * would change the slot is refused, whether the slot is absent or holds
   * what its writer put there. Only a write of `undefined` over an absent
   * slot lands no byte and is nothing to refuse; it is asserted to leave the
   * slot absent.
   */
  const memberWritesAreRefused = async (
    argument: Cell<Room>,
    present: boolean,
  ) => {
    // The whole slot, through a schema that declares nothing.
    expectRefused(
      (await asMember((tx) =>
        runtime.getCellFromLink(
          bareLink(argument, ["terms"]),
          { type: "object" } as JSONSchema,
          tx,
        ).set({ question: "forged", seats: [] })
      )).error,
      "the whole slot",
    );
    // A new field beneath the slot.
    expectRefused(
      (await asMember((tx) =>
        runtime.getCellFromLink(
          bareLink(argument, ["terms", "extra"]),
          { type: "number" } as JSONSchema,
          tx,
        ).set(1)
      )).error,
      "a field beneath the slot",
    );
    // The slot cleared, so its writer would write it again.
    for (const cleared of [null, undefined]) {
      const error = (await asMember((tx) =>
        runtime.getCellFromLink(
          bareLink(argument, ["terms"]),
          { type: ["object", "null"] } as JSONSchema,
          tx,
        ).set(cleared as never)
      )).error;
      if (cleared === undefined && !present) {
        expect(argument.get().terms).toBeUndefined();
      } else {
        expectRefused(error, `the slot cleared to ${String(cleared)}`);
      }
    }
    // The labeled slot, through a schema that declares nothing.
    expectRefused(
      (await asMember((tx) =>
        runtime.getCellFromLink(
          bareLink(argument, ["policy"]),
          { type: "boolean" } as JSONSchema,
          tx,
        ).set(false)
      )).error,
      "the labeled slot",
    );
  };

  describe("is stored at creation (gap A)", () => {
    it("persists the argument envelope with the claim although no claimed input has a default", async () => {
      const { argument } = await start(ROOM, "claim-stored-at-creation");
      const stored = storedEnvelope(argument);
      expect(stored.status).toBe("loaded");
      const claims = claimsIn(
        (stored as { schema?: unknown }).schema,
      );
      expect([...claims.keys()]).toEqual(
        expect.arrayContaining(["/properties/terms", "/properties/policy"]),
      );
    });

    it("refuses a member's write into the absent slot, and admits the writer's first", async () => {
      const { piece, argument } = await start(ROOM, "absent-slot-guarded");
      expect(argument.get().terms).toBeUndefined();
      await memberWritesAreRefused(argument, false);
      expect(argument.get().terms).toBeUndefined();

      await send(piece, { question: "Where?", seats: [] });
      expect(argument.get().terms).toEqual({ question: "Where?", seats: [] });
      expect(argument.get().policy).toBe(true);

      // Written once, the slot is guarded as before, and the writer running
      // again writes nothing.
      await memberWritesAreRefused(argument, true);
      await send(piece, { question: "Elsewhere?", seats: [] });
      expect(argument.get().terms).toEqual({ question: "Where?", seats: [] });
    });
  });

  describe("gates the slot while it is absent (gap C)", () => {
    it("refuses a member's write into the absent slot of a document whose envelope a sibling's default persisted", async () => {
      const { piece, argument } = await start(
        ROOM_WITH_DEFAULTED_CLAIM,
        "absent-slot-beside-defaulted-claim",
      );
      const stored = storedEnvelope(argument);
      expect(stored.status).toBe("loaded");
      expect(argument.get().frozen).toBe("");
      expect(argument.get().terms).toBeUndefined();
      await memberWritesAreRefused(argument, false);
      expect(argument.get().terms).toBeUndefined();

      await send(piece, { question: "Where?", seats: [] });
      expect(argument.get().terms).toEqual({ question: "Where?", seats: [] });
      await memberWritesAreRefused(argument, true);
    });
  });

  describe("admits the writer's value linking cells another writer attested (gap B)", () => {
    /** A seat cell a builtin attests for the acting principal. */
    const attestSeat = async (name: string) => {
      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: SEAT_WRITER,
      });
      const seat = runtime.getCell(space, name, {
        type: "object",
        ifc: {
          addIntegrity: [{
            kind: "represents-principal",
            subject: { __ctCurrentPrincipal: true },
          }],
          ownerPrincipal: { __ctCurrentPrincipal: true },
          writeAuthorizedBy: [SEAT_WRITER],
        },
      } as JSONSchema, tx);
      seat.set({});
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.storageManager.synced();
      return seat.withTx(undefined);
    };

    it("commits the writer's first write whose seats link attested cells", async () => {
      const { piece, argument } = await start(ROOM, "seats-link-attested");
      const seats = [await attestSeat("seat-a"), await attestSeat("seat-b")];
      await send(piece, { question: "Where?", seats });
      const terms = argument.get().terms;
      expect(terms?.question).toBe("Where?");
      expect(terms?.seats).toHaveLength(2);
      await memberWritesAreRefused(argument, true);
    });
  });
});
