/**
 * Sealed custody reached from a pattern, end to end.
 *
 * Two members seal their stances into the room of
 * `cfc-exchange-rules/custody-projector.tsx` through the host's custody seal,
 * bound to the pattern's own cells the way `cf-custody-seal` binds them: the
 * terms name each seat by a cell the member's runtime attested, the policy is
 * read from the label of the pattern's `policy` cell, and the box the seal
 * returns is linked into the pattern's `box`. The pattern's projector then
 * reads the box, and of what it computes only its answer is shown to a reader
 * of the room. This is the honest path; that the rule names the projector by
 * identity alone, and so releases what it computes over a crafted box, is in
 * the spec's limits.
 *
 * Each member runs its own runtime over one in-process memory server. No
 * toolshed or browser is involved; the trusted click is built the way the
 * worker builds it for `cf-custody-seal`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { ACLManager, type Cell, Runtime } from "@commonfabric/runner";
import {
  cfcLabelViewForResolvedCell,
  type CfcTrustConfigInput,
  createRenderConfidentialityResolver,
  createRuntimeCfcModulePolicySource,
  markRendererTrustedEvent,
} from "@commonfabric/runner/cfc";
import { clauseAlternatives } from "@commonfabric/runner/cfc/clause";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  commitCustodySeal,
  CUSTODY_SEAL_GESTURE,
  prepareCustodySeal,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "@commonfabric/runner/cfc/custody-seal";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const PATTERN = join(
  import.meta.dirname!,
  "..",
  "cfc-exchange-rules",
  "custody-projector.tsx",
);
const ROOT = join(import.meta.dirname!, "..");
const REVIEWER = "did:web:review.example";
const SEAT_WRITER = "custody-projector-test-seat";

/** Each member's trust: the room's exact policy is a trusted declassifier. */
const trustIn = (policy: Record<string, string>): CfcTrustConfigInput => ({
  statements: [{
    concrete: {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: policy.moduleIdentity,
      symbol: policy.symbol,
      policyDigest: policy.policyDigest,
    },
    implements: TRUSTED_DECLASSIFIER_CONCEPT,
    verifier: REVIEWER,
  }],
  delegations: [{
    delegator: "*",
    verifier: REVIEWER,
    concepts: [TRUSTED_DECLASSIFIER_CONCEPT],
  }],
});

/** The confirmation gesture the worker builds for `cf-custody-seal`. */
const trustedClick = () => {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: { pattern: CUSTODY_SEAL_GESTURE },
    },
  };
  markRendererTrustedEvent(event);
  return event;
};

// The room's rule as the pattern writes it, naming its projector alone, and
// the same rule requiring as well that everything confidential the projector
// read was written by the seal.
const IDENTITY_GUARD = `        symbol: "projectChoice",
      },
    }],`;
const WITNESSED_GUARD = `        symbol: "projectChoice",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: { kind: "builtin", builtinId: "cfc-custody-seal" },
      },
    }],`;

/**
 * Two members seal their stances into a room of the projector, the rule
 * requiring the seal's witness when `witnessed`, and a reader of the room is
 * shown the projector's answer and not a member's rating.
 */
