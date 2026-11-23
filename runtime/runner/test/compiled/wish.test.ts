import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import {
  PROFILE,
  profileSpace,
  seedHome,
} from "../../../../base/pattern-compiler/compare/wish-home.ts";
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { seedProfileOwner } from "../cfc-seed-envelope.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { resumeCompiledPiece } from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/wish-home.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/wish-home.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Wished = {
  greeting: string;
  about: string;
  count: number;
  matches: number;
  problem?: string;
  missing?: string;
  quiet?: string;
};

// The home is the one `seedHome()` writes for today's `wish`: the space of
// the user, whose root lists one profile, which is a document of a space of
// its own. No table of answers is given to the piece.
describe("a compiled piece whose pattern calls `wish`", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];

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
    signer = await Identity.fromPassphrase("compiled piece wish");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
  });

  afterEach(async () => {
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

  /** Seeds the home and starts the piece in `runtime`. */
  const started = async (runtime: Runtime) => {
    await seedHome(runtime, space);
    const result = runtime.getCell<Wished>(space, "wished result");
    const compiled = await artifact();
    let piece: CompiledPiece | undefined;
    await commit(runtime, (tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { note: "n" },
        result.withTx(tx),
        // The serving runtime of this test has no serving loop, which is
        // what names the principal a run acts for.
        { actsFor: space },
      );
      pieces.push(piece);
    });
    return { piece: piece!, result, compiled };
  };

  /**
   * Stores the claim that `profile` is the profile of the user, which the
   * runtime's `wish` requires of a profile it resolves to, and which a
   * write of the document by a transaction without the claim removes.
   */
  const owned = (runtime: Runtime, profile: Cell<unknown>) =>
    commit(
      runtime,
      (tx) => seedProfileOwner(tx, profile.getAsNormalizedFullLink(), space),
    );

  const valueOf = (piece: CompiledPiece): Wished =>
    piece.instance.result() as Wished;

  /** What the storage holds at a member of the result, links followed. */
  const stored = (runtime: Runtime, result: Cell<Wished>, key: keyof Wished) =>
    runtime.getCellFromLink(result.getAsNormalizedFullLink()).key(key).get();

  it("resolves a target of the home through the runtime's `wish`", async () => {
    const runtime = session();
    const { piece, result } = await started(runtime);

    expect(piece.refusals).toEqual([]);
    expect(valueOf(piece).greeting).toBe(`hello ${PROFILE.name}`);
    expect(valueOf(piece).about).toBe(`${PROFILE.name}: ${PROFILE.bio}`);
    expect(valueOf(piece).problem).toBeUndefined();
    expect(stored(runtime, result, "greeting")).toBe(`hello ${PROFILE.name}`);
  });

  it("resolves a target of the space, and reports a search with no match", async () => {
    const runtime = session();
    const { piece } = await started(runtime);

    expect(valueOf(piece).count).toBe(0);
    expect(valueOf(piece).matches).toBe(0);
    expect(valueOf(piece).missing).toMatch(/found matching "#nothingtagged"/);
  });

  it("derives again when the document the wish resolved to changes", async () => {
    const runtime = session();
    const { piece } = await started(runtime);
    expect(valueOf(piece).count).toBe(0);

    // `#mentionable` resolved to a list of the root of the space.
    await commit(
      runtime,
      (tx) =>
        runtime.getCell(space, space, undefined, tx).key("defaultPattern").key(
          "backlinksIndex",
        ).key("mentionable").set([{ title: "one" }] as never),
    );

    expect(piece.refusals).toEqual([]);
    expect(valueOf(piece).count).toBe(1);
  });

  it("derives again when the wish resolves to another document", async () => {
    const runtime = session();
    const { piece } = await started(runtime);

    // The home lists another profile in the place of the first.
    const inProfile = await profileSpace();
    const other = runtime.getCell<{ name: string }>(inProfile, "profile two");
    await commit(runtime, (tx) => other.withTx(tx).set({ name: "Grace" }));
    await owned(runtime, other);
    await commit(
      runtime,
      (tx) =>
        runtime.getCell(space, space, undefined, tx).key("defaultPattern").key(
          "profiles",
        ).set([other] as never),
    );

    expect(piece.refusals).toEqual([]);
    expect(valueOf(piece).greeting).toBe("hello Grace");
  });

  it("holds the answer after a resume in another runtime", async () => {
    const first = session();
    const { piece, result, compiled } = await started(first);
    expect(valueOf(piece).greeting).toBe(`hello ${PROFILE.name}`);
    piece.stop();
    pieces.splice(0);
    await settled(first);
    await first.dispose();
    runtimes.splice(0);

    const second = session();
    // The replica of the second runtime does not hold the profile, which
    // is in another space than the piece: the piece asks the storage.
    const resumed = await resumeCompiledPiece(
      second,
      compiled,
      second.getCellFromLink(result.getAsNormalizedFullLink()),
      { actsFor: space },
    );
    pieces.push(resumed);
    await settled(second);

    expect(resumed.refusals).toEqual([]);
    expect(valueOf(resumed).greeting).toBe(`hello ${PROFILE.name}`);
  });
});
