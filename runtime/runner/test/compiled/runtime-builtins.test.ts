import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type DID, Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { ACLManager } from "../../src/acl-manager.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/runtime-builtins.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/runtime-builtins.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Stamp = { by: string; key: string; level: string; text: string };
type Held = { last: Stamp; level: string; members: number };

// The piece is given no stand-in for a built-in: each is answered by the
// runtime's own function, which reads the acting principal from the run
// and the access list of the space from the storage.
describe("a compiled piece whose value code calls built-ins the runtime answers", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let other: DID;
  let piece: CompiledPiece;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece built-ins");
    space = signer.did();
    other = (await Identity.fromPassphrase("compiled piece another member"))
      .did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    await new ACLManager(runtime, space).set(space, "OWNER");
    const notes = runtime.getCell<string[]>(space, "notes");
    await commit((tx) => notes.withTx(tx).set(["one"]));
    const result = runtime.getCell<Held>(space, "built-ins result");
    const compiled = await artifact();
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { notes },
        result.withTx(tx),
        // The serving runtime of this test has no serving loop, which is
        // what names the principal a run acts for.
        { actsFor: space },
      );
    });
  });

  afterEach(async () => {
    piece?.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  };

  const held = (): Held => piece.instance.result() as Held;

  /** Sends `event` to the stream `record` of the result. */
  const record = async (event: { text: string }) => {
    const plan = piece.instance.plan as { bindings: { name: unknown }[] };
    const binding = plan.bindings.findIndex(({ name }) => name === "record");
    const stream = piece.instance.streams().find((one) =>
      one.binding === binding
    )!;
    const entity = piece.transactions.entityOfStream({
      binding: stream.binding,
      keys: stream.keys,
    })!;
    runtime.scheduler.queueEvent(
      { space, id: entity, path: [], scope: "space" },
      piece.transactions.encode(event),
    );
    await runtime.scheduler.idleWithPendingCommits();
  };

  it("gives a `computed` the level the access list grants", () => {
    expect(piece.refusals).toEqual([]);
    expect(held().level).toBe("OWNER");
    expect(held().members).toBe(1);
  });

  it("evaluates the `computed` again when the access list changes", async () => {
    await new ACLManager(runtime, space).set(other as DID, "READ");
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals).toEqual([]);
    expect(held().members).toBe(2);
    expect(held().level).toBe("OWNER");
  });

  it("gives a handler the acting principal, the key of the event and the level", async () => {
    await record({ text: "first" });

    expect(piece.refusals).toEqual([]);
    expect(held().last.by).toBe(space);
    expect(held().last.level).toBe("OWNER");
    expect(held().last.text).toBe("first");
    expect(held().last.key).toMatch(/^evk:/);
  });

  it("gives a handler no principal where nothing names the one the run acts for", async () => {
    piece.stop();
    const result = runtime.getCell<Held>(space, "built-ins with no principal");
    const compiled = await artifact();
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { notes: runtime.getCell<string[]>(space, "notes") },
        result.withTx(tx),
        {},
      );
    });

    await record({ text: "first" });

    expect(held().last.text).toBe("first");
    expect(held().last.by).toBe("nobody");
  });

  it("gives two events two keys", async () => {
    await record({ text: "first" });
    const first = held().last.key;
    await record({ text: "second" });

    expect(held().last.text).toBe("second");
    expect(held().last.key).not.toBe(first);
  });
});
