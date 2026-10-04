/**
 * Pattern code runs in the sandbox and holds cells, and must reach no host
 * authority through them: not the runtime or any of its services, and not a
 * storage transaction. These cases check that three ways: attacks run by a
 * pattern in the real sandbox, the host-only functions that reach what a cell
 * keeps private, and a walk of everything a cell and what it returns reach.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import {
  type Cell,
  CellImpl,
  exportCell,
  getCarriedCfcLabelView,
  isCell,
  sendEvent,
  setCell,
} from "../src/cell.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { Runtime } from "../src/runtime.ts";
import { isRuntime } from "../src/runtime-brand.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  ExtendedStorageTransaction,
  isStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { runAttacker } from "./support/sandbox-attacker.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

await ensureCompilerStack();

const signer = await Identity.fromPassphrase("runner cell authority");
const space = signer.did();
const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };

/**
 * The objects that share a realm with pattern code and hold no host authority.
 * A walk stops at them rather than enumerating the language.
 */
const INTRINSICS = new Set<unknown>([
  globalThis,
  Object,
  Object.prototype,
  Function,
  Function.prototype,
  Array.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Promise.prototype,
  RegExp.prototype,
  Date.prototype,
  Error.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Symbol.prototype,
  BigInt.prototype,
  Object.getPrototypeOf(function* () {}),
  Object.getPrototypeOf(async function () {}),
  Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
]);

/** The names of a transaction's methods, which a forged transaction has. */
const transactionMethodNames = Object.getOwnPropertyNames(
  ExtendedStorageTransaction.prototype,
).filter((name) =>
  name !== "constructor" &&
  typeof Object.getOwnPropertyDescriptor(
      ExtendedStorageTransaction.prototype,
      name,
    )?.value === "function"
);

/**
 * Walks what pattern code can reach from `roots`: every own property, getters
 * included, which it calls on the object it reached them through; every
 * prototype; and what each function returns when called with no arguments,
 * with callbacks, whose own arguments it walks in turn, and with a forged
 * transaction in each argument position in turn. A method is called once per
 * object that holds it, which bounds a walk of a graph like a cell's, where
 * each call to `key()` returns a new cell. A returned promise is walked as an
 * object and not awaited.
 *
 * Returns, as `reached`, the path to each object for which `authority()`
 * returns a name, and as `forgedUses`, each transaction method host code called
 * on the forged transaction, with the call that led there.
 */
function walkForAuthority(
  roots: Record<string, unknown>,
  authority: (value: object) => string | undefined,
): { reached: string[]; forgedUses: string[] } {
  const reached: string[] = [];
  const forgedUses: string[] = [];
  let calling = "";
  // A use is a call with the forged transaction as its receiver. The walk
  // itself calls these methods too, through whatever wraps the forged
  // transaction, and those calls have the wrapper as their receiver.
  const forged: Record<string, () => void> = Object.fromEntries(
    transactionMethodNames.map((name) => [name, function (this: unknown) {
      if (this === forged) forgedUses.push(`${calling} called ${name}()`);
    }]),
  );
  const seen = new WeakSet<object>();
  const called = new WeakMap<object, Set<PropertyKey>>();
  const queue: [unknown, string][] = Object.entries(roots).map((
    [path, value],
  ) => [value, path]);
  const enqueue = (value: unknown, path: string) => queue.push([value, path]);
  const probe = (path: string) => (...args: unknown[]) => {
    args.forEach((arg, i) => enqueue(arg, `${path}(callback arg ${i})`));
  };
  const callOnce = (
    holder: object,
    key: PropertyKey,
    call: () => unknown,
    path: string,
  ) => {
    const keys = called.get(holder) ?? new Set();
    called.set(holder, keys);
    if (keys.has(key)) return;
    keys.add(key);
    calling = path;
    try {
      enqueue(call(), path);
    } catch {
      // A call that throws hands nothing out.
    }
  };

  while (queue.length > 0) {
    const [value, path] = queue.shift()!;
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null || INTRINSICS.has(value) || seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    const name = authority(value);
    if (name !== undefined) {
      reached.push(`${path}: ${name}`);
      continue;
    }

    // What `value` holds and inherits, down to the intrinsics. A proxy's traps
    // may throw where a plain object's reflection would not, and a throw hands
    // nothing out.
    const holders: object[] = [];
    try {
      for (
        let holder: object | null = value;
        holder !== null && !INTRINSICS.has(holder);
        holder = Object.getPrototypeOf(holder)
      ) {
        holders.push(holder);
      }
    } catch {
      // Walk the holders found before the throw.
    }
    for (const holder of holders) {
      if (holder !== value) enqueue(holder, `${path}.__proto__`);
      let keys: (string | symbol)[] = [];
      try {
        keys = Reflect.ownKeys(holder);
      } catch {
        // No keys to walk.
      }
      for (const key of keys) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Reflect.getOwnPropertyDescriptor(holder, key);
        } catch {
          continue;
        }
        if (descriptor === undefined) continue;
        const at = `${path}.${String(key)}`;
        const { get, value: member } = descriptor;
        if (get !== undefined) {
          callOnce(holder, key, () => get.call(value), at);
        } else if (typeof member === "function") {
          enqueue(member, at);
          callOnce(holder, key, () => member.call(value), `${at}()`);
          callOnce(
            holder,
            `${String(key)} with callbacks`,
            () => member.call(value, probe(at), probe(at), probe(at)),
            `${at}(callbacks)`,
          );
          for (let position = 0; position < 3; position++) {
            const args: unknown[] = [undefined, undefined, undefined];
            args[position] = forged;
            callOnce(
              holder,
              `${String(key)} with a forged transaction at ${position}`,
              () => member.call(value, ...args),
              `${at}(forged transaction at ${position})`,
            );
          }
        } else {
          enqueue(member, at);
        }
      }
    }
  }
  return { reached, forgedUses };
}

