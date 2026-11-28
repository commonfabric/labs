/**
 * The reclassification a value's schema declares (`ifc.reclassify`, the
 * lowered form of `Reclassified`): commit preparation stores each `User`
 * clause of the flow join that the written piece's recorded creator alone may
 * release as `anyOf(User(creator), PolicyOf<rules>)`, behind the
 * `cfcPatternReclassification` and `pieceCreatorRecord` experimental flags.
 */

import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import {
  atomsOutsideCeiling,
  createRenderConfidentialityResolver,
  membershipSpacesInConfidentiality,
} from "../src/cfc/mod.ts";
import { createRuntimeCfcModulePolicySource } from "../src/cfc/policy-resolver.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("reclassify alice");
const bob = await Identity.fromPassphrase("reclassify bob");
const service = await Identity.fromPassphrase("reclassify service");
const space = alice.did();

/** A pattern with one argument field and nothing about any principal. */
const PIECE_SOURCE = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern<{ count: Writable<number> }, { count: number }>(",
  "  ({ count }) => ({ count }),",
  ");",
].join("\n");

/**
 * A pattern whose own lift reclassifies its secret argument under the
 * module's rules, which no runtime registers ahead: the write installs the
 * manifest in the space of the lift's output.
 */
const SHARING_SOURCE = `/// <cts-enable />
import { lift, pattern, type Reclassified } from "commonfabric";
import {
  cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
} from "commonfabric/cfc";
export const release = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
  post: { addAlternatives: [cfcPattern.user(v("user"))] },
});
export const rules = exchangeRules([release]);
const share = lift(
  (secret: string): Reclassified<string, typeof rules> => secret + "!",
);
export default pattern<{ secret: string }, { shared: string }>(
  ({ secret }) => ({ shared: share(secret) }),
);
`;

/**
 * `SHARING_SOURCE` with a lift that keeps some of its argument's items, as a
 * window over a list does, so the items it returns are the argument's own.
 */
const FILTERING_SOURCE = SHARING_SOURCE
  .replace(
    `const share = lift(
  (secret: string): Reclassified<string, typeof rules> => secret + "!",
);`,
    `type Item = { lat: number };
const share = lift(
  (secret: Item[]): Reclassified<Item[], typeof rules> =>
    secret.filter((item) => item.lat > 0),
);`,
  )
  .replace(
    "pattern<{ secret: string }, { shared: string }>",
    "pattern<{ secret: { lat: number }[] }, { shared: { lat: number }[] }>",
  );

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:reclassify-module",
  symbol: "shareRules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

/** The `PolicyOf<shareRules>` marker the compiler lowers. */
const POLICY_MARKER = {
  type: CFC_ATOM_TYPE.Policy,
  policyRefKind: "module",
  moduleIdentity: artifact.manifest.moduleIdentity,
  symbol: artifact.manifest.symbol,
  policyDigest: artifact.policyDigest,
  subject: { __ctOwningSpace: true },
} as const;

/** The marker with its subject resolved to `space`, as it is stored. */
const POLICY = { ...POLICY_MARKER, subject: space };

const secretSchema = (...owners: Identity[]): JSONSchema => ({
  type: "string",
  ifc: { confidentiality: owners.map((owner) => cfcAtom.user(owner.did())) },
});

const RECLASSIFIED_SCHEMA = {
  type: "string",
  ifc: { reclassify: [POLICY_MARKER] },
} as const satisfies JSONSchema;

