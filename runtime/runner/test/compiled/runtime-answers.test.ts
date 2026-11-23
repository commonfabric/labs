import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Instance } from "../../../../base/pattern-compiler/exec/executor.ts";
import { topFrame } from "../../src/builder/frame-context.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { RuntimeAnswers } from "../../src/compiled/builtins.ts";
import { scopeKeyOf } from "../../src/compiled/scopes.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

describe("the answers a compiled piece was given by the runtime", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let answers: RuntimeAnswers;
  let acting: string;
  let own: string;
  let marked: { key: string; forOwn: boolean; forBob: boolean }[];
  let invalidated: number;

  /** A stand-in for an instance of the executor with one evaluation open. */
  const evaluating = (key: string): Instance =>
    ({
      id: "result",
      evaluationInProgress: () => ({ instance: evaluating(key), key }),
      markStale: (name: string, of?: (scoped: string) => boolean) => {
        marked.push({
          key: name,
          forOwn: of?.(own) ?? true,
          forBob: of?.("user:bob") ?? true,
        });
      },
    }) as unknown as Instance;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece answers");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { compiledPatterns: true },
    });
    // The principal the action of a runtime with no serving loop runs
    // for: the runtime's own.
    own = scopeKeyOf("user", runtime.scopeKeyIdentity);
    acting = own;
    marked = [];
    invalidated = 0;
    answers = new RuntimeAnswers({
      runtime,
      space,
      linkOf: () => {
        throw new Error("No document of the executor is named here.");
      },
      documentOf: () => "",
      invalidate: () => {
        invalidated += 1;
      },
      stamp: () => {},
      scopeKey: () => acting,
      piece: { space, pieceId: "space:answers", pieceRootId: "answers" },
    });
  });

  afterEach(async () => {
    answers.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /**
   * A question whose answer is what `cell` holds, read through the
   * transaction of the frame it is asked under, and how often it was
   * asked.
   */
  const question = (cell: Cell<number>) => {
    const asked = { times: 0 };
    return {
      asked,
      ask: () => {
        asked.times += 1;
        return cell.withTx(topFrame()!.tx!).get();
      },
    };
  };

  it("asks again the question whose answer read what changed, and no other", async () => {
    const [first, second] = [
      runtime.getCell<number>(space, "first"),
      runtime.getCell<number>(space, "second"),
    ];
    await commit((tx) => {
      first.withTx(tx).set(1);
      second.withTx(tx).set(1);
    });
    const [ofFirst, ofSecond] = [question(first), question(second)];
    answers.used(evaluating("uses first"), "first", ofFirst.ask, 1);
    answers.used(evaluating("uses second"), "second", ofSecond.ask, 1);
    await runtime.scheduler.idleWithPendingCommits();
    const before = { first: ofFirst.asked.times, second: ofSecond.asked.times };

    await commit((tx) => first.withTx(tx).set(2));

    expect(ofFirst.asked.times).toBe(before.first + 1);
    expect(ofSecond.asked.times).toBe(before.second);
    expect(marked).toEqual([
      { key: "uses first", forOwn: true, forBob: false },
    ]);
    expect(invalidated).toBe(1);
  });

  it("keeps the answer of each principal that asked", async () => {
    const cell = runtime.getCell<number>(space, "level");
    await commit((tx) => cell.withTx(tx).set(1));
    const asked = question(cell);
    // The action of a runtime with no serving loop runs for the runtime's
    // own principal, which was given no answer: the answer Bob was given
    // is not compared with what that run reads.
    acting = "user:bob";
    answers.used(evaluating("uses level"), "level", asked.ask, 1);
    await runtime.scheduler.idleWithPendingCommits();

    await commit((tx) => cell.withTx(tx).set(2));

    expect(marked).toEqual([]);
    expect(answers.questions).toBe(1);
  });
});