describe("cell-authority", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Returns a new cell holding `"initial"`. */
  const initialCell = async (): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(
      space,
      `target-${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    cell.set("initial");
    await tx.commit();
    return cell.withTx();
  };

  describe("a pattern holding a cell", () => {
    it("reads the cell it was handed", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "return cell.get();",
      );

      expect(await attack.probe()).toBe("initial");
    });

    it("finds neither a runtime nor a transaction on the cell", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "return [typeof cell.runtime, typeof cell.tx].join();",
      );

      expect(await attack.probe()).toBe("undefined,undefined");
    });

    it("reads nothing above the runtime's read ceiling", async () => {
      // A document labeled for B, written by a runtime with no ceiling, and
      // an attacker in a runtime whose ceiling admits only A. Each route
      // below read the document's content from a handler holding a cell.
      const writer = runtime;
      const tx = writer.edit();
      const secret = writer.getCell(space, "authority-secret", {
        type: "string",
        ifc: { confidentiality: [B] },
      }, tx);
      secret.set("withheld content");
      await tx.commit();
      await secret.sync();
      const reader = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcReadMaxConfidentiality: [A],
      });
      try {
        const target = reader.getCell<unknown>(space, "authority-target");
        const attack = await runAttacker(
          reader,
          space,
          target,
          [
            "const at = { space: cell.space, id: event.id, scope: 'space',",
            "  path: ['value'] };",
            "const routes = [",
            "  () => cell.runtime.storageManager.edit().read(at),",
            "  () => cell.tx.tx.read(at),",
            "  () => {",
            "    cell.runtime.cfcReadMaxConfidentiality = undefined;",
            "    return cell.runtime.edit().read(at);",
            "  },",
            "];",
            "return routes.map((route) => {",
            "  try {",
            "    return String(route().ok?.value);",
            "  } catch {",
            "    return 'refused';",
            "  }",
            "}).join();",
          ].join("\n"),
        );

        expect(await attack.probe({ id: secret.getAsNormalizedFullLink().id }))
          .toBe("refused,refused,refused");
      } finally {
        await reader.storageManager.synced();
        await reader.dispose();
      }
    });

    it("reads nothing its run does not consume", async () => {
      // A document holding a public string and a link to a secret labeled for
      // A. The attacker declares only the public field, so the runtime reads
      // no further to hand it the cell, and a run that writes what it read of
      // the secret into its unlabeled note must fail to commit.
      const strict = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        const tx = strict.edit();
        const secret = strict.getCell(space, "authority-linked-secret", {
          type: "string",
          ifc: { confidentiality: [A] },
        }, tx);
        secret.set("withheld content");
        const holder = strict.getCell<unknown>(
          space,
          "authority-holder",
          undefined,
          tx,
        );
        holder.set({ pub: "public", ref: secret });
        await tx.commit();
        // Each event names a route to the secret, and the attacker writes
        // whether what it read there was the secret. A refused run leaves the
        // note as it was, so the routes that must succeed go last.
        const attack = await runAttacker(
          strict,
          space,
          holder.withTx(),
          [
            "const routes: Record<string, () => any> = {",
            "  held: () => cell.key('ref'),",
            "  detached: () => cell.withTx().key('ref'),",
            "  linkDetached: () => cell.key('ref').withTx(),",
            "  public: () => cell.withTx().key('pub'),",
            "};",
            "if (event.id === 'sink') {",
            "  let value: unknown;",
            "  cell.asSchema({ type: 'object',",
            "    properties: { ref: { type: 'string' } } })",
            "    .sink((read: any) => { value = read?.ref; })();",
            "  return value === 'withheld content' ? 'secret' : value;",
            "}",
            "const value = routes[event.id!]().get();",
            "return value === 'withheld content' ? 'secret' : value;",
          ].join("\n"),
          "{ pub: string }",
        );

        expect(await attack.probe({ id: "held" })).toBeUndefined();
        expect(await attack.probe({ id: "detached" })).toBeUndefined();
        expect(await attack.probe({ id: "linkDetached" })).toBeUndefined();
        expect(await attack.probe({ id: "sink" })).toMatch(
          /^threw Error: .* cannot sink\(\) while it runs$/,
        );
        expect(await attack.probe({ id: "public" })).toBe("public");
      } finally {
        await strict.storageManager.synced();
        await strict.dispose();
      }
    });

    it("writes through its run's transaction from a cell it detached", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "cell.withTx().set('changed'); return cell.get();",
      );

      expect(await attack.probe()).toBe("changed");
    });

    it("cannot redefine a member of the prototype every cell shares", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "Object.defineProperty(Object.getPrototypeOf(cell), 'schema', {" +
          " get() { return { default: { pwned: true } }; } });" +
          " return 'redefined';",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: Cannot redefine property: schema",
      );
    });

    it("cannot shadow a member of the cell it holds", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "Object.defineProperty(cell, 'schema', {" +
          " get() { return { default: { pwned: true } }; } });" +
          " return 'shadowed';",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: Cannot define property schema, object is not extensible",
      );
    });

    it("cannot change what the cell it holds names", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "const link = cell.getAsNormalizedFullLink();" +
          " link.id = 'of:elsewhere'; return 'redirected';",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: Cannot assign to read only property 'id' of object '[object Object]'",
      );
    });

    it("cannot change the path of the cell it holds", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "cell.path.push('elsewhere'); return 'extended';",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: Cannot add property 0, object is not extensible",
      );
    });

    it("cannot construct a cell around a runtime of its own", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "const Cell = Object.getPrototypeOf(cell).constructor;" +
          " new Cell({}, undefined, cell.getAsNormalizedFullLink());" +
          " return 'constructed';",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: A cell's runtime must be a `Runtime`",
      );
    });

    it("cannot bind the cell to a transaction of its own", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "cell.withTx({ read() {}, write() {} }); return 'bound';",
      );

      expect(await attack.probe()).toBe(
        "threw TypeError: A cell's transaction must be one the runtime created",
      );
    });

    it("finds no method that exports the cell for the builder", async () => {
      const attack = await runAttacker(
        runtime,
        space,
        await initialCell(),
        "return typeof cell.export;",
      );

      expect(await attack.probe()).toBe("undefined");
    });
  });

  describe("isCell()", () => {
    it("returns `true` for a cell and for a `Reactive` proxy over one", () => {
      const cell = runtime.getCell<number>(space, "authority-is-cell");

      expect(isCell(cell)).toBe(true);
      expect(isCell(cell.getAsReactiveProxy())).toBe(true);
    });

    it("returns `false` for an object built on the cell prototype", () => {
      expect(isCell(Object.create(CellImpl.prototype))).toBe(false);
    });
  });

  describe("CellImpl", () => {
    describe("constructor()", () => {
      it("throws given a runtime the host did not construct", () => {
        expect(() => new CellImpl({} as Runtime, undefined)).toThrow(
          "A cell's runtime must be a `Runtime`",
        );
      });

      it("throws given a transaction the runtime did not create", () => {
        expect(() => new CellImpl(runtime, {} as IExtendedStorageTransaction))
          .toThrow("A cell's transaction must be one the runtime created");
      });

      it("throws given a wrapper around a transaction the runtime did not create", () => {
        const forged = new TransactionWrapper(
          {} as IExtendedStorageTransaction,
        );

        expect(() => new CellImpl(runtime, forged)).toThrow(
          "A cell's transaction must be one the runtime created",
        );
      });

      it("constructs a cell given a runtime and a transaction it created", () => {
        const tx = runtime.edit();

        expect(isCell(new CellImpl(runtime, tx))).toBe(true);
        expect(isCell(new CellImpl(runtime, new TransactionWrapper(tx))))
          .toBe(true);
        tx.abort();
      });
    });

    describe("instance members", () => {
      describe("set()", () => {
        it("never calls a function passed after the value", async () => {
          const cell = runtime.getCell<number>(space, "authority-set-extra");
          const calls: unknown[] = [];

          await runtime.editWithRetry((tx) =>
            (cell.withTx(tx).set as (...args: unknown[]) => unknown)(
              1,
              (committed: unknown) => calls.push(committed),
            )
          );
          await runtime.idle();

          expect(cell.get()).toBe(1);
          expect(calls).toEqual([]);
        });
      });
    });
  });

  describe("setCell()", () => {
    it("calls its callback with the transaction once it settles", async () => {
      const cell = runtime.getCell<number>(space, "authority-set-cell");
      const settled = Promise.withResolvers<IExtendedStorageTransaction>();

      await runtime.editWithRetry((tx) =>
        setCell(cell.withTx(tx), 1, settled.resolve)
      );

      expect(isStorageTransaction(await settled.promise)).toBe(true);
      expect(cell.get()).toBe(1);
    });
  });

  describe("sendEvent()", () => {
    it("calls its callback with the transaction once the event settles", async () => {
      const { commonfabric } = createTrustedBuilder(runtime);
      const Counter = commonfabric.pattern(() => ({
        bump: commonfabric.handler(
          { type: "object", properties: {} },
          { type: "object", properties: {} },
          () => {},
        )({}),
      }));
      const result = runtime.getCell<{ bump: unknown }>(
        space,
        "authority-send-event",
      );
      await runtime.runSynced(result, Counter, {});
      const settled = Promise.withResolvers<IExtendedStorageTransaction>();

      await runtime.editWithRetry((tx) =>
        sendEvent(result.key("bump").withTx(tx), {}, settled.resolve)
      );

      expect(isStorageTransaction(await settled.promise)).toBe(true);
    });
  });

  describe("exportCell()", () => {
    it("describes a cell and a `Reactive` proxy over it alike", () => {
      const cell = runtime.getCell<{ a: number }>(space, "authority-export");

      expect(exportCell(cell.key("a")).path).toEqual(["a"]);
      expect(exportCell(cell.key("a").getAsReactiveProxy()).path).toEqual([
        "a",
      ]);
    });

    it("throws given an object that is not a cell", () => {
      expect(() => exportCell({ export: () => ({}) })).toThrow(
        "Expected a runner cell",
      );
    });
  });

  describe("getCarriedCfcLabelView()", () => {
    it("returns the view a cell carries", () => {
      const view = {
        version: 1 as const,
        entries: [{ path: [], label: { confidentiality: ["carried"] } }],
      };
      const cell = new CellImpl(
        runtime,
        undefined,
        undefined,
        false,
        undefined,
        "cell",
        view,
      );

      expect(getCarriedCfcLabelView(cell)).toEqual(view);
    });

    it("returns `undefined` for an object that is not a cell", () => {
      const lookalike = {
        [Symbol("cfcLabelView")]: () => ({ version: 1, entries: [] }),
        getAsNormalizedFullLink: () => ({}),
      };

      expect(getCarriedCfcLabelView(lookalike)).toBeUndefined();
    });
  });

  describe("what a cell reaches", () => {
    it("reaches no runtime service and no transaction, and uses none it is handed", () => {
      const forbidden = new Map<object, string>([
        [runtime, "the runtime"],
        [runtime.storageManager, "the storage manager"],
        [runtime.scheduler, "the scheduler"],
        [runtime.patternManager, "the pattern manager"],
        [runtime.sourceReconciler, "the source reconciler"],
        [runtime.moduleRegistry, "the module registry"],
        [runtime.harness, "the harness"],
        [runtime.runner, "the runner"],
        [runtime.staticCache, "the static cache"],
        [runtime.telemetry, "the telemetry"],
      ]);
      const authority = (value: object) =>
        forbidden.get(value) ??
          (isRuntime(value)
            ? "a runtime"
            : isStorageTransaction(value)
            ? "a transaction"
            : undefined);

      const tx = runtime.edit();
      const { commonfabric } = createTrustedBuilder(runtime);
      const Counter = commonfabric.pattern(() => ({
        count: 0,
        bump: commonfabric.handler(
          { type: "object", properties: {} },
          { type: "object", properties: {} },
          () => {},
        )({}),
      }));
      const result = runtime.run(
        tx,
        Counter,
        {},
        runtime.getCell(space, "authority-walk", undefined, tx),
      );
      const cell = result.key("count");
      const walked = walkForAuthority({
        cell,
        stream: result.key("bump"),
        reactive: cell.getAsReactiveProxy(),
        queryResult: result.getAsQueryResult(),
      }, authority);
      // The walk wrote whatever the calls it made wrote, which nothing reads.
      tx.abort();

      expect(walked.reached).toEqual([]);
      expect(walked.forgedUses).toEqual([]);
      // The walk finds what it is meant to: a transaction handed out, and a
      // method that reads through a transaction its caller supplies.
      expect(walkForAuthority({
        holder: {
          tx,
          readThrough: (reader: IExtendedStorageTransaction) =>
            reader.readValueOrThrow(cell.getAsNormalizedFullLink()),
        },
      }, authority)).toEqual({
        reached: ["holder.tx: a transaction"],
        forgedUses: [
          "holder.readThrough(forged transaction at 0) called readValueOrThrow()",
        ],
      });
    });
  });
});
