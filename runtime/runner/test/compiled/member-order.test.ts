import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  basisDocumentOf,
  basisPartDocumentOf,
} from "../../src/compiled/basis.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import {
  resumeCompiledPieceFromBasis,
  type ResumedPiece,
} from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage } from "./storage.ts";

/** The artifact of the pattern `default` of a fixture of the crate. */
const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Result = { names: string; madeNames: string; listed: string };

// `fixtures/member-order.tsx` gives the names of the members of a record as
// a text, read by a computation and by a handler. The runtime that wrote
// the record holds its members as they were written, and a runtime that
// reads it from the storage holds them in the order of their names.
describe("the order in which the value code of a compiled piece reads the members of a record", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let resumes: ResumedPiece[];

  /** A runtime on a session of its own of the shared server. */
  const session = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: shared.open(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    runtimes.push(runtime);
    return runtime;
  };

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece member order");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
    resumes = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    for (const resumed of resumes) resumed.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    await shared.close();
  });

  /** Commits what `write` writes in `runtime`. */
  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled(runtime);
  };

  const read = (runtime: Runtime, result: Cell<unknown>): Result => {
    const tx = runtime.edit();
    try {
      return JSON.parse(
        JSON.stringify(
          runtime.getCellFromLink(result.getAsNormalizedFullLink())
            .withTx(tx).get(),
        ),
      );
    } finally {
      tx.abort();
    }
  };

  const send = async (
    runtime: Runtime,
    result: Cell<unknown>,
    name: string,
    event: unknown,
  ) => {
    runtime.getCellFromLink(result.getAsNormalizedFullLink()).key(
      name as never,
    ).send(event as never);
    await settled(runtime);
  };

  /** Starts the fixture in `runtime` over a record written as `members`. */
  const started = async (runtime: Runtime, members: Record<string, string>) => {
    const record = runtime.getCell<Record<string, string>>(space, "record");
    await commit(runtime, (tx) => record.withTx(tx).set(members));
    const artifact = await artifactOf("member-order");
    const result = runtime.getCell<Record<string, unknown>>(space, "names");
    await commit(runtime, (tx) => {
      pieces.push(
        startCompiledPiece(
          runtime,
          tx,
          artifact,
          { record },
          result.withTx(tx),
        ),
      );
    });
    return { artifact, result };
  };

  it("is the order of the names in the runtime that wrote the record", async () => {
    const first = session();
    const { result } = await started(first, { zeta: "z", beta: "b" });

    await send(first, result, "put", { name: "alpha", value: "a" });
    await send(first, result, "list", {});

    expect(read(first, result)).toMatchObject({
      names: "alpha,beta,zeta",
      madeNames: "alpha,zeta",
      listed: "alpha,beta,zeta",
    });
  });

  it("is the same in a runtime that resumes the piece, whose wake writes no document of the result", async () => {
    const first = session();
    const { artifact, result } = await started(first, {
      zeta: "z",
      beta: "b",
    });
    await send(first, result, "put", { name: "alpha", value: "a" });
    await send(first, result, "list", {});
    const stored = read(first, result);
    for (const piece of pieces.splice(0)) piece.stop();
    await settled(first);
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);

    const second = session();
    const written: string[] = [];
    second.storageManager.subscribe({
      next(notification) {
        if (notification.type === "commit") {
          for (const { address } of notification.changes) {
            written.push(address.id);
          }
        }
        return undefined;
      },
    });
    const resumed = await resumeCompiledPieceFromBasis(
      second,
      artifact,
      second.getCellFromLink(result.getAsNormalizedFullLink()),
    );
    resumes.push(resumed);
    expect(resumed.current).toBe(true);
    const piece = await resumed.wake();
    await settled(second);

    const { id } = result.getAsNormalizedFullLink();
    const ofBasis = new Set([
      `of:${basisDocumentOf(id)}`,
      ...Array.from(
        { length: 256 },
        (_, part) => `of:${basisPartDocumentOf(id, part)}`,
      ),
    ]);
    expect(piece.refusals).toEqual([]);
    expect(written.filter((entity) => !ofBasis.has(entity))).toEqual([]);
    expect(read(second, result)).toEqual(stored);
    await send(second, result, "list", {});
    expect(read(second, result).listed).toBe("alpha,beta,zeta");
  });
});
