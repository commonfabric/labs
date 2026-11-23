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
      actsFor === undefined ? {} : { actsFor: actsFor.did() },
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

  it("stores no integrity of a principal for the first value of the state cell", async () => {
    const { piece, error } = await start("principal-integrity");

    expect(error).toBeUndefined();
    expect(authorsOf(runtime, space, piece)).toEqual([]);
  });

  it("refuses the write of a handler whose event has no actor", async () => {
    const { piece, result } = await start("principal-integrity");

    result.key("sign").send({ text: "from no one" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals.length).toBeGreaterThan(0);
    for (const refusal of piece.refusals) {
      expect(refusal).toContain(
        "current-principal integrity requires the run's actor at /",
      );
    }
    expect(piece.instance.result()).toMatchObject({ signed: "" });
  });

  it("refuses a derivation that writes a value declared as authored by the current user", async () => {
    // `fixtures/principal-derived.tsx`: the output `shouted` is computed
    // by a derivation, and its declared type adds integrity of the
    // current principal.

    const carol = await Identity.fromPassphrase("compiled piece actor carol");
    const { error } = await start("principal-derived", carol);

    expect(error?.message).toContain(
      "current-principal integrity requires the run's actor at /shouted",
    );
  });
});
