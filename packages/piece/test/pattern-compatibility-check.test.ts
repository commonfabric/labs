/**
 * Compatibility preflight collects issues without moving the source pointer,
 * restaging inputs, or saving candidate artifacts. Stored-value validation is
 * shared with setup, while enforcement runs inside the apply transaction. These
 * cases compare the verdicts and check that a refused preflight leaves the piece
 * intact.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("pattern compatibility check");

/** The piece's current source: one optional input, one output. */
function baseProgram(includeRetainedGraph = false): RuntimeProgram {
  const argumentsType = includeRetainedGraph
    ? "{ seed?: string; extra?: RetainedNode }"
    : "{ seed?: string }";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        ...(includeRetainedGraph
          ? [
            "type RetainedNode = { left?: RetainedNode; right?: RetainedNode; label?: string };",
          ]
          : []),
        `export default pattern<${argumentsType}, { label: string }>(`,
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: seed ?? 'unset',",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A later revision of the same contract: accepted. Its output is observably
 * different for the same stored argument, so applying it proves the swap
 * happened AND that the argument survived it.
 */
function compatibleProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }, { label: string }>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: `seen:${seed ?? 'unset'}`,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * Demands an input the stored argument does not carry and cannot default.
 * This is the shape that bricked home roots on estuary: a required field with
 * no default cannot migrate documents written before it existed.
 */
function incompatibleProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ required: number }, { label: string }>(",
        "  ({ required }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: String(required),",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * Narrows the declared OUTPUT type, which the argument/result subset proof
 * rejects. The stored argument stays valid, so this isolates the contract rule
 * from the stored-argument rule.
 */
function narrowedOutputProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }, { label: number }>(",
        "  () => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: 7,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * The CFC-labeled variants below exist because the three rules above all
 * reason about DECLARED types, and a fourth thing decides whether the setup
 * commit lands: the CFC schema envelope physically stored on the piece's
 * argument document. That envelope accumulates across every write the document
 * ever took, so it can carry claims no pattern ever declared — and the merge
 * against it rejects independently of every type-level check.
 *
 * A confidentiality label is what makes a document CFC-relevant at all
 * (without one, nothing stores an envelope and the merge never runs). It is
 * also the least entangled choice: an ownership label would demand matching
 * `represents-principal` integrity on every write, so these cases would fail
 * authorization before ever reaching the merge.
 */
const CFC_PRELUDE = [
  "import { Confidential, NAME, pattern } from 'commonfabric';",
  "const ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'SetsrcCompatibilityCheck',",
  "  subject: 'did:example:declared',",
  "} as const;",
  "type Label = readonly [typeof ATOM];",
];

/** The atom the pattern declares, as it lands in the stored envelope. */
const DECLARED_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SetsrcCompatibilityCheck",
  subject: "did:example:declared",
} as const;

/** An atom NO version of the pattern declares — only a later write carries it. */
const EXTRA_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SetsrcCompatibilityCheck",
  subject: "did:example:extra",
} as const;

/**
 * A CFC-labeled piece, in two revisions whose declared contracts are
 * IDENTICAL down to the label. Keeping them identical is what isolates the
 * envelope: any ifc difference between the two patterns is caught by the
 * contract proof instead (`argument.seed: ifc changed`), which would make a
 * CFC-envelope case pass for the wrong reason.
 */
