/**
 * Sealed custody reached from a pattern, end to end.
 *
 * Two members seal their stances into a room of
 * `cfc-exchange-rules/custody-projector.tsx`, and of
 * `cfc-exchange-rules/custody-answer-room.tsx`, through the host's custody seal,
 * bound to the pattern's own cells the way `cf-custody-seal` binds them: the
 * terms name each seat by a cell the member's runtime attested, the policy is
 * read from the label of the pattern's `policy` cell, and the box the seal
 * returns is linked into the pattern's `box`. The pattern's projector then
 * reads the box, and of what it computes only its answer is shown to a reader
 * of the room. The answer room's rule requires the seal's witness, so the
 * host publishes its answer once and refuses one over a crafted box; the
 * projector's rule names the projector by identity alone, so the host
 * publishes nothing for it, and that it releases what it computes over a
 * crafted box is in the spec's limits.
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
import {
  ACLManager,
  type Cell,
  type IExtendedStorageTransaction,
  type JSONSchema,
  Runtime,
} from "@commonfabric/runner";
import {
  cfcLabelViewForResolvedCell,
  type CfcTrustConfigInput,
  createRenderConfidentialityResolver,
  createRuntimeCfcModulePolicySource,
  loadStoredCfcEnvelope,
  markRendererTrustedEvent,
} from "@commonfabric/runner/cfc";
import { clauseAlternatives } from "@commonfabric/runner/cfc/clause";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  commitCustodySeal,
  CUSTODY_SEAL_GESTURE,
  prepareCustodySeal,
  publishCustodyAnswer,
  readCustodyAnswer,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "@commonfabric/runner/cfc/custody-seal";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

/** The demo-grade room, whose rule names its projector alone. */
const PROJECTOR = "custody-projector.tsx";
/** The room whose rule requires the seal's witness, and shows its answer. */
const ANSWER_ROOM = "custody-answer-room.tsx";
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

/**
 * How a member's own code would have the answer room show another instance's
 * slot. The host shows the slot the room's bound `terms` and `policy` name, so
 * the room must keep both as their first write left them. After the answer is
 * published, the member's code:
 *
 * - `propose`: runs `propose` again with the member's seat alone;
 * - `terms`: writes the terms of a room the member sealed alone over the
 *   room's `terms`;
 * - `seats`: narrows the seats beneath `terms` to the member's own, which
 *   makes them the terms of that room;
 * - `extra`: adds a field beneath `terms`, which makes them another
 *   instance's, whose slot is empty;
 * - `clear`: writes `null`, then nothing, over `terms`, so that `propose`
 *   writes them again;
 * - `policy`: writes over the room's `policy`.
 *
 * `early` is the same member's code before the room's own proposal, writing
 * terms and a policy into the absent slots for `propose` to find written.
 *
 * Every write goes through the room's argument document by its bare link, and
 * a schema of the member's choosing that declares no claim, as code holding
 * WRITE on the room space can address it. A write through `room.key("terms")`
 * would carry the room's own schema, claim included, and be refused whether
 * or not the runtime stored the claim; only the claim the runtime stored for
 * the document refuses a write through a link that carries none.
 */
type Repoint =
  | "propose"
  | "terms"
  | "seats"
  | "extra"
  | "clear"
  | "policy"
  | "early";

/**
 * Two members seal their stances into a room of `file`, and a reader of the
 * room is shown the projector's answer and not a member's rating. The host
 * publishes that answer only for the room whose rule requires the seal's
 * witness. With `repoint`, a member's code then repoints the answer room, and
 * the room still shows the answer its members sealed.
 */
