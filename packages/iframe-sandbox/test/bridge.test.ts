/** Exercises the host and guest ends of the explicit capability protocol. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import {
  BRIDGE_READ_REFUSED,
  type BridgeCancel,
  type BridgeCell,
  BridgeReadRefusedError,
  type BridgeResource,
  type BridgeSinkFailure,
  createFabricBridge,
  FabricBridgeHost,
} from "../src/bridge.ts";
import { connectFabric } from "../src/guest.ts";
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  type BridgeResolvedCell,
  GUEST_PORT_HANDOFF,
} from "../src/ipc.ts";

function handOff(port: MessagePort): void {
  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: GUEST_PORT_HANDOFF,
      ports: [port],
    }),
  );
}

function nextTask(): Promise<void> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

function cellResource(
  get: () => FabricValue | undefined,
  options: {
    initialize?: (value: FabricValue) => FabricValue | Promise<FabricValue>;
    set?: (value: FabricValue) => void | Promise<void>;
    sink?: (listener: (value: FabricValue | undefined) => void) => BridgeCancel;
    push?: (values: readonly FabricValue[]) => void | Promise<void>;
  } = {},
): BridgeResource {
  return {
    kind: "cell",
    cell: {
      get,
      pull: get,
      ...(options.initialize && { initialize: options.initialize }),
      ...(options.set && { set: options.set }),
      ...(options.sink && { sink: options.sink }),
      ...(options.push && { push: options.push }),
    },
  };
}

describe("Fabric iframe bridge", () => {
  it("describes resources and performs cell operations", async () => {
    let count = 1;
    const listeners = new Set<(value: number) => void>();
    const bridge = createFabricBridge({
      count: {
        ...cellResource(
          () => count,
          {
            initialize: (value) => {
              if (count === undefined) count = value as number;
              return count;
            },
            set: (value) => {
              count = value as number;
              for (const listener of listeners) listener(count);
            },
            sink: (listener) => {
              listeners.add(listener as (value: number) => void);
              listener(count);
              return () =>
                listeners.delete(listener as (value: number) => void);
            },
          },
        ),
        schema: { type: "number", description: "Visible counter" },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).resolves.toEqual({
        protocol: "common-fabric-bridge",
        version: 2,
        resources: [{
          name: "count",
          kind: "cell",
          operations: ["get", "initialize", "pull", "set", "sink"],
          methods: [],
          schema: { type: "number", description: "Visible counter" },
        }],
      });

      const remote = client.cell<number>("count");
      await expect(remote.pull()).resolves.toBe(1);
      await expect(remote.initialize(99)).resolves.toBe(1);
      const updates: number[] = [];
      const unsubscribe = remote.sink((value) => {
        if (value !== undefined) updates.push(value);
      });
      await remote.set(2);
      await remote.pull();
      expect(updates).toEqual([1, 2]);
      unsubscribe();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("samples immediately, sinks synchronously, and pulls through a barrier", async () => {
    let value = 1;
    const listeners = new Set<(value: FabricValue | undefined) => void>();
    const pullStarted = Promise.withResolvers<void>();
    const releasePull = Promise.withResolvers<void>();
    const bridge = createFabricBridge({
      count: {
        kind: "cell",
        cell: {
          get: () => value,
          pull: async () => {
            pullStarted.resolve();
            await releasePull.promise;
            return value;
          },
          sink: (listener) => {
            listener(value);
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const cell = client.cell<number>("count");
      expect(cell.get()).toBeUndefined();
      const initial = Promise.withResolvers<void>();
      const seen: Array<number | undefined> = [];
      const cancel = cell.sink((current) => {
        seen.push(current);
        if (current === 1) initial.resolve();
      });
      expect(seen).toEqual([undefined]);
      await initial.promise;
      expect(seen).toEqual([undefined, 1]);
      expect(cell.get()).toBe(1);

      value = 2;
      const pulling = cell.pull();
      await pullStarted.promise;
      expect(cell.get()).toBe(1);
      releasePull.resolve();
      await expect(pulling).resolves.toBe(2);
      expect(cell.get()).toBe(2);
      cancel();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("tells a guest of a refused read as an error of its own code, never as a value", async () => {
    let sinkListener: ((value: FabricValue | undefined) => void) | undefined;
    let sinkFailed: BridgeSinkFailure | undefined;
    const bridge = createFabricBridge({
      secret: {
        kind: "cell",
        cell: {
          get: () => "shown before the seal",
          pull: () => {
            throw new BridgeReadRefusedError("refused by the display ceiling");
          },
          sink: (listener, failed) => {
            sinkListener = listener;
            sinkFailed = failed;
            listener("shown before the seal");
            return () => {};
          },
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.cell<string>("secret").pull()).rejects
        .toMatchObject({ code: BRIDGE_READ_REFUSED });

      const cell = client.cell<string>("secret");
      const seen: Array<string | undefined> = [];
      const withdrawn: Array<string | undefined> = [];
      const errors: string[] = [];
      let heard = Promise.withResolvers<string>();
      const cancelSink = cell.sink((current) => {
        seen.push(current);
        return () => withdrawn.push(current);
      }, (error) => errors.push(error.code));
      // The refusal of the pull above still stands, and the sink hears it
      // through `onError` alone: nothing is handed to the listener in the
      // value's place.
      expect(errors).toEqual([BRIDGE_READ_REFUSED]);
      expect(seen).toStrictEqual([]);
      const cancelSnapshot = cell.subscribeSnapshot((snapshot) => {
        heard.resolve(
          snapshot.status === "error" ? snapshot.error.code : snapshot.status,
        );
      });
      // The value the host's sink delivered first.
      heard = Promise.withResolvers<string>();
      await expect(heard.promise).resolves.toBe("ready");
      expect(sinkListener).toBeDefined();

      heard = Promise.withResolvers<string>();
      sinkFailed!({
        code: BRIDGE_READ_REFUSED,
        message: "refused by the display ceiling",
      });

      await expect(heard.promise).resolves.toBe(BRIDGE_READ_REFUSED);
      expect(cell.get()).toBeUndefined();
      // The sink hears the refusal, its value is withdrawn, and nothing is
      // handed to it in the value's place.
      expect(errors).toEqual([BRIDGE_READ_REFUSED, BRIDGE_READ_REFUSED]);
      // Strict: `toEqual()` takes a trailing `undefined` for no entry at all.
      expect(withdrawn).toStrictEqual(["shown before the seal"]);
      expect(seen).toStrictEqual(["shown before the seal"]);

      // A read admitted again ends the refusal, even one finding nothing.
      heard = Promise.withResolvers<string>();
      sinkListener!(undefined);
      await expect(heard.promise).resolves.toBe("ready");
      expect(seen).toStrictEqual(["shown before the seal", undefined]);
      cancelSink();
      cancelSnapshot();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("leaves a guest's sinks with their value when a write fails", async () => {
    const bridge = createFabricBridge({
      // A cell with no `set`, so a write fails with `method-not-supported`.
      locked: cellResource(() => "held", {
        sink: (listener) => {
          listener("held");
          return () => {};
        },
      }),
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const cell = client.cell<string>("locked");
      const seen: Array<string | undefined> = [];
      const withdrawn: Array<string | undefined> = [];
      const errors: string[] = [];
      const cancel = cell.sink((current) => {
        seen.push(current);
        return () => withdrawn.push(current);
      }, (error) => errors.push(error.code));
      await cell.pull();
      const withdrawnBefore = [...withdrawn];

      await expect(cell.set("written")).rejects.toMatchObject({
        code: "method-not-supported",
      });

      // The value never changed, so the host will not deliver it again: a
      // sink withdrawn for the failure would stay blank.
      expect(seen.at(-1)).toBe("held");
      expect(withdrawn).toStrictEqual(withdrawnBefore);
      expect(errors).toEqual([]);
      cancel();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("tells every sink of a refusal when one sink's `onError` throws, and keeps the pull's rejection", async () => {
    const bridge = createFabricBridge({
      secret: {
        kind: "cell",
        cell: {
          get: () => undefined,
          pull: () => {
            throw new BridgeReadRefusedError("refused by the display ceiling");
          },
          // Delivers nothing, so the pull's answer is the one heard.
          sink: () => () => {},
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const cell = client.cell<string>("secret");
      const heard: string[] = [];
      const cancelBroken = cell.sink(() => {}, () => {
        heard.push("broken");
        throw new Error("a broken consumer");
      });
      const cancelSound = cell.sink(() => {}, () => heard.push("sound"));

      await expect(cell.pull()).rejects.toMatchObject({
        code: BRIDGE_READ_REFUSED,
      });

      expect(heard).toEqual(["broken", "sound"]);
      cancelBroken();
      cancelSound();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("resolves a moving array entry before sinking and writing its path", async () => {
    type Item = { title: string; done: boolean };
    const records: Record<string, Item> = {
      a: { title: "A", done: false },
      b: { title: "B", done: false },
    };
    const order = ["a", "b"];
    const listeners = new Map<
      string,
      Set<(value: FabricValue | undefined) => void>
    >();
    const stableCell = (
      id: string,
      path: Array<string | number> = [],
    ): BridgeCell => {
      const get = (): FabricValue | undefined => {
        let value: unknown = records[id];
        for (const key of path) {
          value = (value as Record<string, unknown>)[String(key)];
        }
        return value as FabricValue;
      };
      return {
        identity: {
          id: `of:item:${id}`,
          space: "did:key:test",
          scope: "space",
          path: [...path],
        },
        get,
        pull: get,
        set: (value) => {
          const key = String(path.at(-1));
          (records[id] as unknown as Record<string, FabricValue>)[key] = value;
          for (
            const listener of listeners.get(`${id}:${path.join(".")}`) ?? []
          ) {
            listener(value);
          }
        },
        sink: (listener) => {
          const key = `${id}:${path.join(".")}`;
          const current = listeners.get(key) ?? new Set();
          listeners.set(key, current);
          current.add(listener);
          listener(get());
          return () => current.delete(listener);
        },
        key: (key) => stableCell(id, [...path, key]),
        resolve: () => stableCell(id, path),
      };
    };
    const items: BridgeCell = {
      get: () => order.map((id) => records[id]!),
      pull: () => order.map((id) => records[id]!),
      key: (key) => {
        const id = order[Number(key)];
        if (!id) throw new RangeError("No item at that position.");
        return {
          get: () => records[id],
          pull: () => records[id],
          resolve: () => stableCell(id),
        };
      },
    };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({ items: { kind: "cell", cell: items } }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const resolved = await client.cell<Item[]>("items").key(0).resolve();
      expect(resolved.identity).toEqual({
        id: "of:item:a",
        space: "did:key:test",
        scope: "space",
        path: [],
      });
      const title = resolved.key("title");
      const seen: Array<string | undefined> = [];
      const sinkReady = Promise.withResolvers<void>();
      const cancel = title.sink((value) => {
        seen.push(value);
        if (value === "A") sinkReady.resolve();
      });
      await sinkReady.promise;
      expect(seen).toEqual(["A"]);

      order.reverse();
      await resolved.key("done").set(true);
      expect(seen).toEqual(["A"]);
      await title.set("A moved");
      expect(records[order[1]!]!.title).toBe("A moved");
      expect(seen).toEqual(["A", "A moved"]);
      cancel();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("does not expand a resolved handle after its operations are minted", async () => {
    let initialized = false;
    const leaf: BridgeCell = {
      get: () => 1,
      pull: () => 1,
    };
    const root: BridgeCell = {
      get: () => 1,
      pull: () => 1,
      resolve: () => leaf,
    };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({ reader: { kind: "cell", cell: root } }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const descriptor = await client.request("resolve", {
        resource: "reader",
        path: [],
      }) as BridgeResolvedCell;
      Object.defineProperty(leaf, "initialize", {
        configurable: true,
        enumerable: true,
        value: () => {
          initialized = true;
          return 9;
        },
      });
      Object.defineProperty(leaf, "key", {
        configurable: true,
        enumerable: true,
        value: () => ({
          get: () => "secret",
          pull: () => "secret",
        }),
      });
      const forged = client.resolvedCell<number>({
        ...descriptor,
        operations: [...(descriptor.operations ?? []), "initialize"],
      });

      await expect(forged.initialize(9)).rejects.toMatchObject({
        code: "method-not-supported",
        resource: "reader",
      });
      expect(initialized).toBe(false);
      await expect(forged.key("secret").pull()).rejects.toMatchObject({
        code: "method-not-supported",
        resource: "reader",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("rejects an operation removed after its resolved authority is minted", async () => {
    const leaf: BridgeCell = {
      get: () => 1,
      initialize: () => 1,
      pull: () => 1,
    };
    const root: BridgeCell = {
      get: () => 1,
      pull: () => 1,
      resolve: () => leaf,
    };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({ reader: { kind: "cell", cell: root } }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const resolved = await client.cell<number>("reader").resolve();
      delete leaf.initialize;

      await expect(resolved.initialize(0)).rejects.toMatchObject({
        code: "method-not-supported",
        resource: "reader",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("carries push as append intent instead of replacing the array", async () => {
    const value = [0];
    const pushes: FabricValue[][] = [];
    const bridge = createFabricBridge({
      items: cellResource(() => value, {
        push: (members) => {
          pushes.push([...members]);
          for (const member of members as number[]) value.push(member);
        },
      }),
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const items = client.cell<number[]>("items");
      await items.pull();
      await Promise.all([items.push(1), items.push(2)]);
      expect(pushes).toEqual([[1], [2]]);
      expect(value).toEqual([0, 1, 2]);
      expect(items.get()).toEqual([0, 1, 2]);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("carries a list of any length to the host as one append", async () => {
    const members = Array.from({ length: 200_000 }, (_, index) => index);
    const pushes: (readonly FabricValue[])[] = [];
    const bridge = createFabricBridge({
      items: cellResource(() => [], {
        push: (values) => {
          pushes.push(values);
        },
      }),
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const items = client.cell<number[]>("items");
      await items.pull();
      await items.pushAll(members);
      expect(pushes.length).toBe(1);
      expect(pushes[0]).toEqual(members);
      expect(items.get()).toEqual(members);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("calls SQLite methods through the same discoverable resource", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const output = new FabricBytes(new Uint8Array([1, 2, 3]));
    const input = new FabricBytes(new Uint8Array([4, 5, 6]));
    const bridge = createFabricBridge({
      app: {
        kind: "sqlite",
        methods: {
          query: (input) => {
            calls.push({ method: "query", input });
            return {
              rows: [[
                ["id", 1],
                ["title", "Ship it"],
                ["payload", output],
                ["constructor", "safe-constructor"],
                ["__proto__", "safe-prototype"],
              ]],
            };
          },
          exec: (input) => {
            calls.push({ method: "exec", input });
          },
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const db = client.sqlite("app");
      const result = await db.query<{
        payload: FabricBytes;
        constructor: string;
        __proto__: string;
      }>(
        "SELECT * FROM todos",
      );
      expect(result.rows[0]?.payload).toBeInstanceOf(FabricBytes);
      expect(result.rows[0]?.payload.slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(Object.hasOwn(result.rows[0]!, "constructor")).toBe(true);
      expect(Object.hasOwn(result.rows[0]!, "__proto__")).toBe(true);
      expect(result.rows[0]?.constructor).toBe("safe-constructor");
      expect(result.rows[0]?.__proto__).toBe("safe-prototype");
      await db.exec("INSERT INTO todos(title, payload) VALUES (?, ?)", [
        "Test it",
        input,
      ]);
      expect(calls[0]).toEqual({
        method: "query",
        input: { sql: "SELECT * FROM todos" },
      });
      expect(calls[1]).toMatchObject({
        method: "exec",
        input: {
          sql: "INSERT INTO todos(title, payload) VALUES (?, ?)",
        },
      });
      const params = (calls[1]?.input as { params: unknown[] }).params;
      expect(params[1]).toBeInstanceOf(FabricBytes);
      expect((params[1] as FabricBytes).slice()).toEqual(
        new Uint8Array([4, 5, 6]),
      );
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("carries reserved SQLite parameter names as entries", async () => {
    let input: FabricValue | undefined;
    const bridge = createFabricBridge({
      database: {
        kind: "sqlite",
        methods: {
          query: (value) => {
            input = value;
            return { rows: [] };
          },
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const params = Object.fromEntries([
        ["constructor", 1],
        ["__proto__", 2],
      ]);
      await expect(
        client.sqlite("database").query(
          "SELECT :constructor, :__proto__",
          params,
        ),
      ).resolves.toEqual({ rows: [] });
      expect(input).toEqual({
        sql: "SELECT :constructor, :__proto__",
        namedParams: [["constructor", 1], ["__proto__", 2]],
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("completes earlier sets before later pulls", async () => {
    let value = 0;
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        count: {
          ...cellResource(
            () => value,
            {
              set: async (next) => {
                writeStarted.resolve();
                await releaseWrite.promise;
                value = next as number;
              },
            },
          ),
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const writing = client.cell<number>("count").set(1);
      await writeStarted.promise;
      const reading = client.cell<number>("count").pull();
      await nextTask();
      releaseWrite.resolve();

      await writing;
      await expect(reading).resolves.toBe(1);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("drops queued capability calls after host disconnect", async () => {
    let calls = 0;
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        service: {
          kind: "service",
          methods: { mutate: () => calls++ },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    const pending = client.call("service", "mutate");
    host.disconnect();
    await nextTask();
    await nextTask();
    expect(calls).toBe(0);
    client.disconnect();
    await pending.catch(() => {});
  });

  it("returns structured errors for missing capabilities", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(createFabricBridge({}), channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.cell("missing").pull()).rejects.toMatchObject({
        code: "resource-not-found",
        resource: "missing",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses inherited resource and method names", async () => {
    const inheritedResources = Object.create({
      inherited: {
        kind: "service",
        methods: { run: () => "wrong" },
      },
    }) as Record<string, {
      kind: "service";
      methods: Record<string, () => string>;
    }>;
    const methods = Object.create({ inherited: () => "wrong" }) as Record<
      string,
      () => string
    >;
    methods.own = () => "right";
    inheritedResources.service = { kind: "service", methods };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge(inheritedResources),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.call("inherited", "run")).rejects.toMatchObject({
        code: "resource-not-found",
      });
      await expect(client.call("service", "inherited")).rejects.toMatchObject({
        code: "method-not-supported",
      });
      await expect(client.call("service", "own")).resolves.toBe("right");
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses non-enumerable resources omitted from the manifest", async () => {
    const resources: Record<
      string,
      Parameters<
        typeof createFabricBridge
      >[0][string]
    > = {};
    Object.defineProperty(resources, "hidden", {
      enumerable: false,
      value: {
        kind: "service",
        methods: { reveal: () => "secret" },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge(resources),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).resolves.toMatchObject({ resources: [] });
      await expect(client.call("hidden", "reveal")).rejects.toMatchObject({
        code: "resource-not-found",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses resource accessors without invoking them", async () => {
    let accesses = 0;
    const resources: Record<
      string,
      Parameters<
        typeof createFabricBridge
      >[0][string]
    > = {};
    Object.defineProperty(resources, "secret", {
      enumerable: true,
      get: () => {
        accesses++;
        return {
          kind: "service",
          methods: { reveal: () => "secret" },
        };
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge(resources),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).rejects.toMatchObject({
        code: "operation-failed",
        message: "Bridge resource `secret` must be an own data property.",
      });
      await expect(client.call("secret", "reveal")).rejects.toMatchObject({
        code: "operation-failed",
        message: "Bridge resource `secret` must be an own data property.",
      });
      expect(accesses).toBe(0);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses inherited resource operations and method containers", async () => {
    let inheritedWrites = 0;
    const inherited = {
      set: () => inheritedWrites++,
      sink: () => () => {},
    };
    const cell = Object.create(inherited) as BridgeCell;
    cell.get = () => 1;
    cell.pull = () => 1;
    const resource: BridgeResource = { kind: "cell", cell };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({ count: resource }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).resolves.toMatchObject({
        resources: [{
          name: "count",
          operations: ["get", "pull"],
          methods: [],
        }],
      });
      await expect(client.cell("count").set(2)).rejects.toMatchObject({
        code: "method-not-supported",
      });
      await expect(client.call("count", "inherited")).rejects.toMatchObject({
        code: "method-not-supported",
      });
      expect(inheritedWrites).toBe(0);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("describes reserved resource names without inherited metadata", async () => {
    const resource = Object.create({
      schema: { secret: "inherited" },
      description: "inherited",
    }) as {
      kind: "service";
      methods: Record<string, () => string>;
    };
    resource.kind = "service";
    resource.methods = { ping: () => "pong" };
    const resources = Object.fromEntries([
      ["constructor", resource],
    ]);
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge(resources),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).resolves.toEqual({
        protocol: "common-fabric-bridge",
        version: 2,
        resources: [{
          name: "constructor",
          kind: "service",
          operations: [],
          methods: ["ping"],
        }],
      });
      await expect(client.call("constructor", "ping")).resolves.toBe("pong");
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses an inherited resource kind in the manifest", async () => {
    const resource = Object.create({ kind: "service" }) as {
      kind: "service";
      methods: Record<string, () => string>;
    };
    resource.methods = { ping: () => "pong" };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({ service: resource }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).rejects.toMatchObject({
        code: "operation-failed",
        message: "Bridge resource `service` must declare its own valid kind.",
      });
      await expect(client.call("service", "ping")).rejects.toMatchObject({
        code: "operation-failed",
        message: "Bridge resource `service` must declare its own valid kind.",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses non-callable named methods", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        service: {
          kind: "service",
          methods: { ping: "not callable" },
        } as unknown as Parameters<typeof createFabricBridge>[0][string],
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).rejects.toMatchObject({
        code: "operation-failed",
        message: "Bridge resource `service` method `ping` must be a function.",
      });
      await expect(client.call("service", "ping")).rejects.toMatchObject({
        code: "method-not-supported",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses named methods that collide with core operations", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        service: {
          kind: "service",
          methods: { pull: () => "named" },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).rejects.toMatchObject({
        code: "operation-failed",
        message:
          "Bridge resource `service` method `pull` collides with a core operation.",
      });
      await expect(client.call("service", "pull")).rejects.toMatchObject({
        code: "method-not-supported",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses named methods omitted from the manifest", async () => {
    const methods: Record<string, () => string> = {};
    Object.defineProperty(methods, "ping", {
      value: () => "pong",
      enumerable: false,
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({ service: { kind: "service", methods } }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).resolves.toMatchObject({
        resources: [{ name: "service", methods: [] }],
      });
      await expect(client.call("service", "ping")).rejects.toMatchObject({
        code: "method-not-supported",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("cancels host sinks when the guest disconnects", async () => {
    const subscribed = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        watched: {
          ...cellResource(() => undefined, {
            sink: () => {
              subscribed.resolve();
              return () => cancelled.resolve();
            },
          }),
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    client.sinkResource("watched", () => {});
    await subscribed.promise;
    client.disconnect();
    await cancelled.promise;

    host.disconnect();
  });

  it("continues host teardown when one cancellation throws", async () => {
    const firstSubscribed = Promise.withResolvers<void>();
    const secondSubscribed = Promise.withResolvers<void>();
    let secondCancelled = false;
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        first: {
          ...cellResource(() => undefined, {
            sink: () => {
              firstSubscribed.resolve();
              return () => {
                throw new Error("cancel failed");
              };
            },
          }),
        },
        second: {
          ...cellResource(() => undefined, {
            sink: () => {
              secondSubscribed.resolve();
              return () => {
                secondCancelled = true;
              };
            },
          }),
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    client.sinkResource("first", () => {});
    await firstSubscribed.promise;
    client.sinkResource("second", () => {});
    await secondSubscribed.promise;

    expect(() => host.disconnect()).not.toThrow();
    expect(secondCancelled).toBe(true);
    client.disconnect();
  });

  it("normalizes resource errors before sending them to the guest", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        guarded: {
          kind: "service",
          methods: {
            run: () => {
              throw { code: "denied", message: "Not allowed", resource: 42 };
            },
          },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.call("guarded", "run")).rejects.toMatchObject({
        code: "denied",
        message: "Not allowed",
        resource: "guarded",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("reports the first valid request once", async () => {
    const channel = new MessageChannel();
    const reported: FabricBridgeHost[] = [];
    const host = new FabricBridgeHost(
      createFabricBridge({ count: cellResource(() => 1) }),
      channel.port1,
      (session) => reported.push(session),
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.cell<number>("count").pull()).resolves.toBe(1);
      await expect(client.cell<number>("count").pull()).resolves.toBe(1);
      expect(reported.length).toBe(1);
      expect(reported[0]).toBe(host);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("acknowledges a flush to the guest port", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({}),
      channel.port1,
    );

    try {
      const arriving = new Promise((resolve) => {
        channel.port2.onmessage = (event) =>
          resolve(fabricFromRealmValue(event.data));
        channel.port2.start();
      });
      host.acknowledgeFlush("n1");
      await expect(arriving).resolves.toEqual({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "flush",
        nonce: "n1",
      });
    } finally {
      host.disconnect();
    }
  });
});
