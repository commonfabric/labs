import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage } from "./storage.ts";

/** The default pattern of a file under `compare/fixtures/`. */
const artifactOf = async (file: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${file}`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

describe("a write policy of a compiled piece", () => {
  // `fixtures/write-policy.tsx`: the state cell `note` declares
  // `WriteAuthorizedBy<string, typeof record>`. The handlers `record` and
  // `overwrite` both write it.

  let space: MemorySpace;
  let runtime: Runtime;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece write policy");
    space = signer.did();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: openStorage(signer),
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
   * Starts a piece of `artifact` at the cell named `name` and commits it.
   * The test is host code that vouches for the artifact, the one the crate
   * emitted for the fixture, unless `attested` is `false`.
   */
  const start = async (
    name: string,
    artifact: Artifact,
    argument: unknown,
    attested = true,
  ): Promise<
    { piece: CompiledPiece; result: Cell<Record<string, unknown>> }
  > => {
    const result = runtime.getCell<Record<string, unknown>>(space, name);
    const tx = runtime.edit();
    const piece = startCompiledPiece(
      runtime,
      tx,
      artifact,
      argument,
      result.withTx(tx),
      attested ? { attested: true } : {},
    );
    pieces.push(piece);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
    return { piece, result };
  };

  it("commits the first derivation of the piece that declares it", async () => {
    const { piece } = await start(
      "notes",
      await artifactOf("write-policy.emit.json"),
      {},
    );

    expect(piece.refusals).toEqual([]);
    expect(piece.instance.result()).toMatchObject({ note: "" });
  });

  it("commits the write of the handler it names", async () => {
    const { piece, result } = await start(
      "notes",
      await artifactOf("write-policy.emit.json"),
      {},
    );

    result.key("record").send({ text: "written" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals).toEqual([]);
    expect(piece.counts.eventsRefused).toBe(0);
    expect(piece.instance.result()).toMatchObject({ note: "written" });
  });

  it("refuses the write of the handler it names where the caller that handed the artifact did not vouch for it", async () => {
    // Nothing checks `Body.code` of a handed artifact against a source, so
    // a handler of one is a writer with no identity.
    const { piece, result } = await start(
      "notes",
      await artifactOf("write-policy.emit.json"),
      {},
      false,
    );

    result.key("record").send({ text: "written" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals.length).toBeGreaterThan(0);
    for (const refusal of piece.refusals) {
      expect(refusal).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /",
      );
    }
    expect(piece.instance.result()).toMatchObject({ note: "" });
  });

  it("refuses the write of a handler no policy names as a writer with no identity, as today's path does", async () => {
    const { piece, result } = await start(
      "notes",
      await artifactOf("write-policy.emit.json"),
      {},
    );

    result.key("overwrite").send({ text: "overwritten" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals.length).toBeGreaterThan(0);
    for (const refusal of piece.refusals) {
      expect(refusal).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /",
      );
    }
    expect(piece.instance.result()).toMatchObject({ note: "" });
  });

  it("refuses the write of a handler of another compiled pattern that has the binding name and the module path of the handler it names", async () => {
    // `fixtures/write-policy-forged/write-policy.tsx` declares a handler
    // `record` in a module of the same path, and a policy of that module
    // names it. Its pattern is given the cell `note` of the first piece,
    // and its handler writes it.

    const first = await start(
      "notes",
      await artifactOf("write-policy.emit.json"),
      {},
    );
    const forged = await start(
      "forged",
      await artifactOf("write-policy-forged/write-policy.emit.json"),
      { note: first.result.key("note") },
    );

    forged.result.key("record").send({ text: "taken" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(forged.piece.refusals.length).toBeGreaterThan(0);
    for (const refusal of forged.piece.refusals) {
      expect(refusal).toContain("writeAuthorizedBy failed at /");
    }
    expect(first.piece.instance.result()).toMatchObject({ note: "" });
    expect(first.result.key("note").get()).toBe("");
  });
});
