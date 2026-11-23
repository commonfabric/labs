/**
 * What the tests of a compiled piece that another serving loop takes over
 * share: a serving memory server that runs the artifacts of
 * `base/pattern-compiler/compare/fixtures/`, clients of it with server
 * execution on, and the restart that has another serving loop take the
 * space over.
 */
import { expect } from "@std/expect";
import { afterEach, beforeEach } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import type { ResumedPiece } from "../../src/compiled/resume.ts";
import type { PatternProgram } from "../../src/compiled/serving.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (name: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/${name}`,
    import.meta.url,
  );

/** The pattern `default` that the crate emitted for a fixture. */
export const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(`${name}.emit.json`)),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

/** The program of one file of `compare/fixtures/`. */
export const programOf = async (name: string): Promise<PatternProgram> => ({
  main: `/${name}.tsx`,
  files: [{
    name: `/${name}.tsx`,
    contents: await Deno.readTextFile(fixture(`${name}.tsx`)),
  }],
});

/** What `servingTakeover()` gives a test. */
export type ServingTakeover = {
  /** The space of the pieces, which is the identity of the clients. */
  readonly space: MemorySpace;
  /** The serving memory server of the case. */
  readonly serving: CompiledServingMemoryServer;
  /** The pieces a serving runtime resumed from their basis so far. */
  readonly resumed: ResumedPiece[];
  /**
   * A client of the serving memory server, over its websocket, with server
   * execution on: it runs no handler and no derivation of a piece.
   */
  client(): Runtime;
  /** Commits what `write` writes in `runtime`. */
  commit(
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ): Promise<void>;
  /** The cell `result` names as `runtime` reads it, kept in sync. */
  reading<T>(runtime: Runtime, result: Cell<T>): Cell<T>;
  /** Waits until `cell` holds a value that `holds` accepts, and gives it. */
  until<T>(
    runtime: Runtime,
    cell: Cell<T>,
    holds: (value: T | undefined) => boolean,
    label: string,
  ): Promise<T>;
  /**
   * Sends `event` to `stream`, a cell of `runtime` at a position that
   * links to a stream, once the replica of that client holds the marker of
   * the stream.
   */
  send(runtime: Runtime, stream: Cell<unknown>, event: unknown): Promise<void>;
  /**
   * Has another serving loop take the space over, and forgets the pieces
   * resumed before.
   */
  takeOver(): Promise<void>;
};

/**
 * Sets a serving memory server up before each case of the enclosing
 * `describe()` and closes it after. The server compiles nothing: it gives
 * the artifact the crate emitted for the fixture a program names.
 */
export const servingTakeover = (passphrase: string): ServingTakeover => {
  let signer: Identity;
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];
  let resumed: ResumedPiece[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(passphrase);
    resumed = [];
    serving = await listenCompiledServingMemoryServer({
      compile: async (program) => ({
        main: await artifactOf(program.main.slice(1, -".tsx".length)),
        artifacts: () => undefined,
      }),
      pieces: { resumed: (_result, piece) => resumed.push(piece) },
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

  return {
    get space() {
      return signer.did();
    },
    get serving() {
      return serving;
    },
    get resumed() {
      return resumed;
    },
    client() {
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
    },
    async commit(runtime, write) {
      const tx = runtime.edit();
      write(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    },
    reading<T>(runtime: Runtime, result: Cell<T>): Cell<T> {
      const cell = runtime.getCellFromLink<T>(
        result.getAsNormalizedFullLink(),
      );
      cancels.push(cell.sink(() => {}));
      return cell;
    },
    until<T>(
      runtime: Runtime,
      cell: Cell<T>,
      holds: (value: T | undefined) => boolean,
      label: string,
    ): Promise<T> {
      return waitForCellValue<T>(runtime, cell, holds, { stuckLabel: label });
    },
    async send(runtime, stream, event) {
      await waitForCellValue(
        runtime,
        stream,
        () => {
          const held = stream.resolveAsCell().getRaw() as unknown;
          return typeof held === "object" && held !== null &&
            (held as { $stream?: unknown }).$stream === true;
        },
        { stuckLabel: "a client holds the marker of a stream" },
      );
      stream.send(event);
    },
    async takeOver() {
      resumed.length = 0;
      await serving.restart();
    },
  };
};
