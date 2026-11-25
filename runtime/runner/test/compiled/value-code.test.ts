import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import {
  type Artifact,
  Handle,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

/**
 * The pattern of `compare/fixtures/handler.tsx` as the crate emitted it,
 * with `change` applied to the text of its one module of value code.
 */
const artifactWith = async (
  change: (source: string) => string,
): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/handler.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  const artifact = patterns.find(({ name }) => name === "default")!;
  const [module] = artifact.code.modules;
  const changed = change(module.source);
  // A change that matched nothing would test the fixture as it is.
  expect(changed).not.toBe(module.source);
  module.source = changed;
  return artifact;
};

/** The statement of the handler body of the fixture that sets `last`. */
const SETS_LAST = "last.set(event.text + secret);";

// The handler of the fixture sets `last` and appends to `log`. Each case
// replaces a part of the module's text with code the crate does not emit
// for a checked module, and says what that code reaches.
describe("the value code of a compiled piece", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled value code");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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
    await storageManager.close();
  });

  /** Starts a piece from `artifact` in a transaction that is not committed. */
  const start = (artifact: Artifact) => {
    const tx = runtime.edit();
    try {
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        "result",
        undefined,
        tx,
      );
      pieces.push(
        startCompiledPiece(runtime, tx, artifact, {
          secret: "s",
          note: "n",
        }, result),
      );
    } finally {
      tx.abort();
    }
  };

  /**
   * Starts a piece from `artifact`, sends one event to its handler, and
   * returns what `last` holds when the runtime is settled.
   */
  const lastAfterAnEvent = async (artifact: Artifact) => {
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    const tx = runtime.edit();
    pieces.push(
      startCompiledPiece(runtime, tx, artifact, {
        secret: "s",
        note: "n",
      }, result.withTx(tx)),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
    result.key("record").send({ text: "t", extra: "e" } as never);
    await runtime.scheduler.idleWithPendingCommits();
    const read = runtime.edit();
    try {
      return result.withTx(read).key("last").get();
    } finally {
      read.abort();
    }
  };

  it("runs a handler body of the module as the crate emitted it", async () => {
    const artifact = await artifactWith((source) => `${source}\n`);

    expect(await lastAfterAnEvent(artifact)).toBe("ts");
  });

  it("reads no global of the realm the runtime runs in", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(
        SETS_LAST,
        "last.set([typeof Deno, typeof fetch, typeof setTimeout, typeof process].join());",
      )
    );

    expect(await lastAfterAnEvent(artifact)).toBe(
      "undefined,undefined,undefined,undefined",
    );
  });

  it("fails to load a module that writes a global", async () => {
    const artifact = await artifactWith((source) =>
      `globalThis.writtenByValueCode = true;\n${source}`
    );

    try {
      expect(() => start(artifact)).toThrow(TypeError);
      expect("writtenByValueCode" in globalThis).toBe(false);
    } finally {
      delete (globalThis as { writtenByValueCode?: boolean })
        .writtenByValueCode;
    }
  });

  it("fails to load a module that adds a member to a shared intrinsic", async () => {
    const artifact = await artifactWith((source) =>
      `Array.prototype.addedByValueCode = true;\n${source}`
    );

    try {
      expect(() => start(artifact)).toThrow(TypeError);
      expect("addedByValueCode" in Array.prototype).toBe(false);
    } finally {
      delete (Array.prototype as { addedByValueCode?: boolean })
        .addedByValueCode;
    }
  });

  it("fails to load a module that replaces a member of the object the executor hands it", async () => {
    const artifact = await artifactWith((source) =>
      `$rt.force = () => "replaced";\n${source}`
    );

    expect(() => start(artifact)).toThrow(TypeError);
  });

  it("gives a handler body no member of a handle that holds the executor", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(
        SETS_LAST,
        "last.set([typeof last.instance, typeof last.host].join());",
      )
    );

    expect(await lastAfterAnEvent(artifact)).toBe("undefined,undefined");
  });

  it("gives a handler body no member of the host of a call that holds the executor", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(SETS_LAST, "last.set(typeof $rt.nohost.instance);")
    );

    expect(await lastAfterAnEvent(artifact)).toBe("undefined");
  });

  it("commits nothing of a handler body that replaces a method of every handle", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(
        SETS_LAST,
        'last.set("before"); Object.getPrototypeOf(last).get = () => "replaced";',
      )
    );

    // The cell of `last` has no document, and the result's write redirect
    // to it reads the cell's default: the write before the assignment that
    // threw was not committed.
    expect(await lastAfterAnEvent(artifact)).toBe("");
    expect(Object.isFrozen(Handle.prototype)).toBe(true);
  });

  it("commits nothing of a handler body that replaces a method of the host of every call", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(
        SETS_LAST,
        'last.set("before"); Object.getPrototypeOf(Object.getPrototypeOf($rt.nohost)).slot = () => "replaced";',
      )
    );

    expect(await lastAfterAnEvent(artifact)).toBe("");
  });

  it("commits nothing of a handler body that replaces a method of every deferred value", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(
        SETS_LAST,
        'last.set("before"); Object.getPrototypeOf($rt.thunk(() => 1)).evaluate = () => "replaced";',
      )
    );

    expect(await lastAfterAnEvent(artifact)).toBe("");
  });

  it("gives a handler body the time of its event, to the second", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(SETS_LAST, "last.set(String(Date.now() % 1000));")
    );

    expect(await lastAfterAnEvent(artifact)).toBe("0");
  });

  it("gives a handler body a random draw", async () => {
    const artifact = await artifactWith((source) =>
      source.replaceAll(SETS_LAST, "last.set(typeof Math.random());")
    );

    expect(await lastAfterAnEvent(artifact)).toBe("number");
  });

  it("gives the code of module scope no clock", async () => {
    const artifact = await artifactWith((source) =>
      `const loadedAt = Date.now();\n${source}`
    );

    expect(() => start(artifact)).toThrow("ambient clock");
  });
});
