import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage } from "./storage.ts";

const fixture = (name: string, extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/${name}.${extension}`,
    import.meta.url,
  );

/** The default pattern of `fixtures/<name>.tsx`. */
const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(name, "emit.json")),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

/**
 * The subjects of the `authored-by` atoms that the stored labels of the
 * state cell of `piece` hold, as `runtime` reads them.
 */
const authorsOf = (
  runtime: Runtime,
  space: MemorySpace,
  piece: CompiledPiece,
): unknown[] => {
  const [cell] = [...piece.instance.store.docs].filter(([, { kind }]) =>
    kind === "state cell"
  );
  const tx = runtime.edit();
  try {
    const metadata = readStoredCfcMetadata(tx, {
      space,
      id: piece.transactions.entityOf(cell[0]),
      scope: "space",
    });
    return (metadata?.labelMap.entries ?? []).flatMap(({ label }) =>
      (label.integrity ?? []).flatMap((atom) =>
        (atom as { kind?: unknown }).kind === "authored-by"
          ? [(atom as { subject?: unknown }).subject]
          : []
      )
    );
  } finally {
    tx.abort();
  }
};

describe("the actor of an event of a compiled piece, in a runtime in the serving posture with no serving loop", () => {
  // `fixtures/principal-integrity.tsx`: the state cell `signed` declares
  // `AuthoredByCurrentUser<WriteAuthorizedBy<string, typeof sign>>`, and the
  // handler `sign` writes it.

  let service: Identity;
  let space: MemorySpace;
  let runtime: Runtime;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    service = await Identity.fromPassphrase("compiled piece actor service");
    space = service.did();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: openStorage(service),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
  });

  /**
   * Starts the fixture `name` with `actsFor` and returns the piece, the
   * result cell and the error of the first commit.
   */
  const start = async (name: string, actsFor?: Identity) => {
    const result = runtime.getCell<Record<string, unknown>>(space, name);
    const tx = runtime.edit();
    const piece = startCompiledPiece(
      runtime,
      tx,
      await artifactOf(name),
      {},
      result.withTx(tx),
      // The test vouches for the artifact the crate emitted for the fixture.
      {
        attested: true,
        ...(actsFor === undefined ? {} : { actsFor: actsFor.did() }),
      },
    );
    pieces.push(piece);
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    await runtime.scheduler.idleWithPendingCommits();
    return { piece, result, error };
  };

  it("stores the integrity of the principal the harness names, and not that of the runtime's own identity", async () => {
    const carol = await Identity.fromPassphrase("compiled piece actor carol");
    const { piece, result, error } = await start(
      "principal-integrity",
      carol,
    );
    expect(error).toBeUndefined();

    result.key("sign").send({ text: "from carol" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals).toEqual([]);
    expect(piece.instance.result()).toMatchObject({ signed: "from carol" });
    expect(authorsOf(runtime, space, piece)).toEqual([carol.did()]);
  });

  it("stores the integrity of the principal the start acts for, for the first value of the state cell", async () => {
    // The piece is brought into being for the principal, as a piece of
    // today's path is for the principal whose transaction sets it up.
    const carol = await Identity.fromPassphrase("compiled piece actor carol");
    const { piece, error } = await start("principal-integrity", carol);

    expect(error).toBeUndefined();
    expect(authorsOf(runtime, space, piece)).toEqual([carol.did()]);
  });

  it("refuses the start of a piece whose first value adds integrity of the current principal where the start acts for no one", async () => {
    // The write of a handler whose event has no actor is refused the same
    // way: the scenario `fixtures/principal-integrity` of
    // `base/pattern-compiler/compare/both-paths-scenarios.ts` sends one.
    const { error } = await start("principal-integrity");

    expect(error?.message).toContain(
      "current-principal integrity requires the run's actor at /",
    );
  });

  it("refuses a derivation that writes a value declared as authored by the current user", async () => {
    // `fixtures/principal-derived.tsx`: the output `shouted` is computed
    // by a derivation, and its declared type adds integrity of the
    // current principal.

    const carol = await Identity.fromPassphrase("compiled piece actor carol");
    const { error } = await start("principal-derived", carol);

    // The start acts for the principal, so the refusal is of the writer:
    // a derivation is no writer a claim admits. Today's path holds a
    // computed output to no claim of the result type and commits; see the
    // scenario `fixtures/principal-derived`.
    expect(error?.message).toContain(
      "writeAuthorizedBy requires a trusted verified binding identity at /shouted",
    );
  });
});