const sealAndRelease = async (witnessed: boolean): Promise<void> => {
  const [alice, bob, roomKey] = await Promise.all(
    ["alice", "bob", "room"].map((name) =>
      Identity.fromPassphrase(`custody projector ${name}`)
    ),
  );
  const S = roomKey.did();
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const managers: EmulatedStorageManager[] = [];
  const runtimes: Runtime[] = [];
  const runtimeFor = (identity: Identity, trust?: CfcTrustConfigInput) => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: identity,
    });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: identity.did(),
      }),
      ...(trust === undefined ? {} : { cfcTrustConfig: trust }),
    });
    runtimes.push(runtime);
    return runtime;
  };
  try {
    // The room space's access list names both members.
    const roomAcl = new ACLManager(runtimeFor(roomKey), S);
    await roomAcl.set(alice.did(), "OWNER");
    await roomAcl.set(bob.did(), "WRITE");

    // Alice starts the room.
    const host = runtimeFor(alice);
    const resolved = await resolveLocalProgram(
      (resolver) => host.harness.resolve(resolver),
      { main: PATTERN, root: ROOT },
    );
    const program = !witnessed ? resolved : {
      ...resolved,
      files: resolved.files.map((file) => {
        if (!file.name.endsWith("custody-projector.tsx")) return file;
        expect(file.contents).toContain(IDENTITY_GUARD);
        return {
          ...file,
          contents: file.contents.replace(IDENTITY_GUARD, WITNESSED_GUARD),
        };
      }),
    };
    const compiled = await host.patternManager.compilePattern(program, {
      space: S,
    });
    const start = host.edit();
    const piece = host.getCell<Record<string, unknown>>(
      S,
      "custody-projector",
      undefined,
      start,
    );
    host.run(start, compiled, {}, piece);
    host.prepareTxForCommit(start);
    expect((await start.commit()).error).toBeUndefined();
    await host.idle();
    await host.storageManager.synced();
    const room = piece.withTx(undefined);

    // Each member's runtime attests its own seat, as it attests a profile's
    // owner-protected fields: the runtime binds the subject to the acting
    // principal, and a claim like it needs a writer policy. The writer here
    // stands in for the profile's own handlers.
    const seatOf = async (identity: Identity) => {
      const runtime = runtimeFor(identity);
      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: SEAT_WRITER,
      });
      const seat = runtime.getCell(S, `seat-${identity.did()}`, {
        type: "object",
        ifc: {
          addIntegrity: [{
            kind: "represents-principal",
            subject: { __ctCurrentPrincipal: true },
          }],
          ownerPrincipal: { __ctCurrentPrincipal: true },
          writeAuthorizedBy: [SEAT_WRITER],
        },
      } as never, tx);
      seat.set({} as never);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.storageManager.synced();
      return seat.withTx(undefined);
    };
    const seats = [await seatOf(alice), await seatOf(bob)];

    // Alice proposes: the room's terms name the seats by those cells,
    // never by a DID, and the room declares its policy.
    room.key("propose").send({
      seats: seats.map((seat) => host.getCellFromLink(seat)),
    } as never);
    await host.idle();
    await host.storageManager.synced();

    // The policy the pattern declared, as its label carries it: the
    // members' trust names its exact digest.
    const declared = cfcLabelViewForResolvedCell(room.key("policy"))
      ?.entries.flatMap((entry) => entry.label.confidentiality ?? [])
      .flat()
      .find((atom) =>
        (atom as { type?: string }).type === CFC_ATOM_TYPE.Policy
      ) as Record<string, string> | undefined;
    expect(declared).toMatchObject({ symbol: "custodyRules", subject: S });
    const trust = trustIn(declared!);

    // Each member seals a rating per option from a draft at home, through
    // the room's own `terms` and `policy` cells, and the seal links the box
    // it sealed into into the room's `box`, as `cf-custody-seal` binds it.
    const seal = async (identity: Identity, ratings: string[]) => {
      const runtime = runtimeFor(identity, trust);
      const home = identity.did();
      const tx = runtime.edit();
      const draft = runtime.getCell(home, "stance-draft", {
        type: "object",
        ifc: { confidentiality: [cfcAtom.user(home)] },
      } as never, tx);
      draft.set({ ratings } as never);
      expect((await tx.commit()).error).toBeUndefined();
      const own = (cell: Cell<unknown>) => runtime.getCellFromLink(cell);
      const prepared = await prepareCustodySeal(draft.withTx(undefined), {
        terms: own(room.key("terms")),
        policy: own(room.key("policy")),
        box: own(room.key("box")),
      }, { allowedSources: [] });
      expect((prepared.terms as { seats: string[] }).seats).toEqual([
        alice.did(),
        bob.did(),
      ]);
      expect(prepared.policy).toEqual(declared);
      // A rule naming its projector by identity alone makes the
      // confirmation warn instead of bounding what an answer reveals.
      expect(prepared.witnessedRelease).toBe(witnessed);
      return await commitCustodySeal(prepared.consent, trustedClick());
    };
    const sealed = await seal(alice, ["yes", "maybe", "no"]);
    const bobs = await seal(bob, ["maybe", "yes", "yes"]);
    // Tacos drew a `no`; pizza and sushi drew one `yes` each, and pizza is
    // listed first.
    await waitForCellValue<string>(
      host,
      room.key("choice"),
      (value) => value === "pizza",
      { stuckLabel: "the projector's answer over the sealed box" },
    );
    // The room holds a link to the box, not a copy of its entries: its
    // `box` resolves to the box document itself.
    expect(room.key("box").resolveAsCell().getAsNormalizedFullLink().id)
      .toBe(sealed.box.getAsNormalizedFullLink().id);

    // Shown to a reader of the room, only the projector's answer is
    // released: its label's policy clause is dropped by the room's rule,
    // and what is left admits the room's readers. A member's rating, read
    // from the same box by other code, stays sealed.
    const display = createRenderConfidentialityResolver({
      actingPrincipal: bob.did(),
      memberSpaces: [S],
      modulePolicyResolver: createRuntimeCfcModulePolicySource(host).resolve,
    });
    const shownTo = (did: string, cell: Cell<unknown>) => {
      const labels = (cfcLabelViewForResolvedCell(cell)?.entries ?? [])
        .filter((entry) =>
          entry.path.length === 0 &&
          (entry.observes === undefined || entry.observes === "value")
        )
        .map((entry) => entry.label);
      const confidentiality = labels.flatMap((label) =>
        label.confidentiality ?? []
      );
      const integrity = labels.flatMap((label) => label.integrity ?? []);
      expect(confidentiality).not.toEqual([]);
      return display({ confidentiality, integrity, spaces: () => [S] }).every(
        (clause) =>
          clauseAlternatives(clause).some((atom) =>
            deepEqual(atom, cfcAtom.user(did))
          ),
      );
    };
    // The entries are keyed blindly, so either member's is first.
    await waitForCellValue<string>(
      host,
      room.key("rating"),
      (value) => value === "yes" || value === "maybe",
      { stuckLabel: "a member's rating read from the sealed box" },
    );
    expect(shownTo(bob.did(), room.key("choice"))).toBe(true);
    expect(shownTo(bob.did(), room.key("rating"))).toBe(false);
    if (!witnessed) return;

    // A member's code points the room's `box` at a record of its own that
    // repeats Bob's real entry, so his stance counts for both seats. The
    // projector's answer moves to what that record yields, and the rule,
    // which asks that everything the projector read, the references it
    // followed included, was the seal's, does not show it.
    const crafted = await host.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "repointBox",
        bindingPath: ["repointBox"],
      });
      const record = host.getCell(S, "crafted-box", {
        type: "object",
        ifc: { confidentiality: [cfcAtom.space(S)] },
      } as never, tx);
      const entry = host.getCellFromLink(
        { ...bobs.box.getAsNormalizedFullLink(), path: [bobs.entryKey] },
        undefined,
        tx,
      );
      record.set({ first: entry, second: entry } as never);
      room.key("box").withTx(tx).set(record as never);
    });
    expect(crafted.error).toBeUndefined();
    // Bob's `yes` to sushi now counts twice.
    await waitForCellValue<string>(
      host,
      room.key("choice"),
      (value) => value === "sushi",
      { stuckLabel: "the projector's answer over the crafted record" },
    );
    expect(shownTo(bob.did(), room.key("choice"))).toBe(false);
  } finally {
    for (const runtime of runtimes) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers) await manager.close();
    await server.close();
  }
};

describe("sealed custody through a pattern", () => {
  it("seals two members' stances, and releases only the projector's answer", async () => {
    await sealAndRelease(false);
  });

  it("releases the projector's answer under a rule requiring the seal's witness", async () => {
    // The projector reads the box through the room's `box`, which holds the
    // link the seal wrote, so everything it read carries the seal's stamp.
    await sealAndRelease(true);
  });
});
