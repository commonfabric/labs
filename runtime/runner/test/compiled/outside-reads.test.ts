import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type DID, Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { ACLManager } from "../../src/acl-manager.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { wakeOnOutsideReads } from "../../src/compiled/outside-reads.ts";
import {
  resumeCompiledPieceFromBasis,
  type ResumedPiece,
} from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/space-members.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/space-members.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Held = { members: number };

// `fixtures/space-members.tsx` counts the members of the space, which the
// runtime answers from the access list of the space: a document the
// executor does not read, so the basis of the piece does not name it.
describe("a compiled piece resumed from a basis that matches, whose built-in read a document the basis does not name", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let resumes: ResumedPiece[];
  let cancels: (() => void)[];

  /** A serving runtime on a session of its own of the shared server. */
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

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece outside reads");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
    resumes = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    for (const resumed of resumes) resumed.stop();
    for (const piece of pieces) piece.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    await shared.close();
  });

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
    await runtime.scheduler.idleWithPendingCommits();
  };

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

  /** What the storage holds at `members` of the result, as `runtime` reads it. */
  const membersOf = (runtime: Runtime, result: Cell<Held>) =>
    runtime.getCellFromLink(result.getAsNormalizedFullLink()).key("members")
      .get();

  it("wakes when the document the built-in read changes", async () => {
    const first = session();
    await new ACLManager(first, space).set(space, "OWNER");
    const notes = first.getCell<string[]>(space, "notes");
    await commit(first, (tx) => notes.withTx(tx).set(["one"]));
    const result = first.getCell<Held>(space, "members of the space");
    const compiled = await artifact();
    await commit(first, (tx) => {
      pieces.push(
        startCompiledPiece(
          first,
          tx,
          compiled,
          { notes },
          result.withTx(tx),
          { actsFor: space },
        ),
      );
    });
    await settled(first);
    expect(membersOf(first, result)).toBe(1);
    pieces.splice(0)[0].stop();
    await settled(first);
    await first.dispose();
    runtimes.splice(0);

    const second = session();
    const resultCell = second.getCellFromLink<Held>(
      result.getAsNormalizedFullLink(),
    );
    const resumed = await resumeCompiledPieceFromBasis(
      second,
      compiled,
      resultCell,
      { actsFor: space },
    );
    resumes.push(resumed);
    expect(resumed.current).toBe(true);
    cancels.push(await wakeOnOutsideReads(second, resultCell, resumed));

    // Another member is added to the access list of the space.
    const other = (await Identity.fromPassphrase("compiled piece a member"))
      .did() as DID;
    await new ACLManager(second, space).set(other, "READ");

    pieces.push(await resumed.woken);
    await settled(second);
    expect(membersOf(second, resultCell)).toBe(2);
  });
});