describe("cfc-reclassify", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let names = 0;

  /** A runtime on the shared server, closed when the test ends. */
  const connect = (
    as: Identity,
    options: {
      reclassification?: boolean;
      creatorRecord?: boolean;
      servingPosture?: boolean;
    } = {},
  ): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(server, { as });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      ...(options.servingPosture ? { servingPosture: true } : {}),
      experimental: {
        pieceCreatorRecord: options.creatorRecord ?? true,
        cfcPatternReclassification: options.reclassification ?? true,
      },
    });
    runtime.registerCfcPolicyManifests(undefined, [artifact]);
    runtimes.push(runtime);
    return runtime;
  };

  /**
   * Creates a piece of `source` in `at` on `runtime`, in `tx` when given,
   * with `argument` as its argument, and returns its result cell once the
   * creation has landed.
   */
  const createPiece = async (
    runtime: Runtime,
    options: {
      tx?: IExtendedStorageTransaction;
      source?: string;
      argument?: (tx: IExtendedStorageTransaction) => unknown;
      at?: MemorySpace;
    } = {},
  ): Promise<Cell<unknown>> => {
    const tx = options.tx ?? runtime.edit();
    const at = options.at ?? space;
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: options.source ?? PIECE_SOURCE }],
    }, { space: at });
    const name = `piece-${names++}`;
    const argument = runtime.getCell<unknown>(at, `${name}-argument`);
    const result = runtime.getCell<unknown>(
      at,
      `${name}-result`,
      compiled.resultSchema,
    );
    argument.withTx(tx).set(options.argument?.(tx) ?? { count: 0 });
    runtime.run(tx, compiled, argument, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    return result;
  };

  /** Creates a piece as a served handler run acting for `actor` makes it. */
  const createPieceFor = async (actor: Identity): Promise<Cell<unknown>> => {
    const serving = connect(service, { servingPosture: true });
    const tx = serving.edit();
    stampWaveRunContext(tx, {
      actionId: "handler/reclassify",
      kind: "event-handler",
      eventId: "event-1",
      acting: { user: actor.did(), session: `${actor.did()}-session` },
    });
    setCfcTrustSnapshot(tx, serving.trustSnapshotForPrincipal(actor.did()));
    return await createPiece(serving, { tx });
  };

  /**
   * Creates a piece of `source` in `at` whose secret argument links
   * the cell `secret` of `space`, and returns the cell its lift writes, once
   * the lift has run.
   */
  const sharePiece = async (
    runtime: Runtime,
    secret: string,
    at: MemorySpace = space,
    source: string = SHARING_SOURCE,
  ): Promise<{ piece: Cell<unknown>; shared: Cell<unknown> }> => {
    const piece = await createPiece(runtime, {
      source,
      at,
      argument: (tx) => ({
        secret: runtime.getCell(space, secret, undefined, tx),
      }),
    });
    await runtime.idle();
    const shared = piece.key("shared" as never).resolveAsCell();
    await shared.pull();
    await runtime.idle();
    return { piece, shared };
  };

  /** Stores `value` in a new cell labeled `schema`, and returns its name. */
  const storeSecret = async (
    runtime: Runtime,
    schema: JSONSchema,
    value: string,
  ): Promise<string> => {
    const name = `secret-${names++}`;
    const tx = runtime.edit();
    runtime.getCell(space, name, schema, tx).set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    return name;
  };

  /** The module the pattern of the piece `piece` is defined in. */
  const patternModule = (piece: Cell<unknown>): string =>
    (piece.getMetaRaw("patternIdentity") as { identity: string }).identity;

  /**
   * Derives a value from the secret `source` into a computed cell, as a
   * lift's output is, written through `schema` by `identity` and belonging to
   * `piece` when given, and returns the derived cell once the write has
   * landed, or the commit's error. A computed cell is one no schema declares
   * a store policy on, so the derived label lands on it whole. `into` writes
   * the same cell again.
   */
  const deriveFrom = async (
    runtime: Runtime,
    source: string,
    options: {
      piece?: Cell<unknown>;
      identity?: ImplementationIdentity;
      schema?: JSONSchema;
      into?: Cell<unknown>;
      value?: unknown;
    } = {},
  ): Promise<{ derived: Cell<unknown>; error?: unknown }> => {
    const tx = runtime.edit();
    if (options.identity !== undefined) {
      setCfcImplementationIdentity(tx, options.identity);
    }
    const secret = runtime.getCell<string>(space, source, undefined, tx).get();
    const named = options.into?.getAsNormalizedFullLink() ?? (() => {
      const link = runtime.getCell(space, `derived-${names++}`)
        .getAsNormalizedFullLink();
      return {
        ...link,
        id: link.id.replace(/^of:/, "computed:") as typeof link.id,
      };
    })();
    const derived = runtime.getCellFromLink<unknown>(
      named,
      options.schema ?? RECLASSIFIED_SCHEMA,
      tx,
    );
    derived.set(options.value ?? `${secret}!`);
    if (options.piece !== undefined && options.into === undefined) {
      derived.setMetaRaw(
        "result",
        options.piece.getAsLink(),
        rawMetaWriteAuthorization,
      );
    }
    const { error } = await tx.commit().settled;
    return { derived, ...(error !== undefined ? { error } : {}) };
  };

  /** The verified identity of a writer defined in `moduleIdentity`. */
  const writer = (moduleIdentity: string): ImplementationIdentity => ({
    kind: "verified",
    moduleIdentity,
    symbol: "share",
  });

  /** Every label entry of the stored envelope of `cell`. */
  const storedEntries = (runtime: Runtime, cell: Cell<unknown>) => {
    const tx = runtime.edit();
    const metadata = readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
    tx.abort();
    return metadata?.labelMap.entries ?? [];
  };

  /** Every confidentiality clause the stored label of `cell` holds. */
  const storedConfidentiality = (
    runtime: Runtime,
    cell: Cell<unknown>,
  ): unknown[] =>
    storedEntries(runtime, cell).flatMap((entry) =>
      entry.label.confidentiality ?? []
    );

  const released = (owner: Identity, at: MemorySpace = space) => ({
    anyOf: [cfcAtom.user(owner.did()), { ...POLICY, subject: at }],
  });

  /** Whether `clause` names `owner` and a module policy subject to `at`. */
  const releasesTo = (clause: unknown, owner: Identity, at: MemorySpace) => {
    const alternatives = (clause as { anyOf?: unknown[] }).anyOf ?? [];
    return alternatives.length === 2 &&
      alternatives.some((alternative) =>
        JSON.stringify(alternative) ===
          JSON.stringify(cfcAtom.user(owner.did()))
      ) &&
      alternatives.some((alternative) =>
        (alternative as { type?: unknown }).type === CFC_ATOM_TYPE.Policy &&
        (alternative as { subject?: unknown }).subject === at
      );
  };

  beforeEach(() => {
    server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [service.did()],
    });
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.idle();
      await runtime.dispose();
    }
    for (const manager of managers) await manager.close();
    await server.close();
  });

  describe("a pattern's own lift", () => {
    it("stores the creator's `User` clause alone while the flag is off", async () => {
      const client = connect(alice, { reclassification: false });
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { shared } = await sharePiece(client, source);

      expect(shared.get()).toBe("fix!");
      const stored = storedConfidentiality(client, shared);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored.some((clause) => releasesTo(clause, alice, space)))
        .toBe(false);
    });

    it("stores nothing released with the flag on and the creator record off", async () => {
      const client = connect(alice, { creatorRecord: false });
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { shared } = await sharePiece(client, source);

      const stored = storedConfidentiality(client, shared);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored.some((clause) => releasesTo(clause, alice, space)))
        .toBe(false);
    });

    it("stores the creator's clause or its module's policy, keeping its `TransformedBy`", async () => {
      const client = connect(alice);
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { piece, shared } = await sharePiece(client, source);

      const entries = storedEntries(client, shared);
      const stored = entries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      );
      expect(stored.some((clause) => releasesTo(clause, alice, space)))
        .toBe(true);
      expect(stored).not.toContainEqual(cfcAtom.user(alice.did()));
      const integrity = entries.flatMap((entry) => entry.label.integrity ?? []);
      expect(integrity).toContainEqual(expect.objectContaining({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: expect.objectContaining({
          moduleIdentity: patternModule(piece),
        }),
      }));
    });

    it("stores the creator's clause or the policy on items it keeps from its argument", async () => {
      expect(FILTERING_SOURCE).toContain("secret.filter");
      const client = connect(alice);
      const source = await storeSecret(client, {
        type: "array",
        items: {
          type: "object",
          properties: { lat: { type: "number" } },
        },
        ifc: { confidentiality: [cfcAtom.user(alice.did())] },
      }, [{ lat: 1 }, { lat: -1 }, { lat: 2 }] as never);

      const { shared } = await sharePiece(
        client,
        source,
        space,
        FILTERING_SOURCE,
      );

      expect(shared.get()).toEqual([{ lat: 1 }, { lat: 2 }]);
      // The kept items are the lift's own values, not references into the
      // argument, whose own label would still say the creator alone.
      const entries = storedEntries(client, shared);
      expect(entries.filter((entry) => entry.origin === "link")).toEqual([]);
      const stored = entries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      );
      expect(stored.some((clause) => releasesTo(clause, alice, space)))
        .toBe(true);
      expect(stored).not.toContainEqual(cfcAtom.user(alice.did()));
    });

    it("installs its policy's manifest in the space of a piece placed elsewhere", async () => {
      const client = connect(alice);
      const elsewhere = bob.did();
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { shared } = await sharePiece(client, source, elsewhere);

      expect(shared.getAsNormalizedFullLink().space).toBe(elsewhere);
      // Stored outside the owner's space, both subjects are commitments
      // (label-metadata protection), which the release keeps as they are.
      const stored = storedConfidentiality(client, shared) as {
        anyOf?: { type: string; subject: unknown; policyDigest?: string }[];
      }[];
      const clause = stored.find((candidate) =>
        candidate.anyOf?.some((alternative) =>
          alternative.type === CFC_ATOM_TYPE.Policy
        )
      );
      expect(clause?.anyOf).toHaveLength(2);
      const user = clause!.anyOf!.find((alternative) =>
        alternative.type === CFC_ATOM_TYPE.User
      );
      expect(user?.subject).toEqual({ digestOf: expect.any(String) });
      expect(stored).not.toContainEqual(user);
      const policy = clause!.anyOf!.find((alternative) =>
        alternative.type === CFC_ATOM_TYPE.Policy
      ) as { policyDigest: string; subject: unknown };
      expect(policy.subject).toEqual({ digestOf: expect.any(String) });
      const installed = client.getCellFromEntityId(
        elsewhere,
        cfcPolicyManifestDocId(policy.policyDigest),
        [],
      );
      await installed.sync();
      expect(installed.get()).toMatchObject({
        policyDigest: policy.policyDigest,
      });
    });
    // Reduced from the two-browser share test
    // (patterns/integration/share-space-reclassify-two-browsers.test.ts).
    // The owner's secret is in the owner's space and the share elsewhere, so
    // the flow join is cross-space, and label-metadata protection commits
    // every subject on the stamped label, the policy's own included. The
    // display resolver lists the space the label was read from as a
    // membership candidate because the committed subject is its digest
    // (`membershipSpacesInConfidentiality` in `render-ceiling.ts`), and the
    // point query decides: a reader of that space sees the value, anyone else
    // does not, and nor does a reader when the label was read from elsewhere.
    it("releases a value placed elsewhere to a reader of that space at their display", async () => {
      const client = connect(alice);
      const elsewhere = bob.did();
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { shared } = await sharePiece(client, source, elsewhere);

      const stored = storedConfidentiality(client, shared) as never[];
      const policy = (stored as {
        anyOf?: { type: string; policyDigest?: string }[];
      }[])
        .flatMap((clause) => clause.anyOf ?? [])
        .find((alternative) => alternative.type === CFC_ATOM_TYPE.Policy)!;
      const installed = client.getCellFromEntityId(
        elsewhere,
        cfcPolicyManifestDocId(policy.policyDigest!),
        [],
      );
      await installed.sync();
      const reader = service.did();
      const resolverFor = (
        readerRole: (id: string) => "reader" | null,
        committedSubjectCandidates = true,
      ) =>
        createRenderConfidentialityResolver({
          actingPrincipal: reader,
          membershipProvider: {
            readerRole,
            load: () => Promise.resolve(),
            subscribe: () => () => {},
          },
          modulePolicyResolver: createRuntimeCfcModulePolicySource(client)
            .resolve,
          committedSubjectCandidates,
        });

      expect(atomsOutsideCeiling(
        resolverFor((id) => id === elsewhere ? "reader" : null)({
          confidentiality: stored,
          spaces: () => [elsewhere],
        }),
        [cfcAtom.user(reader)],
      )).toEqual([]);
      // A principal who does not read that space stays sealed out.
      expect(atomsOutsideCeiling(
        resolverFor(() => null)({
          confidentiality: stored,
          spaces: () => [elsewhere],
        }),
        [cfcAtom.user(reader)],
      )).not.toEqual([]);
      // Read from a space the subject is not the digest of, a reader of the
      // subject space stays sealed out too.
      expect(atomsOutsideCeiling(
        resolverFor((id) => id === elsewhere ? "reader" : null)({
          confidentiality: stored,
          spaces: () => [space],
        }),
        [cfcAtom.user(reader)],
      )).not.toEqual([]);
      // Without the dial the committed subject nominates nothing.
      expect(atomsOutsideCeiling(
        resolverFor((id) => id === elsewhere ? "reader" : null, false)({
          confidentiality: stored,
          spaces: () => [elsewhere],
        }),
        [cfcAtom.user(reader)],
      )).not.toEqual([]);
      // The committed subject nominates only a space the label was read from
      // whose digest it is; it is never opened.
      expect(membershipSpacesInConfidentiality(stored)).toEqual([]);
      expect(membershipSpacesInConfidentiality(stored, () => [space]))
        .toEqual([]);
      expect(
        membershipSpacesInConfidentiality(stored, () => [space, elsewhere]),
      ).toEqual([elsewhere]);
    });
  });

  describe("a write through a reclassifying schema", () => {
    it("stores the clause or the policy for a writer of the piece's pattern", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer(patternModule(piece)),
      });

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(released(alice));
      expect(stored).not.toContainEqual(cfcAtom.user(alice.did()));
    });

    it("keeps a clause naming another principal, and one either may read", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const either = {
        anyOf: [cfcAtom.user(alice.did()), cfcAtom.user(bob.did())],
      };
      const source = await storeSecret(client, {
        type: "string",
        ifc: { confidentiality: [cfcAtom.user(bob.did()), either] },
      }, "fix");
      const own = await storeSecret(client, secretSchema(alice), "own");

      const tx = client.edit();
      setCfcImplementationIdentity(tx, writer(patternModule(piece)));
      const a = client.getCell<string>(space, source, undefined, tx).get();
      const b = client.getCell<string>(space, own, undefined, tx).get();
      const link = client.getCell(space, `derived-${names++}`)
        .getAsNormalizedFullLink();
      const derived = client.getCellFromLink<string>(
        { ...link, id: link.id.replace(/^of:/, "computed:") as typeof link.id },
        RECLASSIFIED_SCHEMA,
        tx,
      );
      derived.set(`${a}${b}`);
      derived.setMetaRaw(
        "result",
        piece.getAsLink(),
        rawMetaWriteAuthorization,
      );
      expect((await tx.commit().settled).error).toBeUndefined();

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(released(alice));
      expect(stored).toContainEqual(cfcAtom.user(bob.did()));
      expect(stored).toContainEqual(either);
      expect(stored).not.toContainEqual(released(bob));
    });

    it("leaves the envelope as it was when the same value is written again", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");
      const identity = writer(patternModule(piece));
      const { derived } = await deriveFrom(client, source, { piece, identity });
      const before = storedEntries(client, derived);

      const again = await deriveFrom(client, source, {
        identity,
        into: derived,
      });

      expect(again.error).toBeUndefined();
      expect(storedEntries(client, derived)).toEqual(before);
    });

    it("keeps an existence entry first stored with the flag off", async () => {
      const off = connect(alice, { reclassification: false });
      const piece = await createPiece(off);
      const source = await storeSecret(off, secretSchema(alice), "fix");
      const identity = writer(patternModule(piece));
      const { derived } = await deriveFrom(off, source, { piece, identity });
      await off.idle();
      const on = connect(alice);
      const rewritten = on.getCellFromLink(derived.getAsNormalizedFullLink());
      await rewritten.sync();
      await on.getCell(space, source).sync();
      await on.getCellFromLink(piece.getAsNormalizedFullLink()).sync();

      const again = await deriveFrom(on, source, {
        identity,
        into: rewritten,
        value: "fix?",
      });

      expect(again.error).toBeUndefined();
      const entries = storedEntries(on, rewritten);
      const shape = entries.filter((entry) => entry.observes === "shape");
      const value = entries.filter((entry) => entry.observes !== "shape");
      expect(value.flatMap((entry) => entry.label.confidentiality ?? []))
        .toContainEqual(released(alice));
      // SC-4 freezes a path's existence entry at creation, so the shape
      // stays the creator's alone: PROPOSAL.md, Risks.
      expect(shape.flatMap((entry) => entry.label.confidentiality ?? []))
        .toContainEqual(cfcAtom.user(alice.did()));
    });

    it("releases nothing for a writer of another module", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer("cf:module/mallory"),
      });

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored).not.toContainEqual(released(alice));
    });

    it("releases nothing for an unattributed writer", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { derived } = await deriveFrom(client, source, { piece });

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored).not.toContainEqual(released(alice));
    });

    it("releases nothing for another writer that relies on the stored declaration", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");
      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer(patternModule(piece)),
      });

      const again = await deriveFrom(client, source, {
        identity: writer("cf:module/mallory"),
        schema: { type: "string" },
        into: derived,
        value: "fix?",
      });

      expect(again.error).toBeUndefined();
      expect(storedConfidentiality(client, derived)).toContainEqual(
        cfcAtom.user(alice.did()),
      );
    });

    it("refuses a declaration added to a stored envelope that had none", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");
      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer("cf:module/mallory"),
        schema: { type: "string" },
      });

      const again = await deriveFrom(client, source, {
        identity: writer(patternModule(piece)),
        into: derived,
        value: "fix?",
      });

      expect(JSON.stringify(again.error)).toContain(
        "is not in its stored envelope",
      );
    });

    it("refuses a declaration added to an existing document that stored no envelope", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");
      const tx = client.edit();
      const link = client.getCell(space, `derived-${names++}`)
        .getAsNormalizedFullLink();
      const plain = client.getCellFromLink<unknown>(
        { ...link, id: link.id.replace(/^of:/, "computed:") as typeof link.id },
        undefined,
        tx,
      );
      plain.set("plain");
      plain.setMetaRaw("result", piece.getAsLink(), rawMetaWriteAuthorization);
      expect((await tx.commit().settled).error).toBeUndefined();

      const again = await deriveFrom(client, source, {
        identity: writer(patternModule(piece)),
        into: plain,
        value: "fix?",
      });

      expect(JSON.stringify(again.error)).toContain(
        "is not in its stored envelope",
      );
    });

    it("refuses a stored declaration's path written under another policy", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");
      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer(patternModule(piece)),
      });
      const before = storedConfidentiality(client, derived);

      const again = await deriveFrom(client, source, {
        identity: writer(patternModule(piece)),
        schema: {
          type: "string",
          ifc: {
            reclassify: [{ ...POLICY_MARKER, policyDigest: "other-policy" }],
          },
        } as JSONSchema,
        into: derived,
        value: "fix?",
      });

      expect(again.error).toBeDefined();
      expect(storedConfidentiality(client, derived)).toEqual(before);
    });

    it("keeps the flag the runtime set when code reaching the transaction tries to turn it on", () => {
      const client = connect(alice, { reclassification: false });
      const tx = client.edit();

      expect(() => tx.setCfcPatternReclassification(true)).toThrow(
        "cannot be enabled",
      );
      expect(tx.getCfcState().patternReclassification).toBe(false);
      tx.abort();
    });

    it("refuses a malformed declaration with the flag off", async () => {
      const client = connect(alice, { reclassification: false });
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { error } = await deriveFrom(client, source, {
        schema: {
          type: "string",
          ifc: { reclassify: [POLICY_MARKER, POLICY_MARKER] },
        } as JSONSchema,
      });

      expect(JSON.stringify(error)).toContain(
        "exactly one compiler-lowered PolicyOf",
      );
    });

    it("releases nothing for a declaration beneath the written path", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer(patternModule(piece)),
        schema: {
          type: "object",
          properties: {
            inner: RECLASSIFIED_SCHEMA,
            other: { type: "string" },
          },
        },
        value: { inner: "fix!", other: "fix" },
      });

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored).not.toContainEqual(released(alice));
    });

    it("releases what a write beneath a nested declaration derives", async () => {
      const client = connect(alice);
      const piece = await createPiece(client);
      const source = await storeSecret(client, secretSchema(alice), "fix");
      const identity = writer(patternModule(piece));
      const schema = {
        type: "object",
        properties: { inner: RECLASSIFIED_SCHEMA },
      } as const satisfies JSONSchema;
      const { derived } = await deriveFrom(client, source, {
        piece,
        identity,
        schema,
        value: { inner: "" },
      });

      const tx = client.edit();
      setCfcImplementationIdentity(tx, identity);
      const secret = client.getCell<string>(space, source, undefined, tx).get();
      derived.withTx(tx).asSchema(schema).key("inner").set(`${secret}!`);
      expect((await tx.commit().settled).error).toBeUndefined();

      const inner = storedEntries(client, derived).filter((entry) =>
        entry.path.length === 1 && entry.path[0] === "inner"
      ).flatMap((entry) => entry.label.confidentiality ?? []);
      expect(inner).toContainEqual(released(alice));
      expect(inner).not.toContainEqual(cfcAtom.user(alice.did()));
    });

    it("releases nothing for a document of no piece", async () => {
      const client = connect(alice);
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { derived } = await deriveFrom(client, source, {
        identity: writer("cf:module/any"),
      });

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored).not.toContainEqual(released(alice));
    });

    it("releases nothing of a principal who did not create the piece", async () => {
      const client = connect(alice);
      const served = await createPieceFor(bob);
      const piece = client.getCellFromLink(served.getAsNormalizedFullLink());
      await piece.sync();
      expect(piece.getMetaRaw("creator")).toBe(bob.did());
      const source = await storeSecret(client, secretSchema(alice), "fix");

      const { derived } = await deriveFrom(client, source, {
        piece,
        identity: writer(patternModule(piece)),
      });

      const stored = storedConfidentiality(client, derived);
      expect(stored).toContainEqual(cfcAtom.user(alice.did()));
      expect(stored).not.toContainEqual(released(alice));
    });
  });
});
