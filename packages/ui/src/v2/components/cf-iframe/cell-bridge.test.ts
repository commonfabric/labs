/** Exercises CellHandle capability adaptation, including scoped resources. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { BRIDGE_READ_REFUSED } from "@commonfabric/iframe-sandbox";
import {
  $conn,
  $onCellRefused,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  createCellContextBridge,
  resolveCellContextBridge,
} from "./cell-bridge.ts";

describe("cf-iframe cell bridge", () => {
  const ref: CellRef = {
    id: "of:context" as CellRef["id"],
    space: "did:key:test" as CellRef["space"],
    scope: "space",
    path: [],
    schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Shared counter" },
        locked: {
          type: "string",
          asCell: ["readonly"],
          description: "Read-only value",
        },
        events: {
          type: "object",
          asCell: ["stream"],
          description: "Application events",
        },
        database: {
          type: "object",
          asCell: ["sqlite"],
          description: "Notes database",
        },
      },
    },
  };

  const runtimeStub = <T extends object>(runtime: T): RuntimeClient =>
    Object.assign(runtime, {
      cellInstanceId: (cell: CellRef) =>
        JSON.stringify({
          id: cell.id,
          path: cell.path,
          scope: cell.scope,
          space: cell.space,
        }),
    }) as unknown as RuntimeClient;

  it("turns context properties into described cell capabilities", async () => {
    const requests: unknown[] = [];
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requests.push(request);
          if (
            request.type === RequestType.CellGet ||
            request.type === RequestType.CellPull
          ) {
            return Promise.resolve({ value: 2 });
          }
          if (request.type === RequestType.CellInitialize) {
            return Promise.resolve({ value: 1 });
          }
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const bridge = createCellContextBridge(context);
    const count = bridge.resources.count;
    expect(count.kind).toBe("cell");
    expect(count.description).toBe("Shared counter");
    await expect(count.cell!.pull()).resolves.toBe(2);
    await expect(count.cell!.initialize!(0)).resolves.toBe(1);
    await count.cell!.set!(3);
    expect(requests).toEqual([{
      type: RequestType.CellPull,
      cell: {
        ...ref,
        path: ["count"],
        schema: { type: "number", description: "Shared counter" },
      },
    }, {
      type: RequestType.CellInitialize,
      cell: {
        ...ref,
        path: ["count"],
        schema: { type: "number", description: "Shared counter" },
      },
      value: 0,
    }, {
      type: RequestType.CellSet,
      cell: {
        ...ref,
        path: ["count"],
        schema: { type: "number", description: "Shared counter" },
      },
      value: 3,
      awaitCommit: true,
    }]);
  });

  it("derives path sinks, resolves stable identities, and sends push intent", async () => {
    const requests: Array<
      { type: RequestType; cell: CellRef; values?: unknown[] }
    > = [];
    const subscriptions: CellRef[] = [];
    const itemsRef: CellRef = {
      ...ref,
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        },
      },
    };
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: (
          request: { type: RequestType; cell: CellRef; values?: unknown[] },
        ) => {
          requests.push(request);
          if (request.type === RequestType.CellResolveAsCell) {
            return Promise.resolve({
              cell: {
                ...request.cell,
                id: "of:item-a",
                path: [],
              },
            });
          }
          if (request.type === RequestType.CellPull) {
            return Promise.resolve({ value: "A" });
          }
          return Promise.resolve({});
        },
        subscribe: (cell: CellHandle<unknown>) => {
          subscriptions.push(cell.ref());
          return Promise.resolve();
        },
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, itemsRef, {
      items: [{ title: "A" }],
    });
    const items = createCellContextBridge(context).resources.items.cell!;

    const positionalTitle = items.key!(0).key!("title");
    const cancel = positionalTitle.sink!(() => {}, () => {});
    expect(subscriptions.at(-1)?.path).toEqual(["items", "0", "title"]);
    cancel();

    const stable = await items.key!(0).resolve!();
    expect(stable.identity).toMatchObject({
      id: "of:item-a",
      instanceId: JSON.stringify({
        id: "of:item-a",
        path: [],
        scope: "space",
        space: "did:key:test",
      }),
      scope: "space",
      path: [],
    });
    await expect(stable.key!("title").pull()).resolves.toBe("A");
    await items.push!([{ title: "B" }]);

    expect(
      requests.find(({ type }) => type === RequestType.CellPull)?.cell,
    ).toMatchObject({ id: "of:item-a", path: ["title"] });
    expect(
      requests.find(({ type }) => type === RequestType.CellPush),
    ).toMatchObject({
      cell: { id: "of:context", path: ["items"] },
      values: [{ title: "B" }],
    });
  });

  it("adapts plain object properties without a runtime connection", async () => {
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: () => Promise.reject(new Error("request should not be used")),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const linked = new CellHandle(runtime, ref);
    const marker = new Date(0);
    const inherited = { hidden: "prototype" };
    const record = Object.assign(Object.create(inherited), {
      visible: "own",
    }) as Record<string, unknown>;
    const context = {
      count: 1,
      nested: { linked },
      marker,
      record,
    };

    const bridge = createCellContextBridge(context);

    expect(Object.keys(bridge.resources)).toEqual([
      "count",
      "nested",
      "marker",
      "record",
    ]);
    expect(bridge.resources.nested.cell!.get()).toEqual({
      linked: linked.toJSON(),
    });
    expect(bridge.resources.marker.cell!.get()).toBe(marker);
    await bridge.resources.count.cell!.set!(2);
    expect(context.count).toBe(2);
    const hidden = bridge.resources.record.cell!.key!("hidden");
    expect(await hidden.pull()).toBeUndefined();
    await hidden.set!("own");
    expect(record.hidden).toBe("own");
    expect(inherited.hidden).toBe("prototype");
  });

  it("discovers context properties that materialize after bridge creation", async () => {
    const requests: unknown[] = [];
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requests.push(request);
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const lateRef: CellRef = {
      ...ref,
      schema: { type: "object" },
    };
    const context = new CellHandle<Record<string, unknown>>(
      runtime,
      lateRef,
      {},
    );
    const bridge = createCellContextBridge(context);

    expect(Object.keys(bridge.resources)).toEqual([]);
    await context.setStrict({ command: "" });
    context[$onCellUpdate]({ command: "" });

    expect(Object.keys(bridge.resources)).toEqual(["command"]);
    expect(bridge.resources.missing).toBeUndefined();
    expect(bridge.resources.constructor).toBeUndefined();
    expect(bridge.resources.__proto__).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(
        bridge.resources,
        Symbol.iterator,
      ),
    ).toBeUndefined();
    const command = bridge.resources.command;
    expect(command.kind).toBe("cell");
    await command.cell!.set!("next");
    const write = requests.at(-1) as {
      type: RequestType;
      cell: CellRef;
      value: unknown;
    };
    expect(write.type).toBe(RequestType.CellSet);
    expect(write.cell.path).toEqual(["command"]);
    expect(write.value).toBe("next");
  });

  it("resolves sparse scoped aliases before exposing resources", async () => {
    const requests: Array<{ type: RequestType; cell: CellRef }> = [];
    const resolved = {
      command: {
        scope: "session" as const,
        schema: { type: "string" },
      },
      database: {
        scope: "space" as const,
        schema: { type: "object", properties: {} },
      },
    };
    const databaseSchema = { $ref: "cid:fid1:sqlite-schema" };
    let idleCalls = 0;
    const runtime = runtimeStub({
      idle: () => {
        idleCalls++;
        return Promise.resolve();
      },
      [$conn]: () => ({
        request: (request: { type: RequestType; cell: CellRef }) => {
          requests.push(request);
          if (request.type === RequestType.CellGet) {
            if (request.cell.id === "of:database") {
              return Promise.resolve({
                value: {
                  id: "fid1:database",
                  tables: { notes: { type: "object" } },
                  scope: "space",
                },
              });
            }
            return Promise.resolve({
              value: {
                command: undefined,
                database: {
                  id: "fid1:database",
                  tables: { notes: { type: "object" } },
                  scope: "space",
                },
              },
            });
          }
          if (request.type === RequestType.CellPull) {
            return Promise.resolve({
              value: request.cell.path[0] === "database" ||
                  request.cell.id === "of:database"
                ? {
                  id: "fid1:database",
                  tables: { notes: { type: "object" } },
                  scope: "space",
                }
                : undefined,
            });
          }
          if (request.type === RequestType.SqliteQuery) {
            return Promise.resolve({ rows: [] });
          }
          if (request.type === RequestType.CellResolveAsCell) {
            if (request.cell.path.length === 0) {
              return Promise.resolve({
                cell: {
                  ...request.cell,
                  id: "of:resolved-context",
                  schema: {
                    type: "object",
                    properties: {
                      command: resolved.command.schema,
                      database: databaseSchema,
                    },
                  },
                },
              });
            }
            const name = request.cell.path[0] as keyof typeof resolved;
            return Promise.resolve({
              cell: {
                ...request.cell,
                id: `of:${name}`,
                scope: resolved[name].scope,
                path: [],
                schema: resolved[name].schema,
              },
            });
          }
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle<Record<string, unknown>>(runtime, {
      ...ref,
      schema: true,
    });

    const bridge = await resolveCellContextBridge(context, {
      database: "sqlite",
    });

    expect(Object.keys(bridge.resources)).toEqual(["command", "database"]);
    expect(bridge.resources.command.kind).toBe("cell");
    expect(bridge.resources.database.kind).toBe("sqlite");
    await expect(
      bridge.resources.database.methods!.query({ sql: "SELECT 1" }),
    ).resolves.toEqual({ rows: [] });
    expect(idleCalls).toBe(0);
    expect(
      requests.filter(({ type }) => type === RequestType.CellPull).map(
        ({ cell }) => cell.path,
      ),
    ).toEqual([[], [], ["database"], ["database"]]);
    expect(
      requests.filter(({ type, cell }) =>
        type === RequestType.CellResolveAsCell && cell.path.length > 0
      ).map(({ cell }) => ({
        path: cell.path,
        scope: cell.scope,
        schema: cell.schema,
      })),
    ).toEqual([
      { path: ["command"], scope: "space", schema: undefined },
      {
        path: ["database"],
        scope: "space",
        schema: undefined,
      },
      {
        path: ["database"],
        scope: "space",
        schema: undefined,
      },
    ]);
  });

  it("holds lazy scoped SQLite demand through backend readiness", async () => {
    const subscriptions: CellRef[] = [];
    const idle = Promise.withResolvers<void>();
    const reachedIdle = Promise.withResolvers<void>();
    const databaseValue = {
      id: "fid1:user-database",
      scope: "user",
      owner: "did:key:user",
      tables: {},
    };
    let materialized = false;
    let retargeted = false;
    let sqliteQueries = 0;
    let demandedSource: CellHandle<unknown> | undefined;
    const runtime = runtimeStub({
      idle: () => {
        reachedIdle.resolve();
        return idle.promise;
      },
      [$conn]: () => ({
        request: async (request: { type: RequestType; cell: CellRef }) => {
          if (request.type === RequestType.CellGet) {
            return Promise.resolve({
              value: request.cell.id === "of:user-database" && materialized
                ? databaseValue
                : { database: undefined },
            });
          }
          if (request.type === RequestType.CellPull) {
            if (request.cell.path[0] === "database" && !materialized) {
              reachedIdle.resolve();
              await idle.promise;
            }
            return {
              value: request.cell.id === "of:user-database" && materialized
                ? databaseValue
                : undefined,
            };
          }
          if (request.type === RequestType.CellResolveAsCell) {
            return Promise.resolve({
              cell: request.cell.path.length === 0
                ? {
                  ...request.cell,
                  id: "of:resolved-context",
                  schema: {
                    type: "object",
                    properties: {
                      database: { type: "object", properties: {} },
                    },
                  },
                }
                : {
                  ...request.cell,
                  id: retargeted
                    ? "of:other-user-database"
                    : "of:user-database",
                  scope: "user",
                  path: [],
                  schema: { type: "object", properties: {} },
                },
            });
          }
          if (request.type === RequestType.SqliteQuery) {
            sqliteQueries++;
            if (!demandedSource) {
              return Promise.reject(
                new TypeError("SQLite source demand ended before the query."),
              );
            }
            if (!materialized) {
              return Promise.reject(
                new TypeError(
                  "SQLite query ran before its authority was ready.",
                ),
              );
            }
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({});
        },
        subscribe: (cell: CellHandle<unknown>) => {
          subscriptions.push(cell.ref());
          if (cell.ref().path[0] === "database") {
            demandedSource = cell;
          }
          return Promise.resolve();
        },
        unsubscribe: (cell: CellHandle<unknown>) => {
          if (demandedSource === cell) demandedSource = undefined;
          return Promise.resolve();
        },
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle<Record<string, unknown>>(runtime, {
      ...ref,
      schema: true,
    });

    const resolving = resolveCellContextBridge(context, {
      database: "sqlite",
    });
    await reachedIdle.promise;
    expect(sqliteQueries).toBe(0);
    materialized = true;
    idle.resolve();
    const bridge = await resolving;
    await expect(
      bridge.resources.database.methods!.query({ sql: "SELECT 1" }),
    ).resolves.toEqual({ rows: [] });
    expect(materialized).toBe(true);
    expect(demandedSource).toBeUndefined();
    expect(subscriptions.map(({ path }) => path)).toContainEqual(["database"]);
    expect(
      subscriptions.find(({ path }) => path[0] === "database")?.schema,
    ).toEqual({ asCell: ["sqlite"] });
    retargeted = true;
    await expect(
      bridge.resources.database.methods!.query({ sql: "SELECT 2" }),
    ).rejects.toThrow("resolved outside its granted capability");
    expect(sqliteQueries).toBe(1);
  });

  it("ignores inherited resource-kind hints", async () => {
    const requests: Array<{ type: RequestType; cell: CellRef }> = [];
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: (request: { type: RequestType; cell: CellRef }) => {
          requests.push(request);
          if (request.type === RequestType.CellGet) {
            return Promise.resolve({ value: { database: "ordinary" } });
          }
          if (request.type === RequestType.CellResolveAsCell) {
            return Promise.resolve({
              cell: {
                ...request.cell,
                id: request.cell.path.length === 0
                  ? "of:resolved-context"
                  : "of:database",
                path: [],
                schema: request.cell.path.length === 0
                  ? { type: "object", properties: { database: true } }
                  : true,
              },
            });
          }
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle<Record<string, unknown>>(runtime, {
      ...ref,
      schema: true,
    });
    const inheritedHints = Object.create({ database: "sqlite" }) as Record<
      string,
      "sqlite"
    >;

    const bridge = await resolveCellContextBridge(context, inheritedHints);

    expect(bridge.resources.database.kind).toBe("cell");
    expect(bridge.resources.database.methods).toBeUndefined();
    expect(
      requests.some(({ type, cell }) =>
        type === RequestType.CellPull && cell.path.length > 0
      ),
    ).toBe(false);
  });

  it("reports a cell write the runtime refuses", async () => {
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: () => Promise.reject(new Error("write refused")),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const count = createCellContextBridge(context).resources.count;

    await expect(count.cell!.set!(3)).rejects.toThrow("write refused");
  });

  it("omits writes from read-only cell capabilities", async () => {
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: (request: { type: RequestType }) =>
          request.type === RequestType.CellPull
            ? Promise.resolve({ value: "fixed" })
            : Promise.resolve({}),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, { locked: "fixed" });

    const locked = createCellContextBridge(context).resources.locked;

    expect(locked.kind).toBe("cell");
    expect(locked.description).toBe("Read-only value");
    await expect(locked.cell!.pull()).resolves.toBe("fixed");
    expect(locked.cell!.set).toBeUndefined();
  });

  it("sinks the current value synchronously before later changes", () => {
    let subscribed: CellHandle<number> | undefined;
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: () => Promise.resolve({}),
        subscribe: (cell: CellHandle<number>) => {
          subscribed = cell;
          return Promise.resolve();
        },
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });
    const count = createCellContextBridge(context).resources.count;
    const changes: unknown[] = [];

    const unsubscribe = count.cell!.sink!(
      (value) => changes.push(value),
      () => {},
    );
    subscribed?.[$onCellUpdate](2);

    expect(changes).toEqual([1, 2]);
    unsubscribe();
  });

  describe("a read the worker refuses", () => {
    // A guest is told of a refused read with an error of its own code, never
    // handed an empty value: one that read the refusal as empty would show
    // nothing for a cell that holds something, or initialize over it.
    const refusal = { refusedBy: "display-ceiling" } as const;

    /** A runtime that answers every read with a refusal, keeping requests. */
    const refusing = () => {
      let subscribed: CellHandle<unknown> | undefined;
      const requests: { type: RequestType }[] = [];
      const runtime = runtimeStub({
        [$conn]: () => ({
          request: (request: { type: RequestType }) => {
            requests.push(request);
            return Promise.resolve({ refused: refusal });
          },
          subscribe: (cell: CellHandle<unknown>) => {
            subscribed = cell;
            return Promise.resolve();
          },
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      });
      return { runtime, requests, subscribed: () => subscribed };
    };

    it("tells a sink of a refusal as a failure, and hands it no value", () => {
      const { runtime, subscribed } = refusing();
      const context = new CellHandle(runtime, ref, { count: 1 });
      const count = createCellContextBridge(context).resources.count;
      const values: unknown[] = [];
      const failures: { code: string }[] = [];

      const cancel = count.cell!.sink!(
        (value) => values.push(value),
        (error) => failures.push(error),
      );
      const before = values.length;
      subscribed()?.[$onCellRefused](refusal);

      expect(values.length).toBe(before);
      expect(failures).toEqual([
        expect.objectContaining({ code: BRIDGE_READ_REFUSED }),
      ]);
      cancel();
    });

    for (const operation of ["pull", "initialize", "set", "push"] as const) {
      it(`rejects a guest's \`${operation}()\` with the refusal's own code`, async () => {
        const { runtime, requests } = refusing();
        const context = new CellHandle(runtime, ref, { count: 1 });
        const count = createCellContextBridge(context).resources.count.cell!;
        if (operation === "set" || operation === "push") {
          // A read refused first, as a guest learns it before it writes.
          await expect(count.pull()).rejects.toMatchObject({
            code: BRIDGE_READ_REFUSED,
          });
          requests.length = 0;
        }

        const attempt = operation === "pull"
          ? count.pull()
          : operation === "initialize"
          ? count.initialize!(0)
          : operation === "set"
          ? count.set!(2)
          : count.push!([2]);

        await expect(attempt).rejects.toMatchObject({
          code: BRIDGE_READ_REFUSED,
        });
        if (operation === "set" || operation === "push") {
          expect(requests).toEqual([]);
        }
      });
    }

    it("resolves a refused context to the resources its schema declares", async () => {
      const runtime = runtimeStub({
        [$conn]: () => ({
          request: (request: { type: RequestType; cell: CellRef }) =>
            Promise.resolve(
              request.type === RequestType.CellResolveAsCell
                ? { cell: request.cell }
                : { refused: refusal },
            ),
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
          signal: { aborted: false },
        }),
      });
      const context = new CellHandle<Record<string, unknown>>(runtime, ref);

      const bridge = await resolveCellContextBridge(context, {
        database: "cell",
      });

      expect(Object.keys(bridge.resources).sort()).toEqual(
        ["count", "database", "events", "locked"],
      );
    });

    it("names the resources a refused context's schema declares", () => {
      const { runtime } = refusing();
      const context = new CellHandle<Record<string, unknown>>(runtime, ref);

      const bridge = createCellContextBridge(context);

      expect(Object.keys(bridge.resources).sort()).toEqual(
        ["count", "database", "events", "locked"],
      );
    });
  });

  it("reports a stream event the runtime refuses", async () => {
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: () => Promise.reject(new Error("event refused")),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const events = createCellContextBridge(context).resources.events;

    await expect(events.methods!.send({ type: "refresh" })).rejects.toThrow(
      "event refused",
    );
  });

  it("exposes SQLite query and exec as methods on one database resource", async () => {
    const requests: unknown[] = [];
    let subscribed: CellHandle<Record<string, unknown>> | undefined;
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requests.push(request);
          if (request.type === RequestType.SqliteQuery) {
            return Promise.resolve({
              rows: [Object.fromEntries([
                ["title", "One"],
                ["constructor", "safe-constructor"],
                ["__proto__", "safe-prototype"],
              ])],
            });
          }
          return Promise.resolve({});
        },
        subscribe: (cell: CellHandle<Record<string, unknown>>) => {
          subscribed = cell;
          return Promise.resolve();
        },
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const database = createCellContextBridge(context).resources.database;
    expect(database.kind).toBe("sqlite");
    let invalidations = 0;
    const unsubscribe = database.sink!(() => invalidations++);
    expect(subscribed?.ref().schema).toEqual({
      type: "object",
      additionalProperties: true,
    });
    subscribed?.[$onCellUpdate]({ id: "db-1", rev: 1 });
    expect(invalidations).toBe(1);
    unsubscribe();
    await expect(database.methods!.query({
      sql: "SELECT title FROM notes WHERE id = ?",
      params: [1],
    })).resolves.toEqual({
      rows: [[
        ["title", "One"],
        ["constructor", "safe-constructor"],
        ["__proto__", "safe-prototype"],
      ]],
    });
    await database.methods!.exec({
      sql: "SELECT :constructor, :__proto__",
      namedParams: [["constructor", "New"], ["__proto__", "Prototype"]],
    });

    const databaseRef = {
      ...ref,
      path: ["database"],
      schema: {
        type: "object",
        asCell: ["sqlite"],
        description: "Notes database",
      },
    };
    expect(requests).toEqual([{
      type: RequestType.SqliteQuery,
      cell: databaseRef,
      sql: "SELECT title FROM notes WHERE id = ?",
      params: {
        kind: "positional",
        values: [1],
      },
    }, {
      type: RequestType.SqliteExec,
      cell: databaseRef,
      sql: "SELECT :constructor, :__proto__",
      params: {
        kind: "named",
        entries: [
          ["constructor", "New"],
          ["__proto__", "Prototype"],
        ],
      },
    }]);
  });

  it("rejects malformed SQLite operation inputs before sending a request", async () => {
    const runtime = runtimeStub({
      [$conn]: () => ({
        request: () => {
          throw new Error("request should not be sent");
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    });
    const context = new CellHandle(runtime, ref, {
      database: { id: "db-1" },
    });
    const query = createCellContextBridge(context).resources.database.methods!
      .query;

    await expect(query(undefined)).rejects.toThrow("object input");
    await expect(query({ params: [] })).rejects.toThrow("string `sql`");
    await expect(query({ sql: "SELECT 1", params: 1 })).rejects.toThrow(
      "array or object",
    );
    await expect(
      query({ sql: "SELECT 1", namedParams: [[1, "bad"]] }),
    ).rejects.toThrow("key-value entries");
  });
});
