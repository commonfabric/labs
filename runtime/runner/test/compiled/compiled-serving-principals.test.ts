import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import type { CompiledPiece } from "../../src/compiled/piece.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import {
  type PatternProgram,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

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

describe("the actor of an event of a compiled piece under the serving loop", () => {
  // `fixtures/principal-integrity.tsx`: the state cell `signed` declares
  // `AuthoredByCurrentUser<WriteAuthorizedBy<string, typeof sign>>`, and the
  // handler `sign` writes it.

  let alice: Identity;
  let bob: Identity;
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];

  beforeEach(async () => {
    alice = await Identity.fromPassphrase("compiled piece actor alice");
    bob = await Identity.fromPassphrase("compiled piece actor bob");
    space = alice.did();
    serving = await listenCompiledServingMemoryServer({
      // The crate's binary is not run here: what stands in its place
      // gives the artifact the crate emitted for the fixture.
      compile: async (program) => ({
        main: await artifactOf(program.main.slice(1, -".tsx".length)),
        artifacts: () => undefined,
      }),
    });
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await serving.host.close();
    for (const runtime of clients) await runtime.dispose();
    await serving.close();
  });

  /** A client of the serving memory server that acts as `signer`. */
  const client = (signer: Identity): Runtime => {
    const runtime = new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
    clients.push(runtime);
    return runtime;
  };

  type Held = { signed: string; sign: unknown };

  /** The result of the piece as `runtime` reads it, kept in sync. */
  const reading = (runtime: Runtime, name: string): Cell<Held> => {
    const cell = runtime.getCellFromLink<Held>(
      runtime.getCell<Held>(space, name).getAsNormalizedFullLink(),
    );
    cancels.push(cell.sink(() => {}));
    return cell;
  };

  /** Sends `text` to the stream `sign` as `runtime` and waits for it. */
  const sign = async (runtime: Runtime, read: Cell<Held>, text: string) => {
    (read.key("sign") as unknown as Cell<{ text: string }>).send({ text });
    await waitForCellValue<Held>(
      runtime,
      read,
      (value) => value?.signed === text,
      { stuckLabel: `a client reads the text \`${text}\`` },
    );
  };

  it("stores the integrity of the principal whose session sent the event, for each of two principals in turn", async () => {
    const first = client(alice);
    const second = client(bob);
    const program: PatternProgram = {
      main: "/principal-integrity.tsx",
      files: [{
        name: "/principal-integrity.tsx",
        contents: await Deno.readTextFile(
          fixture("principal-integrity", "tsx"),
        ),
      }],
    };
    const result = first.getCell<Held>(space, "signed result");
    const tx = first.edit();
    setUpCompiledPiece(first, tx, program, {}, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const asAlice = reading(first, "signed result");
    const asBob = reading(second, "signed result");
    for (
      const [runtime, read] of [[first, asAlice], [second, asBob]] as const
    ) {
      await waitForCellValue<Held>(
        runtime,
        read,
        (value) => value?.sign !== undefined,
        { stuckLabel: "a client reads the stream `sign`" },
      );
    }

    await sign(first, asAlice, "from alice");
    const [piece] = serving.pieces();
    const [served] = serving.runtimes();
    expect(piece.refusals).toEqual([]);
    expect(authorsOf(served, space, piece)).toEqual([alice.did()]);

    await sign(second, asBob, "from bob");
    expect(piece.refusals).toEqual([]);
    expect(authorsOf(served, space, piece)).toEqual([bob.did()]);
  });
});