function labelledProgram(label: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        ...CFC_PRELUDE,
        "interface Args { seed: Confidential<string, Label>; }",
        "export default pattern<Args, { label: string }>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        `    label: ${label},`,
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

const labelledBase = () => labelledProgram("seed");
const labelledNext = () => labelledProgram("`seen:${seed}`");

/**
 * A revision declaring a STRONGER label than the piece's stored envelope
 * carries: the stored envelope no longer covers the candidate's, so the fast
 * path is skipped and the real merge runs — and strengthening is exactly what
 * a merge accepts.
 */
function strengthenedProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        ...CFC_PRELUDE,
        "const EXTRA = {",
        "  type: 'https://commonfabric.org/cfc/atom/Resource',",
        "  class: 'SetsrcCompatibilityCheck',",
        "  subject: 'did:example:extra',",
        "} as const;",
        "type Stronger = readonly [typeof ATOM, typeof EXTRA];",
        "interface Args { seed: Confidential<string, Stronger>; }",
        "export default pattern<Args, { label: string }>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: seed,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A pattern whose result document carries an owner-protected field: `name`
 * may be written only by the handler `writer` names. `root` is the directory
 * the authored tree is grounded at, so the same tree compiles as
 * `/api/patterns/app/main.tsx` and as `/packages/patterns/app/main.tsx`, the
 * way the shell serves a system pattern and a checkout supplies it.
 *
 * `writer` is the name of the handler binding, and so the binding path the
 * writer claim records. Two programs that differ only in it declare the same
 * result, with the claim at `/name` naming a different binding.
 */
function writerProgram(root: string, writer = "setName"): RuntimeProgram {
  return {
    main: `${root}/app/main.tsx`,
    files: [
      {
        name: `${root}/app/main.tsx`,
        contents: [
          "/// <cts-enable />",
          "import {",
          "  handler,",
          "  pattern,",
          "  type Stream,",
          "  Writable,",
          "  WriteAuthorizedBy,",
          "} from 'commonfabric';",
          "import { revision } from '../shared/revision.ts';",
          "",
          `const ${writer} = handler<`,
          "  { name: string },",
          "  { name: Writable<string> }",
          ">((event, state) => {",
          "  state.name.set(revision + ':' + event.name);",
          "});",
          "",
          "type Output = {",
          `  name: WriteAuthorizedBy<string, typeof ${writer}>;`,
          "  setName: Stream<{ name: string }>;",
          "};",
          "",
          "export default pattern<{ seed?: string }, Output>(() => {",
          "  const name = new Writable<",
          `    WriteAuthorizedBy<string, typeof ${writer}>`,
          "  >('initial').for('name');",
          `  return { name, setName: ${writer}({ name }) };`,
          "});",
          "",
        ].join("\n"),
      },
      {
        name: `${root}/shared/revision.ts`,
        contents: "export const revision = 'v1';\n",
      },
    ],
  };
}

/**
 * A pattern whose result document carries a declared label with no writer
 * claim: `label` is confidential under `ATOM`. `comment` is source the
 * projection does not carry, so two revisions differing only in it bind the
 * same projection to the document; `expression` is what `label` computes,
 * and changing it re-mints the derived cell the projection links.
 * `argumentFields` adds optional inputs, which changes the argument schema
 * the projection's link to `seed` is bound under without changing what the
 * pattern computes.
 */
function labelledResultProgram(
  comment: string,
  expression = "seed",
  argumentFields = "",
): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        ...CFC_PRELUDE,
        comment,
        `interface Args { seed: Confidential<string, Label>; ${argumentFields} }`,
        "interface Out { label: Confidential<string, Label>; }",
        "export default pattern<Args, Out>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        `    label: ${expression},`,
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

describe("setsrc compatibility preflight", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  let spaceName: string;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    spaceName = `pattern-compat-check-${crypto.randomUUID()}`;
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const livePiece = async () =>
    await pieces.create(baseProgram(), { input: { seed: "hello" } });

  it("clears a source that can replace the current one", async () => {
    const piece = await livePiece();
    const report = await piece.checkPattern(compatibleProgram());

    expect(report.compatible).toBe(true);
    expect(report.message).toBe(undefined);
    expect(report.issues).toEqual({});
    // The verdict names the source it judged, so a caller can tell which
    // revision was cleared.
    expect(report.candidate.identity).toBeDefined();
  });

  for (const modeled of [false, true]) {
    it(`checks a piece with a ${modeled ? "modeled" : "unmodeled"} shared graph without expanding every path`, async () => {
      const program = baseProgram(modeled);
      const piece = await pieces.create(program, { input: { seed: "hello" } });
      const graphIds = new Set<string>();
      const depth = 12;
      const tx = runtime.edit();
      try {
        let next: Cell<unknown> = runtime.getCell(
          pieces.getSpace(),
          "retained-leaf",
          undefined,
          tx,
        );
        next.set({ label: "leaf" });
        graphIds.add(next.getAsNormalizedFullLink().id);
        for (let index = 0; index < depth; index++) {
          const node = runtime.getCell(
            pieces.getSpace(),
            `retained-node-${index}`,
            undefined,
            tx,
          );
          node.set({ left: next, right: next });
          graphIds.add(node.getAsNormalizedFullLink().id);
          next = node;
        }
        pieces.getArgument(piece.getCell()).withTx(tx).asSchema(undefined)
          .set({ seed: "hello", extra: next });
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
      } finally {
        if (tx.status().status === "ready") tx.abort();
      }
      await runtime.idle();
      const argumentBefore = pieces.getArgument(piece.getCell()).getRaw();
      const identityBefore = getPatternIdentityRef(piece.getCell());

      using reads = spy(runtime, "readTx");
      const compatible = await piece.checkPattern(program);
      const incompatible = await piece.checkPattern(incompatibleProgram());

      expect(compatible.compatible).toBe(true);
      expect(compatible.issues).toEqual({});
      expect(incompatible.compatible).toBe(false);
      expect(incompatible.issues.argument).toContain("required");
      expect(pieces.getArgument(piece.getCell()).getRaw()).toEqual(
        argumentBefore,
      );
      expect(getPatternIdentityRef(piece.getCell())).toEqual(identityBefore);

      const transactions = new Set(reads.calls.map((call) => call.returned));
      let totalReads = 0;
      let graphReads = 0;
      for (const transaction of transactions) {
        for (const read of transaction?.getReadActivities?.() ?? []) {
          totalReads++;
          if (graphIds.has(read.id)) graphReads++;
        }
      }
      // Bound actual storage reads, independent of CPU speed or heap limits.
      // The fixture stays small enough for a regression to fail without OOM.
      expect(totalReads).toBeGreaterThan(0);
      expect(graphReads).toBeLessThan(100 * graphIds.size);
    });
  }

  it("refuses a source whose contract the stored argument cannot satisfy", async () => {
    const piece = await livePiece();
    const report = await piece.checkPattern(incompatibleProgram());

    expect(report.compatible).toBe(false);
    expect(report.message).toBeDefined();
    // The reason is the rule's own words, not a paraphrase invented here.
    expect(report.message).toContain("required");
  });

  it("changes nothing — a refused check leaves the piece applying its old source", async () => {
    const piece = await livePiece();
    await runtime.idle();
    const before = JSON.stringify(piece.getCell().getAsQueryResult());
    const refBefore = getPatternIdentityRef(piece.getCell());

    await piece.checkPattern(incompatibleProgram());
    await runtime.idle();

    // The source pointer is the caller's invariant, so assert it directly
    // rather than inferring it from the rendered result.
    expect(getPatternIdentityRef(piece.getCell())).toEqual(refBefore);
    expect(JSON.stringify(piece.getCell().getAsQueryResult())).toBe(before);

    // And the piece still accepts a compatible source afterwards: the refused
    // check left no half-applied state behind to trip over. The new output
    // proves the swap landed; `hello` inside it proves the stored argument
    // came through unchanged.
    await piece.setPattern(compatibleProgram());
    await runtime.idle();
    expect((piece.getCell().getAsQueryResult() as { label?: string }).label)
      .toBe("seen:hello");
  });

  it("agrees with the apply path on the verdict and the cause", async () => {
    // The contract that keeps the preflight honest: a source the check refuses
    // is refused by `setPattern`, for the same underlying reason.
    //
    // Preflight reports its read-time snapshot; apply enforces the rules in
    // the setup transaction. Compare the verdict and cause rather than the
    // formatting of the two error reports.
    const piece = await livePiece();
    const report = await piece.checkPattern(incompatibleProgram());
    expect(report.compatible).toBe(false);

    const applied = await piece.setPattern(incompatibleProgram()).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    // Refused on both paths. The check explains why in the review's words; the
    // apply path reports in enforcement's, so only the verdict is compared.
    expect(applied).toBeDefined();
    expect(report.message).toContain("required");
  });

  /**
   * A live CFC-labeled piece whose stored argument envelope has been widened
   * past what any revision of the pattern declares.
   *
   * This is not a contrived shape: an envelope is the union of every write's
   * claims, and strengthening a label is always allowed, so any later writer
   * that presents a broader confidentiality leaves the document carrying more
   * than the pattern does. The piece is then partially migrated — its pattern
   * pointer is behind its own document — and that is the state where the three
   * type-level rules all pass and the setup commit still refuses.
   */
  const pieceWithWidenedEnvelope = async () => {
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();
    const argument = pieces.getArgument(piece.getCell());
    const { error } = await runtime.editWithRetry((tx) => {
      argument.withTx(tx).asSchema({
        type: "object",
        properties: {
          seed: {
            type: "string",
            ifc: { confidentiality: [DECLARED_ATOM, EXTRA_ATOM] },
          },
        },
      } as never).set({ seed: "hello" } as never);
    });
    expect(
      error?.message,
      "the fixture could not widen the stored envelope, so the case below " +
        "would pass for want of a merge to fail rather than because the " +
        "check works",
    ).toBeUndefined();
    await runtime.idle();
    return piece;
  };

  it("does not blame the envelope for a merge that actually succeeds", async () => {
    // The stored envelope does not COVER a candidate that strengthens its
    // label, so the fast path is skipped and the real merge runs. Strengthening
    // is what a merge accepts, so the envelope must not appear as a reason.
    //
    // Worth pinning separately from the "still matches" control: that case
    // returns early without ever consulting the merge, so it cannot tell a
    // working merge from one that is never reached. Here the merge runs and
    // has to come back clean.
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();

    const report = await piece.checkPattern(strengthenedProgram());

    expect(report.issues.cfc).toBe(undefined);
    // The contract proof is entitled to object to the changed label — this is
    // only asserting that the envelope check does not pile on a second,
    // spurious reason for the same edit.
    expect(report.issues.schema ?? "").not.toContain("envelope");
  });

  it("clears a CFC-labeled piece whose stored envelope still matches", async () => {
    // The control for the two cases below. Carrying a CFC envelope at all must
    // not make a piece un-swappable — otherwise the new rule reads as "any
    // labeled piece is incompatible" and operators learn to ignore it.
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();

    const report = await piece.checkPattern(labelledNext());
    expect(report.compatible).toBe(true);
    expect(report.issues).toEqual({});
  });

  it("refuses a source the piece's stored CFC envelope cannot merge with", async () => {
    const piece = await pieceWithWidenedEnvelope();
    const report = await piece.checkPattern(labelledNext());

    // Isolation is the claim: the contract proof, the stored-argument
    // validation and the retained-link proof ALL pass here — the two patterns
    // are identical and the stored value is a plain string. Only the envelope
    // rejects, so a check that stopped at the declared types would report this
    // source as safe to deploy.
    expect(report.issues.schema).toBe(undefined);
    expect(report.issues.argument).toBe(undefined);
    expect(report.issues.retainedLinks).toBe(undefined);
    expect(report.compatible).toBe(false);
    expect(report.issues.cfc).toBeDefined();
    // The reason is the merge's own words, not a paraphrase invented here —
    // it is the same sentence the commit rejection carries.
    expect(report.message).toContain("confidentiality cannot be weakened");
    expect(report.message).toContain("/seed");
  });

  it("predicts a real commit rejection, not a gate of its own", async () => {
    // The property that makes the verdict worth acting on. The override exists
    // precisely to bypass the preflight, so driving the apply path THROUGH it
    // reaches the enforcement layer itself: CFC still refuses the commit, over
    // the same weakening. The check is reporting something real.
    const piece = await pieceWithWidenedEnvelope();
    const report = await piece.checkPattern(labelledNext());
    expect(report.compatible).toBe(false);

    // The storage layer aborts with its own rejection shape rather than an
    // `Error`, so read the message off it directly — the point is WHOSE
    // rejection this is, and it is CFC enforcement's.
    const forced = await piece.setPattern(labelledNext(), {
      dangerouslyAllowIncompatibleSchema: true,
    }).then(
      () => undefined,
      (error: unknown) => (error as { message?: string })?.message,
    );
    expect(forced).toContain("CFC enforcement rejected commit");
    expect(forced).toContain("confidentiality cannot be weakened at /seed");

    // Apply enforces the same rule in its setup transaction. Its refusal and
    // preflight's report must name the same cause, regardless of formatting.
    const applied = await piece.setPattern(labelledNext()).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error ? error.message : JSON.stringify(error),
    );
    expect(applied).toBeDefined();
    // Both name the same underlying cause, in their own words. (The apply path
    // may reject with a bare CFC rejection object rather than an `Error`, so
    // compare text rather than asserting a type.)
    expect(report.message).toContain("confidentiality cannot be weakened");
    expect(applied).toContain("confidentiality cannot be weakened");
  });

  it("refuses a piece whose stored CFC envelope cannot be read at all", async () => {
    // An envelope that exists but will not load is the tempting thing to skip:
    // there is no merge to run, so "not applicable" reads as the honest
    // answer. It is not — the commit path records that same load failure as a
    // rejection reason and refuses the write, so skipping it green-lights a
    // swap the deploy then rejects.
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();

    // Serve a different schema at the content address the metadata names.
    // The commit boundary makes content-addressed documents immutable, so
    // the mismatched envelope this case guards against can only arise as
    // out-of-band store corruption — model exactly that, then read it
    // through a fresh replica: the already-synced one cannot see a
    // tampered store.
    const link = pieces.getArgument(piece.getCell())
      .getAsNormalizedFullLink();
    const metadata = readStoredCfcMetadata(runtime.readTx(), {
      space: link.space,
      id: link.id,
      scope: link.scope,
    });
    expect(
      metadata?.schemaHash,
      "the labeled fixture stored no CFC envelope, so there is nothing for " +
        "this case to poison",
    ).toBeDefined();
    const server = (storageManager as unknown as {
      server(): MemoryV2Server.Server;
    }).server();
    const engine = await server.engineForSpace(link.space);
    const forged = encodeMemoryBoundary({ value: { type: "string" } });
    engine.database.prepare(
      `UPDATE revision SET data = :data, seq = seq + 1 WHERE id = :id`,
    ).run({ data: forged, id: `cid:${metadata!.schemaHash}` });
    engine.database.prepare(
      `UPDATE head SET seq = seq + 1 WHERE id = :id`,
    ).run({ id: `cid:${metadata!.schemaHash}` });

    const freshStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: freshStorage,
    });
    try {
      const freshPieces = new PiecesController(
        await createSession({ identity: signer, spaceName }),
        freshRuntime,
      );
      await freshPieces.synced();
      const reloaded = await freshPieces.get(piece.id, false);
      // Under content-addressed schemas the forged document also fails sync
      // delivery verification, so the fresh replica cannot load the piece's
      // pattern identity at all — an even harder refusal than the graceful
      // report. The guarded principle is the same: corruption never
      // green-lights a swap.
      await expect(reloaded.checkPattern(labelledNext())).rejects.toThrow(
        "piece missing pattern identity",
      );
    } finally {
      await freshRuntime.dispose();
      await freshStorage.close();
    }
  });

  it("reports the blocker when the envelope names a schema document that is not there", async () => {
    // The case above poisons the DOCUMENT, and content-address verification
    // refuses the sync outright. This one severs the NAME instead: metadata
    // whose schemaHash nothing stored. The metadata rides on the argument
    // document — a regular document, delivered without objection — so the
    // load failure surfaces inside the review, which must degrade to the
    // graceful blocker rather than green-light the swap.
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();
    const link = pieces.getArgument(piece.getCell())
      .getAsNormalizedFullLink();
    const metadata = readStoredCfcMetadata(runtime.readTx(), {
      space: link.space,
      id: link.id,
      scope: link.scope,
    });
    expect(
      metadata?.schemaHash,
      "the labeled fixture stored no CFC envelope, so there is nothing for " +
        "this case to sever",
    ).toBeDefined();

    const server = (storageManager as unknown as {
      server(): MemoryV2Server.Server;
    }).server();
    const engine = await server.engineForSpace(link.space);
    const row = engine.database.prepare(
      `SELECT data FROM revision WHERE id = :id`,
    ).get({ id: link.id });
    const stored = decodeMemoryBoundary(row!.data!) as {
      cfc?: Record<string, unknown>;
    };
    const absentHash = internSchemaAsTaggedHashString({
      type: "string",
      title: "never-stored-envelope",
    });
    const severed = encodeMemoryBoundary({
      ...stored,
      cfc: { ...stored.cfc, schemaHash: absentHash },
    } as never);
    engine.database.prepare(
      `UPDATE revision SET data = :data, seq = seq + 1 WHERE id = :id`,
    ).run({ data: severed, id: link.id });
    engine.database.prepare(
      `UPDATE head SET seq = seq + 1 WHERE id = :id`,
    ).run({ id: link.id });

    const freshStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: freshStorage,
    });
    try {
      const freshPieces = new PiecesController(
        await createSession({ identity: signer, spaceName }),
        freshRuntime,
      );
      await freshPieces.synced();
      const reloaded = await freshPieces.get(piece.id, false);
      const report = await reloaded.checkPattern(labelledNext());
      expect(report.compatible).toBe(false);
      expect(report.issues.cfc).toBeDefined();
      expect(report.message).toContain("could not be read");
    } finally {
      await freshRuntime.dispose();
      await freshStorage.close();
    }
  });

  describe("the result document's stored writer claims", () => {
    // The argument cases above merge the envelope stored on the piece's
    // argument document. The setup transaction merges the envelope stored on
    // the piece's own document too — the result — and a profile's
    // owner-protected fields live there. A claim stamped onto that envelope
    // by the handler that wrote the field meets the candidate's claim at the
    // same path, and where the two name different bindings the commit is
    // refused with `writeAuthorizedBy must remain stable`. The verdict has to
    // come from the check, not from the deploy.
    //
    // Every case stamps the stored claim first, by having the bound handler
    // write the field once: a claim the setup declared but nothing wrote is
    // unstamped, and an unstamped claim reconciles with anything at its
    // path, so the merge these cases drive would never run.

    const servedRoot = "/api/patterns";
    const checkoutRoot = "/packages/patterns";

    const stampedPiece = async (program: RuntimeProgram) => {
      const piece = await pieces.create(program, { input: {} });
      await runtime.idle();
      const result = await piece.result.getCell();
      result.key("setName").send({ name: "stamped" });
      await result.pull();
      expect(
        await piece.result.get(["name"]),
        "the bound handler did not write the field, so the stored claim " +
          "carries no stamp and the cases below have no merge to fail",
      ).toBe("v1:stamped");
      return piece;
    };

    it("reports the stored claim refusing a candidate that binds the field to another handler", async () => {
      const piece = await stampedPiece(writerProgram(servedRoot));
      const candidate = writerProgram(servedRoot, "assignName");

      const report = await piece.checkPattern(candidate);

      expect(report.compatible).toBe(false);
      expect(report.issues.cfc).toBeDefined();
      // The merge's own words: the same sentence the commit rejection carries.
      expect(report.issues.cfc).toContain(
        "writeAuthorizedBy must remain stable at /name",
      );

      // The override bypasses the contract proof, which objects to the
      // renamed binding on its own, and reaches the enforcement layer: CFC
      // refuses the commit over the stored claim, which is what the check
      // reported.
      const forced = await piece.setPattern(candidate, {
        dangerouslyAllowIncompatibleSchema: true,
      }).then(
        () => undefined,
        (error: unknown) => (error as { message?: string })?.message,
      );
      expect(forced).toContain("CFC enforcement rejected commit");
      expect(forced).toContain("writeAuthorizedBy must remain stable at /name");
    });

    it("clears the same tree compiled under another root, which the apply commits", async () => {
      // The production shape: the piece runs the tree the shell served under
      // `/api/patterns`, and the update supplies it from a checkout under
      // `/packages/patterns`. The contract proof passes, since it compares
      // neither the file spelling nor the module hash. The stored claim and
      // the candidate's are both stamped, each naming its module
      // content-addressed, and two stamps reconcile without comparing their
      // spellings, so the merge accepts the candidate and the update commits.
      // The check has to judge the candidate's born-stamped claim as the
      // merge does: a preflight that read it as unstamped would demand the
      // spelling correspondence and refuse an update the deploy accepts.
      const piece = await stampedPiece(writerProgram(servedRoot));
      const candidate = writerProgram(checkoutRoot);

      const report = await piece.checkPattern(candidate);
      expect(report.issues.cfc).toBe(undefined);
      expect(report.compatible).toBe(true);

      await piece.setPattern(candidate);
      await runtime.idle();
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(
        report.candidate.identity,
      );
    });
  });

  describe("the result projection setup would keep", () => {
    // Setup writes the result projection only where the candidate's differs
    // from the stored one, and the schema input the commit merges rides that
    // write. So a candidate whose projection is unchanged takes no result
    // merge at commit, whatever the stored envelope holds, and the check has
    // to ask setup's question before it merges that envelope in dry run — or
    // an implementation-only update over a partially migrated piece is
    // refused by the check and committed by the apply.
    //
    // The fixture widens the stored result envelope past what the pattern
    // declares, as the argument fixture above does, and writes the stored
    // projection back unchanged under the wider schema, so the envelope and
    // the projection can move independently of each other.

    const pieceWithWidenedResultEnvelope = async () => {
      const piece = await pieces.create(labelledResultProgram(""), {
        input: { seed: "hello" },
      });
      await runtime.idle();
      const cell = piece.getCell();
      const projection = JSON.stringify(cell.getRaw());
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).asSchema({
          type: "object",
          properties: {
            label: {
              type: "string",
              ifc: { confidentiality: [DECLARED_ATOM, EXTRA_ATOM] },
            },
          },
        } as never).set(cell.getRaw() as never);
      });
      expect(
        error?.message,
        "the fixture could not widen the stored result envelope, so the " +
          "cases below have no merge to fail",
      ).toBeUndefined();
      await runtime.idle();
      expect(
        JSON.stringify(cell.getRaw()),
        "the fixture changed the stored projection, so setup would rewrite " +
          "it and the cases below would not reach the elided write",
      ).toBe(projection);
      return piece;
    };

    it("clears a candidate whose projection setup would keep, which the apply commits", async () => {
      const piece = await pieceWithWidenedResultEnvelope();
      const candidate = labelledResultProgram(
        "// a revision the projection does not carry",
      );

      const report = await piece.checkPattern(candidate);
      expect(report.issues.cfc).toBe(undefined);
      expect(report.compatible).toBe(true);

      await piece.setPattern(candidate);
      await runtime.idle();
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(
        report.candidate.identity,
      );
    });

    it("clears a candidate that only adds an optional input, which the apply commits", async () => {
      // `label: seed` binds the projection to the argument document, and
      // setup re-points that link at the candidate's argument schema before
      // it compares projections. The link carries the result schema at its
      // own path, not the argument schema, so a candidate adding an optional
      // input leaves the projection as it was: setup writes nothing, the
      // commit merges nothing, and the check has to agree even over an
      // envelope the candidate's result schema could not merge with.
      const piece = await pieceWithWidenedResultEnvelope();
      const candidate = labelledResultProgram("", "seed", "extra?: string;");

      const report = await piece.checkPattern(candidate);
      expect(report.issues.cfc).toBe(undefined);
      expect(report.compatible).toBe(true);

      await piece.setPattern(candidate);
      await runtime.idle();
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(
        report.candidate.identity,
      );
    });

    it("refuses a candidate whose projection setup would rewrite over an envelope it cannot merge", async () => {
      // The control: re-minting the derived cell changes the projection, so
      // setup writes it, the commit merges the result schema, and the widened
      // envelope refuses the narrower declared label at both ends.
      const piece = await pieceWithWidenedResultEnvelope();
      const candidate = labelledResultProgram("", "`seen:${seed}`");

      const report = await piece.checkPattern(candidate);
      expect(report.compatible).toBe(false);
      expect(report.issues.cfc).toContain(
        "confidentiality cannot be weakened at /label",
      );

      const applied = await piece.setPattern(candidate).then(
        () => undefined,
        (error: unknown) => (error as { message?: string })?.message,
      );
      expect(applied).toContain("CFC enforcement rejected commit");
      expect(applied).toContain("confidentiality cannot be weakened at /label");
    });
  });

  it("still lets the dangerous override through", async () => {
    // `--dangerously-allow-incompatible-schema` exists for the case where the
    // operator knows better than the proof, and this new pre-check must not
    // become a second gate that ignores it.
    //
    // The override covers the CONTRACT proof, not the stored argument: a
    // candidate the argument cannot satisfy is still refused downstream at
    // setup (that is #5207's validation, independent of this change). So the
    // case to pin is a contract-only break — a narrowed output type, which the
    // subset proof rejects while the stored argument stays perfectly valid.
    const piece = await livePiece();
    expect((await piece.checkPattern(narrowedOutputProgram())).compatible)
      .toBe(false);

    await piece.setPattern(narrowedOutputProgram(), {
      dangerouslyAllowIncompatibleSchema: true,
    });
    await runtime.idle();
    expect((piece.getCell().getAsQueryResult() as { label?: unknown }).label)
      .toBe(7);
  });
});
