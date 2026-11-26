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
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcTrustSnapshot } from "../src/storage/extended-storage-transaction.ts";
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
    options: { reclassification?: boolean; servingPosture?: boolean } = {},
  ): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(server, { as });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      ...(options.servingPosture ? { servingPosture: true } : {}),
      experimental: {
        pieceCreatorRecord: true,
        cfcPatternReclassification: options.reclassification ?? true,
      },
    });
    runtime.registerCfcPolicyManifests(undefined, [artifact]);
    runtimes.push(runtime);
    return runtime;
  };

  /**
   * Creates a piece of `PIECE_SOURCE` in `space` on `runtime`, in `tx` when
   * given, and returns its result cell once the creation has landed.
   */
  const createPiece = async (
    runtime: Runtime,
    tx: IExtendedStorageTransaction = runtime.edit(),
  ): Promise<Cell<unknown>> => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PIECE_SOURCE }],
    }, { space });
    const name = `piece-${names++}`;
    const argument = runtime.getCell<{ count: number }>(
      space,
      `${name}-argument`,
      undefined,
    );
    const result = runtime.getCell<unknown>(
      space,
      `${name}-result`,
      compiled.resultSchema,
    );
    argument.withTx(tx).set({ count: 0 });
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
    return await createPiece(serving, tx);
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

  /**
   * Derives a value from the secret `source` into a new computed cell, as a
   * lift's output is, written through a schema that declares the
   * reclassification and belonging to `piece` when given, and returns the
   * derived cell once the write has landed. A computed cell is one no schema
   * declares a store policy on, so the derived label lands on it whole.
   */
  const deriveFrom = async (
    runtime: Runtime,
    source: string,
    piece?: Cell<unknown>,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const secret = runtime.getCell<string>(space, source, undefined, tx).get();
    const named = runtime.getCell(space, `derived-${names++}`)
      .getAsNormalizedFullLink();
    const derived = runtime.getCellFromLink<string>(
      {
        ...named,
        id: named.id.replace(/^of:/, "computed:") as typeof named.id,
      },
      RECLASSIFIED_SCHEMA,
      tx,
    );
    derived.set(`${secret}!`);
    if (piece !== undefined) {
      derived.setMetaRaw(
        "result",
        piece.getAsLink(),
        rawMetaWriteAuthorization,
      );
    }
    expect((await tx.commit().settled).error).toBeUndefined();
    return derived;
  };

  /** Every confidentiality clause the stored label of `cell` holds. */
  const storedConfidentiality = (
    runtime: Runtime,
    cell: Cell<unknown>,
  ): unknown[] => {
    const tx = runtime.edit();
    const metadata = readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
    tx.abort();
    return (metadata?.labelMap.entries ?? []).flatMap((entry) =>
      entry.label.confidentiality ?? []
    );
  };

  const released = (owner: Identity, at: MemorySpace = space) => ({
    anyOf: [cfcAtom.user(owner.did()), { ...POLICY, subject: at }],
  });

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
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

  it("stores the creator's `User` clause alone while the flag is off", async () => {
    const client = connect(alice, { reclassification: false });
    const piece = await createPiece(client);
    const source = await storeSecret(client, secretSchema(alice), "fix");

    const derived = await deriveFrom(client, source, piece);

    const stored = storedConfidentiality(client, derived);
    expect(stored).toContainEqual(cfcAtom.user(alice.did()));
    expect(stored).not.toContainEqual(released(alice));
  });

  it("stores the creator's `User` clause as that clause or the policy", async () => {
    const client = connect(alice);
    const piece = await createPiece(client);
    const source = await storeSecret(client, secretSchema(alice), "fix");

    const derived = await deriveFrom(client, source, piece);

    const stored = storedConfidentiality(client, derived);
    expect(stored).toContainEqual(released(alice));
    expect(stored).not.toContainEqual(cfcAtom.user(alice.did()));
  });

  it("keeps a clause naming another principal", async () => {
    const client = connect(alice);
    const piece = await createPiece(client);
    const source = await storeSecret(client, secretSchema(alice, bob), "fix");

    const derived = await deriveFrom(client, source, piece);

    const stored = storedConfidentiality(client, derived);
    expect(stored).toContainEqual(released(alice));
    expect(stored).toContainEqual(cfcAtom.user(bob.did()));
    expect(stored).not.toContainEqual(released(bob));
  });

  it("releases nothing for a document of no piece", async () => {
    const client = connect(alice);
    const source = await storeSecret(client, secretSchema(alice), "fix");

    const derived = await deriveFrom(client, source);

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

    const derived = await deriveFrom(client, source, piece);

    const stored = storedConfidentiality(client, derived);
    expect(stored).toContainEqual(cfcAtom.user(alice.did()));
    expect(stored).not.toContainEqual(released(alice));
  });
});