const sealAndRelease = async (
  file: typeof PROJECTOR | typeof ANSWER_ROOM,
  repoint?: Repoint,
): Promise<void> => {
  const witnessed = file === ANSWER_ROOM;
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
    const program = await resolveLocalProgram(
      (resolver) => host.harness.resolve(resolver),
      { main: join(ROOT, "cfc-exchange-rules", file), root: ROOT },
    );
    const compiled = await host.patternManager.compilePattern(program, {
      space: S,
    });
    const startRoom = async (cause: string) => {
      const start = host.edit();
      const piece = host.getCell<Record<string, unknown>>(
        S,
        cause,
        undefined,
        start,
      );
      host.run(start, compiled, {}, piece);
      host.prepareTxForCommit(start);
      expect((await start.commit()).error).toBeUndefined();
      await host.idle();
      await host.storageManager.synced();
      return piece.withTx(undefined);
    };
    const room = await startRoom(file);

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

    // Code of a member's own, which is not `propose`, writing to the room.
    const asMember = (write: (tx: IExtendedStorageTransaction) => void) =>
      host.editWithRetry((tx) => {
        setCfcImplementationIdentity(tx, {
          kind: "verified",
          moduleIdentity: "sha256:member-code",
          symbol: "repointRoom",
          bindingPath: ["repointRoom"],
        });
        write(tx);
      });
    // The room's argument document, which holds its `terms` and `policy`.
    const argument = room.getArgumentCell<unknown>()!;
    // A cell at `path` in that document, by its bare link and through
    // `schema`, which declares no claim: whether the write is refused is the
    // stored claim's to say.
    const bare = (
      path: string[],
      schema: JSONSchema,
      tx: IExtendedStorageTransaction,
    ) => {
      const { schema: _schema, ...link } = argument.getAsNormalizedFullLink();
      return host.getCellFromLink(
        { ...link, path: [...link.path, ...path] },
        schema,
        tx,
      );
    };
    const expectClaimRefused = (error: unknown) =>
      expect(error).toMatchObject({
        name: "CfcCommitRefusalError",
        reasons: [expect.stringMatching(/^writeAuthorizedBy failed at /)],
      });
    // The claims the runtime stored for the argument document, as the commit
    // reads them: `terms` and `policy` each name `propose`, of the module
    // `moduleIdentity` when given, as their writer. Returns both claims.
    const expectClaimsStored = (moduleIdentity?: string) => {
      const link = argument.getAsNormalizedFullLink();
      const tx = host.edit();
      let stored: ReturnType<typeof loadStoredCfcEnvelope>;
      try {
        stored = loadStoredCfcEnvelope(tx, {
          space: link.space,
          id: link.id,
          scope: link.scope,
        });
      } finally {
        tx.abort();
      }
      expect(stored.status).toBe("loaded");
      type Node = { $ref?: string; ifc?: { writeAuthorizedBy?: unknown } };
      const schema = (stored as {
        schema?: {
          $defs?: Record<string, Node>;
          properties?: Record<string, Node>;
        };
      }).schema;
      // Each field's schema is a reference to the type the pattern names.
      const resolved = (node: Node | undefined) =>
        node?.$ref?.startsWith("#/$defs/")
          ? schema?.$defs?.[node.$ref.slice("#/$defs/".length)]
          : node;
      const claims = ["terms", "policy"].map((field) =>
        resolved(schema?.properties?.[field])?.ifc?.writeAuthorizedBy
      );
      for (const claim of claims) {
        expect(claim).toEqual({
          __ctWriterIdentityOf: expect.objectContaining({
            path: ["propose"],
            moduleIdentity: moduleIdentity ?? expect.any(String),
          }),
        });
      }
      return claims;
    };

    // The claims as stored at the room's creation, before anything has
    // written either slot.
    let claimsAtCreation: unknown[] | undefined;
    if (repoint === "early") {
      claimsAtCreation = expectClaimsStored();
      // A member's code writes terms naming its own seat alone into the
      // absent slot, and a policy into the other, for `propose` to find
      // written and leave alone.
      expectClaimRefused(
        (await asMember((tx) =>
          bare(["terms"], { type: "object" }, tx).set({
            question: "Where should we eat?",
            seats: [host.getCellFromLink(seats[1])],
          } as never)
        )).error,
      );
      expectClaimRefused(
        (await asMember((tx) =>
          bare(["policy"], { type: "boolean" }, tx).set(false as never)
        )).error,
      );
      await host.idle();
      expect(room.key("terms").get()).toBeUndefined();
      expect(room.key("policy").get()).toBeUndefined();
    }

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
    const seal = async (
      identity: Identity,
      ratings: string[],
      into = room,
      seated = [alice.did(), bob.did()],
    ) => {
      const runtime = runtimeFor(identity, trust);
      const home = identity.did();
      const tx = runtime.edit();
      // A draft of its own per room, so a second seal does not rewrite the
      // first's from a runtime that has not read it.
      const draft = runtime.getCell(home, [
        "stance-draft",
        into.getAsNormalizedFullLink().id,
      ], {
        type: "object",
        ifc: { confidentiality: [cfcAtom.user(home)] },
      } as never, tx);
      draft.set({ ratings } as never);
      expect((await tx.commit()).error).toBeUndefined();
      const own = (cell: Cell<unknown>) => runtime.getCellFromLink(cell);
      const prepared = await prepareCustodySeal(draft.withTx(undefined), {
        terms: own(into.key("terms")),
        policy: own(into.key("policy")),
        box: own(into.key("box")),
      }, { allowedSources: [] });
      expect((prepared.terms as { seats: string[] }).seats).toEqual(seated);
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

    // Of what the pattern computes from the box, only the projector's
    // answer leaves the policy. The demo room's rule drops the policy's
    // clause, so a reader of the room is shown the projection; the answer
    // room's rule releases it to the seal alone, so a reader is shown only
    // what the seal publishes from it. A member's rating, read from the same
    // box by other code, stays sealed either way.
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
    // The demo room's rule releases the projection to the room's readers;
    // the answer room's releases it to the seal alone, which publishes it.
    expect(shownTo(bob.did(), room.key("choice"))).toBe(!witnessed);
    expect(shownTo(bob.did(), room.key("rating"))).toBe(false);

    // The host publishes the answer once, as `cf-custody-answer` asks it to,
    // and shows what the seal published. A rule naming the projector alone
    // is refused.
    const hostRoom = { terms: room.key("terms"), policy: room.key("policy") };
    const publish = () => publishCustodyAnswer(hostRoom, room.key("choice"));
    if (!witnessed) {
      await expect(publish()).rejects.toThrow("requires the seal's witness");
      return;
    }
    const published = await publish();
    expect(published.value).toBe("pizza");
    expect(await readCustodyAnswer(hostRoom)).toBe("pizza");
    // The published slot is what a reader of the room is shown.
    await published.answer.sync();
    expect(shownTo(bob.did(), published.answer)).toBe(true);

    if (repoint === "early") {
      // The room's own proposal was the one that landed, and the claims are
      // those stored at its creation, naming the `propose` of the module
      // whose policy the room declares.
      expect(
        (room.key("terms").get() as { seats?: unknown[] } | null)?.seats,
      ).toHaveLength(2);
      expect(expectClaimsStored(declared!.moduleIdentity)).toEqual(
        claimsAtCreation,
      );
      return;
    }

    if (repoint !== undefined) {
      // A room of the same pattern in the same space, which Bob seals alone
      // and publishes. Its policy is the answer room's, and so are its terms
      // but for the seats: the instance whose slot a member would have the
      // room show.
      const lone = await startRoom(`${file}-lone`);
      lone.key("propose").send({
        seats: [host.getCellFromLink(seats[1])],
      } as never);
      await host.idle();
      await host.storageManager.synced();
      await seal(bob, ["no", "yes", "no"], lone, [bob.did()]);
      await waitForCellValue<string>(
        host,
        lone.key("choice"),
        (value) => value === "sushi",
        { stuckLabel: "the one-seat room's answer" },
      );
      const loneRoom = { terms: lone.key("terms"), policy: lone.key("policy") };
      expect(
        (await publishCustodyAnswer(loneRoom, lone.key("choice"))).value,
      ).toBe("sushi");

      const proposeAlone = () =>
        room.key("propose").send({
          seats: [host.getCellFromLink(seats[1])],
        } as never);
      const refusals: unknown[] = [];
      switch (repoint) {
        case "propose":
          // The room's own handler, run again with the member's seat alone.
          proposeAlone();
          break;
        case "terms": {
          // The one-seat room's terms written over the room's.
          const loneTerms = lone.key("terms").resolveAsCell().getRaw();
          refusals.push(
            (await asMember((tx) =>
              bare(["terms"], { type: "object" }, tx).set(loneTerms as never)
            )).error,
          );
          break;
        }
        case "seats":
          // The room's seats narrowed to the member's own.
          refusals.push(
            (await asMember((tx) =>
              bare(["terms", "seats"], { type: "array" }, tx).set(
                [host.getCellFromLink(seats[1])] as never,
              )
            )).error,
          );
          break;
        case "extra":
          // A field added beneath the room's terms.
          refusals.push(
            (await asMember((tx) =>
              bare(["terms", "extra"], { type: "number" }, tx).set(1 as never)
            )).error,
          );
          break;
        case "clear":
          // The room's terms cleared, so that `propose` writes them again.
          for (const cleared of [null, undefined]) {
            refusals.push(
              (await asMember((tx) =>
                bare(["terms"], { type: ["object", "null"] }, tx).set(
                  cleared as never,
                )
              )).error,
            );
          }
          await host.idle();
          proposeAlone();
          break;
        case "policy":
          // The room's policy cell holding another policy's reference, with
          // the room space as its subject, which the host reads in place of
          // the reference its label carries.
          refusals.push(
            (await asMember((tx) =>
              bare(["policy"], {}, tx).set({
                ...declared,
                policyDigest: `sha256:${"0".repeat(64)}`,
              } as never)
            )).error,
          );
          break;
      }
      await host.idle();
      await host.storageManager.synced();
      // What the room shows is still the answer its members sealed: not the
      // one-seat room's, and not a slot that is empty or refused.
      expect(await readCustodyAnswer(hostRoom)).toBe("pizza");
      // The member's write was refused, and `propose` wrote nothing again.
      for (const refusal of refusals) expectClaimRefused(refusal);
      expect(
        (room.key("terms").get() as { seats?: unknown[] } | null)?.seats,
      ).toHaveLength(2);
      return;
    }

    // The room's own result must not answer a question the published answer
    // does not. A member's code points the box at a record repeating
    // Alice's entry, whose answer happens to equal the published one, so the
    // projector's output does not change. Were that output readable, whether
    // it is still shown would tell the member what Alice's stance alone
    // yields: one bit per record.
    const repeatedAlice = await host.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "repointBox",
        bindingPath: ["repointBox"],
      });
      const record = host.getCell(S, "crafted-box-alice", {
        type: "object",
        ifc: { confidentiality: [cfcAtom.space(S)] },
      } as never, tx);
      const entry = host.getCellFromLink(
        { ...sealed.box.getAsNormalizedFullLink(), path: [sealed.entryKey] },
        undefined,
        tx,
      );
      record.set({ first: entry, second: entry } as never);
      room.key("box").withTx(tx).set(record as never);
    });
    expect(repeatedAlice.error).toBeUndefined();
    await host.idle();
    await host.storageManager.synced();
    // Its answer is the same, so whether or not the projector has run over
    // the record yet, the output holds the published answer under the stamp
    // the honest run earned, while the box points elsewhere: the state that
    // answered the question. The room's readers still cannot read it.
    const choiceIntegrity = (cfcLabelViewForResolvedCell(room.key("choice"))
      ?.entries ?? [])
      .filter((entry) => entry.path.length === 0)
      .flatMap((entry) => entry.label.integrity ?? []);
    expect(room.key("choice").get()).toBe("pizza");
    expect(
      choiceIntegrity.some((atom) =>
        (atom as { type?: string; inputWitness?: unknown }).type ===
          CFC_ATOM_TYPE.TransformedBy &&
        (atom as { inputWitness?: unknown }).inputWitness !== undefined
      ),
    ).toBe(true);
    expect(shownTo(bob.did(), room.key("choice"))).toBe(false);

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
    // What the room shows is the published answer, which has not moved, and
    // the host publishes nothing again.
    await expect(publish()).rejects.toThrow("already published");
    expect(await readCustodyAnswer(hostRoom)).toBe("pizza");
  } finally {
    for (const runtime of runtimes) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers) await manager.close();
    await server.close();
  }
};

