import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { namesInstancesByDefault } from "../../src/builder/instance-name.ts";
import { type Cell, type MemorySpace, sendEvent } from "../../src/cell.ts";
import {
  compiledPiecesOf,
  serveCompiledPieces,
} from "../../src/compiled/serving.ts";
import {
  argumentDocumentOf,
  compiledFailureOf,
  type PatternProgram,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/cache.deno.ts";

const fixture = (name: string, extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/${name}.${extension}`,
    import.meta.url,
  );

const FIXTURES = ["write-policy", "argument-policy", "own-write-policy"];
const ARTIFACTS = new Map<string, Artifact>();
const PROGRAMS = new Map<string, PatternProgram>();
for (const name of FIXTURES) {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(name, "emit.json")),
  ) as { patterns: Artifact[] }[];
  ARTIFACTS.set(name, patterns.find(({ name }) => name === "default")!);
  PROGRAMS.set(name, {
    main: `/${name}.tsx`,
    files: [{
      name: `/${name}.tsx`,
      contents: await Deno.readTextFile(fixture(name, "tsx")),
    }],
  });
}

// A client sets a piece up (`setUpCompiledPiece`), the serving runtime
// starts it from the stored argument, and the client sends events to it.
describe("a write policy of a compiled piece a serving runtime starts from a stored argument", () => {
  let signer: Identity;
  let space: MemorySpace;
  let server: ReturnType<typeof newLoopbackServer>;
  let host: ExecutorHost;
  let serving: Runtime[];
  let client: Runtime;
  let cancels: (() => void)[];
  /** Resolves with the error of the first piece that did not start. */
  let notStarted: PromiseWithResolvers<unknown>;

  // The serving loop and its client share a memory server of this thread,
  // which no socket reaches: the fake clock sees every turn between them.
  beforeEach(async () => {
    notStarted = Promise.withResolvers();
    signer = await Identity.fromPassphrase("compiled piece served policy");
    space = signer.did();
    const service = await Identity.fromPassphrase(
      "compiled piece served policy service",
    );
    const experimental = { compiledPatterns: true };
    server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [service.did()],
      namesInstances: () => namesInstancesByDefault(experimental),
    });
    const create = servingRuntimeFactory({
      server,
      identity: service,
      apiUrl: new URL(import.meta.url),
      experimental,
    });
    serving = [];
    host = new ExecutorHost({
      policy: { storeReadThrough: true },
      ensureSpaceRoots: false,
      server,
      serviceIdentity: service.did(),
      createRuntime: async (of, context) => {
        const made = await create(of, context);
        serveCompiledPieces(made.runtime, {
          // The crate's binary is not run here: what stands in its place
          // gives the artifact the crate emitted for the fixture the
          // program names.
          compile: (program) =>
            Promise.resolve({
              main: ARTIFACTS.get(program.main.slice(1, -".tsx".length))!,
              artifacts: () => undefined,
            }),
          failed: (_result, error) => notStarted.resolve(error),
        });
        serving.push(made.runtime);
        return made;
      },
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: signer,
      }),
      experimental: { serverExecution: true },
    });
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await host.close();
    await client.dispose();
    await server.close();
  });

  /** The compiled pieces the serving runtimes run. */
  const pieces = () => serving.flatMap((runtime) => compiledPiecesOf(runtime));

  /**
   * Sets the fixture `name` up from the client over `argument`, and
   * returns the result as the client reads it once the piece has stored
   * the stream `stream`.
   */
  const setUp = async <T>(
    name: string,
    argument: unknown,
    stream: string,
  ): Promise<Cell<T>> => {
    const result = client.getCell<T>(space, `${name} result`);
    const tx = client.edit();
    setUpCompiledPiece(
      client,
      tx,
      PROGRAMS.get(name)!,
      argument,
      result.withTx(tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = client.getCellFromLink<T>(result.getAsNormalizedFullLink());
    cancels.push(read.sink(() => {}));
    await waitForCellValue<T>(
      client,
      read,
      (value) => (value as Record<string, unknown>)?.[stream] !== undefined,
      { stuckLabel: `the client reads the stream \`${stream}\`` },
    );
    return read;
  };

  /**
   * Sends `event` to the stream `stream` of `result`, and returns the
   * message the client is told the handling failed with, or `undefined`
   * where it committed.
   */
  const send = async (
    result: Cell<unknown>,
    stream: string,
    event: unknown,
  ): Promise<string | undefined> => {
    const target = result.key(stream as never) as Cell<unknown>;
    await target.sync();
    await (target.resolveAsCell() as Cell<unknown>).sync();
    const handled = Promise.withResolvers<string | undefined>();
    sendEvent(
      target,
      event as never,
      (tx) => {
        const status = tx.status();
        handled.resolve(
          status.status === "error"
            ? `${(status.error as Error).message}`
            : undefined,
        );
      },
      { echo: false },
    );
    return await handled.promise;
  };

  // `fixtures/write-policy.tsx`: the state cell `note` declares
  // `WriteAuthorizedBy<string, typeof record>`. The handlers `record` and
  // `overwrite` both write it.

  it("commits the write of the handler the policy names", async () => {
    type Held = { note: string };
    const read = await setUp<Held>("write-policy", {}, "record");

    expect(await send(read, "record", { text: "written" })).toBeUndefined();
    const held = await waitForCellValue<Held>(
      client,
      read,
      (value) => value?.note === "written",
      { stuckLabel: "the client reads what the handler wrote" },
    );

    expect(held.note).toBe("written");
  });

  it("refuses the write of a handler the policy does not name", async () => {
    type Held = { note: string };
    const read = await setUp<Held>("write-policy", {}, "overwrite");

    expect(await send(read, "overwrite", { text: "overwritten" })).toContain(
      "writeAuthorizedBy requires a trusted verified binding identity at /",
    );
    expect(pieces()[0].instance.result()).toMatchObject({ note: "" });
  });

  // `fixtures/own-write-policy.tsx`: the state cell `note` declares the
  // same policy, and that the principal who creates it alone reads it.
  describe("for a cell its type declares readable by the principal who creates it", () => {
    type Held = { note: string };

    it.ignore("tells the principal who set the piece up the refusal of a handler the policy does not name", async () => {
      // Ignored: the start a serving runtime makes from a stored argument
      // acts for no principal, so the cell stores the `User` clause of the
      // serving runtime's identity where today's setup stores that of the
      // principal who created the piece. The space admits no reader of
      // that clause, and the outcome of every event that reads the cell is
      // withheld from its sender. The clause is a stored label, which
      // waits for the design of the labels of each principal.

      const read = await setUp<Held>("own-write-policy", {}, "overwrite");

      expect(await send(read, "overwrite", { text: "overwritten" }))
        .toContain(
          "writeAuthorizedBy requires a trusted verified binding identity at /",
        );
    });
  });

  // `fixtures/argument-policy.tsx`: the argument field `note` declares
  // `WriteAuthorizedBy<string, typeof record>` and the default `""`. The
  // handlers `record` and `overwrite` both write it.
  describe("for a field of the argument", () => {
    type Held = { note: string; title: string };

    it("stores the defaults of the argument type in the argument document", async () => {
      const read = await setUp<Held>("argument-policy", {}, "record");

      const argument = client.getCellFromLink<Held>({
        space,
        id: argumentDocumentOf(read.getAsNormalizedFullLink().id),
        path: [],
        scope: "space",
      });
      await argument.sync();

      expect(argument.getRaw()).toEqual({ note: "", title: "untitled" });
    });

    it("commits the write of the handler the policy names", async () => {
      const read = await setUp<Held>("argument-policy", {}, "record");

      expect(await send(read, "record", { text: "written" })).toBeUndefined();
      expect(pieces()[0].instance.result()).toMatchObject({
        note: "written",
      });
    });

    it("refuses the first write of a handler the policy does not name", async () => {
      const read = await setUp<Held>("argument-policy", {}, "overwrite");

      expect(await send(read, "overwrite", { text: "overwritten" }))
        .toContain(
          "writeAuthorizedBy requires a trusted verified binding identity at /note",
        );
      expect(pieces()[0].instance.result()).toMatchObject({
        note: "",
      });
    });

    it("refuses the write of the default by a handler the policy does not name", async () => {
      const read = await setUp<Held>("argument-policy", {}, "overwrite");

      expect(await send(read, "overwrite", { text: "" })).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /note",
      );
    });

    it("refuses a write of the field's cell by a client before any handler wrote it", async () => {
      const read = await setUp<Held>("argument-policy", {}, "record");
      const note = (read.key("note" as never) as Cell<string>)
        .resolveAsCell() as Cell<string>;
      await note.sync();

      const tx = client.edit();
      note.withTx(tx).set("forged");

      expect((await tx.commit().settled).error?.message).toContain(
        "writeAuthorizedBy",
      );
    });

    it("commits a write of the plain field's cell by the client", async () => {
      const read = await setUp<Held>("argument-policy", {}, "record");
      const title = (read.key("title" as never) as Cell<string>)
        .resolveAsCell() as Cell<string>;
      await title.sync();

      const tx = client.edit();
      title.withTx(tx).set("renamed");

      expect((await tx.commit().settled).error).toBeUndefined();
    });

    it("does not start a piece whose stored argument supplies a value for the field, and stores the refusal of the policy as the reason", async () => {
      const result = client.getCell<Held>(space, "supplied result");
      const tx = client.edit();
      setUpCompiledPiece(
        client,
        tx,
        PROGRAMS.get("argument-policy")!,
        { note: "supplied" },
        result.withTx(tx),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      cancels.push(result.sink(() => {}));
      const failure = client.getCellFromLink<{ reason?: string }>({
        space,
        id: compiledFailureOf(result.getAsNormalizedFullLink().id),
        path: [],
        scope: "space",
      });
      cancels.push(failure.sink(() => {}));

      const error = await notStarted.promise as Error;
      const stored = await waitForCellValue<{ reason?: string }>(
        client,
        failure,
        (value) => value?.reason !== undefined,
        { stuckLabel: "the client reads why the piece was not started" },
      );

      const refusal =
        "writeAuthorizedBy requires a trusted verified binding identity at /note";
      expect(error.message).toContain(refusal);
      expect(stored.reason).toContain(refusal);
      expect(pieces()).toEqual([]);
      expect(result.get()).toBeUndefined();
    });
  });
});
