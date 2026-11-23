import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/fetched.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/fetched.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Held = { title: string; status: string };

// The request of the effect is answered by the runtime's own `fetchJson`,
// whose request goes to `globalThis.fetch`, which the test replaces as the
// tests of the runtime's fetch built-ins do.
describe("a compiled piece whose pattern requests `fetchJson`", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let piece: CompiledPiece | undefined;
  let original: typeof globalThis.fetch;
  let asked: string[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece effect");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL("http://mock-test-server.local"),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    asked = [];
    original = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      asked.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({ title: new URL(url).pathname.slice(1) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    piece = undefined;
  });

  afterEach(async () => {
    globalThis.fetch = original;
    piece?.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  const settled = async () => {
    await runtime.scheduler.idleWithPendingCommits();
    await clock.settle();
    await runtime.scheduler.idleWithPendingCommits();
  };

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
  };

  const started = async () => {
    const url = runtime.getCell<string>(space, "fetched url");
    await commit((tx) =>
      url.withTx(tx).set("http://mock-test-server.local/first")
    );
    const result = runtime.getCell<Held>(space, "fetched result");
    const compiled = await artifact();
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { url },
        result.withTx(tx),
        {},
      );
    });
    return { url, piece: piece! };
  };

  it("derives from the result the runtime's built-in stored", async () => {
    const { piece } = await started();

    expect(piece.refusals).toEqual([]);
    expect(asked).toEqual(["http://mock-test-server.local/first"]);
    expect(piece.instance.result()).toMatchObject({
      title: "first",
      status: "settled",
    });
  });

  it("requests again when the request changes", async () => {
    const { url, piece } = await started();

    await commit((tx) =>
      url.withTx(tx).set("http://mock-test-server.local/second")
    );

    expect(piece.refusals).toEqual([]);
    expect(asked.at(-1)).toBe("http://mock-test-server.local/second");
    expect((piece.instance.result() as Held).title).toBe("second");
  });
});