describe("sealed custody through a pattern", () => {
  it("seals two members' stances into the answer room, and publishes its answer once", async () => {
    // The projector reads the box through the room's `box`, which holds the
    // link the seal wrote, so everything it read carries the seal's stamp.
    await sealAndRelease(ANSWER_ROOM);
  });

  it("releases the demo-grade room's answer, and publishes nothing under its rule naming the projector alone", async () => {
    await sealAndRelease(PROJECTOR);
  });

  it("shows the published answer still when a member's code runs `propose` again with its own seat alone", async () => {
    await sealAndRelease(ANSWER_ROOM, "propose");
  });

  it("shows the published answer still when a member's code writes the terms of a room it sealed alone over the room's", async () => {
    await sealAndRelease(ANSWER_ROOM, "terms");
  });

  it("shows the published answer still when a member's code narrows the seats beneath the room's terms to its own", async () => {
    await sealAndRelease(ANSWER_ROOM, "seats");
  });

  it("shows the published answer still when a member's code adds a field beneath the room's terms", async () => {
    await sealAndRelease(ANSWER_ROOM, "extra");
  });

  it("shows the published answer still when a member's code clears the room's terms and runs `propose` again", async () => {
    await sealAndRelease(ANSWER_ROOM, "clear");
  });

  it("shows the published answer still when a member's code writes another policy's reference over the room's policy", async () => {
    await sealAndRelease(ANSWER_ROOM, "policy");
  });

  it("stores the room's writer claims from its creation, and refuses a member's terms and policy written before `propose`", async () => {
    await sealAndRelease(ANSWER_ROOM, "early");
  });
});
