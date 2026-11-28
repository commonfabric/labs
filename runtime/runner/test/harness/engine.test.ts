import { expect } from "@std/expect";
import type { Source } from "@commonfabric/js-compiler";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "../engine-test-support.ts";

const FILES: Source[] = [
  { name: "/main.ts", contents: 'export { words } from "./words.ts";\n' },
  { name: "/words.ts", contents: "export const words = 1;\n" },
];

/** A compiled body that marks itself as the one handed to the engine. */
const held = (js: string) => `${js}\n// held\n`;

describe("Engine.compileResolvedToRecordGraph", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("uses held bodies only when every module is held", async () => {
    const cold = await engine.compileResolvedToRecordGraph(FILES, "/main.ts");
    const coldJs = new Map(cold.modules.map((m) => [m.identity, m.js]));
    const wordsIdentity =
      cold.modules.find((m) => m.filename === "/words.ts")!.identity;
    const everyModule = new Map(
      cold.modules.map((m) => [m.identity, { js: held(m.js) }]),
    );
    const allButWords = new Map(everyModule);
    allButWords.delete(wordsIdentity);

    const requests: { entryIdentity: string; identities: string[] }[] = [];
    const compileHolding = (bodies: typeof everyModule | undefined) =>
      engine.compileResolvedToRecordGraph(FILES, "/main.ts", {
        precompiledModulesFor: (info) => {
          requests.push(info);
          return Promise.resolve(bodies);
        },
      });

    const full = await compileHolding(everyModule);
    const partial = await compileHolding(allButWords);
    const miss = await compileHolding(undefined);

    expect(requests.map((r) => r.entryIdentity)).toEqual([
      cold.entryIdentity,
      cold.entryIdentity,
      cold.entryIdentity,
    ]);
    for (const request of requests) {
      expect([...request.identities].sort()).toEqual([...coldJs.keys()].sort());
    }
    for (const module of full.modules) {
      expect(module.js).toBe(held(coldJs.get(module.identity)!));
    }
    // A partial set is ignored, so even the held entry is compiled afresh, as
    // every module is on a miss.
    for (const compiled of [partial, miss]) {
      expect(compiled.entryIdentity).toBe(cold.entryIdentity);
      for (const module of compiled.modules) {
        expect(module.js).toBe(coldJs.get(module.identity));
      }
    }
  });
});
