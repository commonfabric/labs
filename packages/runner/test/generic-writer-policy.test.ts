import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { setCompileCacheRuntimeVersionForTesting } from "../src/compilation-cache/cell-cache.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarker,
} from "../src/telemetry.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("generic-writer-policy");
const space = signer.did();

const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents:
      `import { Confidential, handler, pattern, Stream, Writable, WriteAuthorizedBy } from "commonfabric";
const f = handler<string, { value: Writable<string> }>((event, { value }) => value.set(event));
const g: typeof f = handler<string, { value: Writable<string> }>((event, { value }) => value.set(event));
interface Box<W> { value: W }
type Pair<A, B> = { left: WriteAuthorizedBy<string, A>; right: WriteAuthorizedBy<string, B> };
type Identity<X> = X;
interface Node<W> { value: W; next?: Sec<Identity<W>> }
type Sec<W> = Confidential<Node<W>, readonly []>;
type Protected = WriteAuthorizedBy<string, typeof f>;
export interface Output {
  plain: Box<WriteAuthorizedBy<string, typeof f>>;
  pair: Pair<typeof f, typeof g>;
  record: Record<string, WriteAuthorizedBy<string, typeof f>>;
  recursive: Sec<WriteAuthorizedBy<string, typeof f>>;
  named: Box<Protected>;
  fPlain: Stream<string>; gPlain: Stream<string>;
  fLeft: Stream<string>; gLeft: Stream<string>;
  fRight: Stream<string>; gRight: Stream<string>;
  fRecord: Stream<string>; gRecord: Stream<string>;
  fDeep: Stream<string>; gDeep: Stream<string>;
  fNamed: Stream<string>; gNamed: Stream<string>;
}
export default pattern<{}, Output>(() => {
  const plain = new Writable<Box<WriteAuthorizedBy<string, typeof f>>>({ value: "initial" });
  const pair = new Writable<Pair<typeof f, typeof g>>({ left: "initial", right: "initial" });
  const record = new Writable<Record<string, WriteAuthorizedBy<string, typeof f>>>({ entry: "initial" });
  const recursive = new Writable<Sec<WriteAuthorizedBy<string, typeof f>>>({ value: "initial", next: { value: "initial", next: { value: "initial" } } });
  const named = new Writable<Box<Protected>>({ value: "initial" });
  return {
    plain, pair, record, recursive, named,
    fPlain: f({ value: plain.key("value") }), gPlain: g({ value: plain.key("value") }),
    fLeft: f({ value: pair.key("left") }), gLeft: g({ value: pair.key("left") }),
    fRight: f({ value: pair.key("right") }), gRight: g({ value: pair.key("right") }),
    fRecord: f({ value: record.key("entry") }), gRecord: g({ value: record.key("entry") }),
    fDeep: f({ value: recursive.key("next").key("next").key("value") }),
    gDeep: g({ value: recursive.key("next").key("next").key("value") }),
    fNamed: f({ value: named.key("value") }), gNamed: g({ value: named.key("value") }),
  };
});`,
  }],
};

describe("compiled generic writer policy", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let first: Runtime;
  let reloaded: Runtime;
  let restoreVersion: () => void;
  const errors: Error[] = [];

  beforeEach(() => {
    restoreVersion = setCompileCacheRuntimeVersionForTesting(
      "cf-test-generic-writer-before",
    );
    errors.length = 0;
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    const errorHandlers = [(error: Error) => errors.push(error)];
    first = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
      errorHandlers,
    });
    reloaded = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
      errorHandlers,
    });
  });

  afterEach(async () => {
    await reloaded?.dispose();
    await first?.dispose();
    await managerB?.close();
    await managerA?.close();
    await server?.close();
    restoreVersion?.();
  });

  for (const cache of ["warm", "cold"] as const) {
    it(`accepts only the named handler through generics and recursive refs after a ${cache} stored reload`, async () => {
      const setup = first.edit();
      const compiled = await first.patternManager.compilePattern(program, {
        space,
        tx: setup,
      });
      const resultCell = first.getCell(
        space,
        "generic-policy-result",
        undefined,
        setup,
      );
      const result = first.run(setup, compiled, {}, resultCell);
      first.prepareTxForCommit(setup);
      expect((await setup.commit()).error).toBeUndefined();
      await result.pull();
      await first.idle();

      const checkWrites = async (
        runtime: Runtime,
        cell: Cell<unknown>,
        phase: string,
      ) => {
        const commits: Extract<
          RuntimeTelemetryMarker,
          { type: "scheduler.event.commit" }
        >[] = [];
        let eventCommitted: (() => void) | undefined;
        const listener = (event: Event) => {
          const marker = (event as RuntimeTelemetryEvent).detail.marker;
          if (marker.type === "scheduler.event.commit") {
            commits.push(marker);
            eventCommitted?.();
          }
        };
        const send = async (stream: string, value: string) => {
          const committed = Promise.withResolvers<void>();
          eventCommitted = committed.resolve;
          expect(
            (await runtime.editWithRetry((tx) => {
              cell.withTx(tx).key(stream).send(value);
            })).error,
          ).toBeUndefined();
          await committed.promise;
          await runtime.scheduler.idleWithPendingCommits();
          await cell.pull();
        };
        runtime.telemetry.addEventListener("telemetry", listener);
        try {
          for (
            const [path, allowed, denied] of [
              [["plain", "value"], "fPlain", "gPlain"],
              [["pair", "left"], "fLeft", "gLeft"],
              [["pair", "right"], "gRight", "fRight"],
              [["record", "entry"], "fRecord", "gRecord"],
              [["recursive", "next", "next", "value"], "fDeep", "gDeep"],
              [["named", "value"], "fNamed", "gNamed"],
            ] as const
          ) {
            const accepted = `${phase}:${allowed}`;
            await send(allowed, accepted);
            const target = path.reduce<Cell<unknown>>(
              (value, key) => value.key(key),
              cell,
            );
            expect(target.get()).toBe(accepted);
            expect(errors).toEqual([]);
            expect(commits).toHaveLength(1);
            expect(commits[0].error).toBeUndefined();
            commits.length = 0;

            await send(denied, `${phase}:${denied}`);
            expect(commits).toHaveLength(1);
            expect(commits[0].terminal).toBe("rule");
            expect(commits[0].error).toContain("writeAuthorizedBy");
            expect(target.get()).toBe(accepted);
            expect(errors).toEqual([]);
            commits.length = 0;
          }
        } finally {
          runtime.telemetry.removeEventListener("telemetry", listener);
        }
      };
      await checkWrites(first, result, "compiled");

      await first.patternManager.flushCompileCacheWrites();
      await first.storageManager.synced();
      await first.dispose();
      const restoreForReload = cache === "cold"
        ? setCompileCacheRuntimeVersionForTesting(
          "cf-test-generic-writer-after",
        )
        : () => {};
      try {
        const engine = reloaded.harness as Engine;
        const compile = engine.compileResolvedToRecordGraph.bind(engine);
        let coldCompiles = 0;
        engine.compileResolvedToRecordGraph = (...args) => {
          coldCompiles++;
          return compile(...args);
        };
        const stored = reloaded.getCellFromLink(
          result.getAsNormalizedFullLink(),
        );
        await stored.sync();
        expect(await reloaded.start(stored)).toBe(true);
        expect(coldCompiles).toBe(cache === "cold" ? 1 : 0);
        await reloaded.idle();
        await stored.pull();
        await checkWrites(reloaded, stored, "reloaded");
      } finally {
        restoreForReload();
      }
    });
  }
});
