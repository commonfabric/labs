/**
 * Adapts a `cf-iframe` cell context into explicit bridge capabilities. Scoped
 * children resolve before guest load, fixing each grant to its concrete cell.
 */

import {
  type BridgeCell,
  BridgeReadRefusedError,
  type BridgeResource,
  createFabricBridge,
  type FabricBridge,
  IPC,
  presenceResource,
} from "@commonfabric/iframe-sandbox";
import type { FabricValue } from "@commonfabric/data-model";
import {
  CellHandle,
  CellReadRefusedError,
  cellRefToIdentityKey,
  type ClientCellValue,
  isCellHandle,
} from "@commonfabric/runtime-client";
import type { JSONSchema } from "@commonfabric/runner/shared";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { presenceFailureCategory } from "../../core/presence-failure.ts";
import { valueForDisplay } from "../../core/value-for-display.ts";

/**
 * Capability kind assigned to a named context child. `presence` grants the
 * presence room of the child's resolved field, and none of the child's data.
 */
export type CellContextResourceKind =
  | "cell"
  | "readonly"
  | "stream"
  | "sqlite"
  | "presence";

function cellKind(schema: JSONSchema | undefined): string | undefined {
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.asCell)) {
    return undefined;
  }
  const entry = schema.asCell[0];
  return typeof entry === "string"
    ? entry
    : entry && typeof entry === "object" && "kind" in entry &&
        typeof entry.kind === "string"
    ? entry.kind
    : undefined;
}

function bridgeValue(value: unknown): FabricValue {
  if (isCellHandle(value)) return value.toSigilLink();
  if (Array.isArray(value)) return value.map(bridgeValue);
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return value as FabricValue;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, bridgeValue(member)]),
    );
  }
  return value as FabricValue;
}

function sqliteInput(value: FabricValue | undefined): {
  sql: string;
  params?: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SQLite operations require an object input.");
  }
  const input = value as Record<string, FabricValue>;
  if (typeof input.sql !== "string") {
    throw new TypeError("SQLite operations require a string `sql` field.");
  }
  const params = input.params;
  const namedParams = input.namedParams;
  if (params !== undefined && namedParams !== undefined) {
    throw new TypeError(
      "SQLite operations cannot carry both positional and named params.",
    );
  }
  if (
    params !== undefined && !Array.isArray(params) &&
    (!params || typeof params !== "object")
  ) {
    throw new TypeError("SQLite `params` must be an array or object.");
  }
  if (
    namedParams !== undefined &&
    (!Array.isArray(namedParams) ||
      namedParams.some((entry) =>
        !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string"
      ))
  ) {
    throw new TypeError("SQLite `namedParams` must be key-value entries.");
  }
  return {
    sql: input.sql,
    ...((params !== undefined || namedParams !== undefined) && {
      params: (namedParams === undefined
        ? params
        : Object.fromEntries(namedParams as Array<[string, FabricValue]>)) as
          | ReadonlyArray<ClientCellValue>
          | Record<string, ClientCellValue>,
    }),
  };
}

type SqliteOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

async function demandSqliteSource<T>(
  source: CellHandle<unknown>,
  authority: CellHandle<unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const demand = source.asSchema({ asCell: ["sqlite"] });
  // Held only to keep the producer demanded; its refusal is the operation's
  // to answer, and the operation is decided on its own.
  const cancel = demand.subscribe(() => {}, { onRefused: () => {} });
  try {
    await source.pull();
    const latest = await source.resolveAsCell();
    if (!latest.equals(authority)) {
      throw new TypeError(
        "SQLite source resolved outside its granted capability.",
      );
    }
    return await operation();
  } finally {
    cancel();
  }
}

/**
 * Runs `operation`, telling the guest of a refused read as one
 * (`BridgeReadRefusedError`), never as an empty value: a guest that read a
 * refusal as empty would show nothing for a cell that holds something, or
 * initialize it over what it holds.
 */
function refusedAsBridgeError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw asBridgeRefusal(error);
  }
}

/** As {@link refusedAsBridgeError}, for an operation that settles later. */
async function refusedAsBridgeErrorAsync<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asBridgeRefusal(error);
  }
}

function asBridgeRefusal(error: unknown): unknown {
  return error instanceof CellReadRefusedError
    ? new BridgeReadRefusedError(error.message)
    : error;
}

/**
 * The bridge cell for `cell`. A refused read reaches the guest as one, and a
 * write through a handle whose read is refused is refused, as for any writer.
 * The bridge host holds the path a guest named to a refusal of its read, so a
 * later request through the same path is refused its writes too, whichever
 * handle answers for the path by then.
 */
function bridgeCell(
  cell: CellHandle<unknown>,
  writable: boolean,
): BridgeCell {
  const ref = cell.ref();
  return {
    identity: {
      id: ref.id,
      instanceId: cell.runtime().cellInstanceId(ref),
      space: ref.space,
      ...(ref.scope !== undefined && { scope: ref.scope }),
      path: [...ref.path],
    },
    get: () => refusedAsBridgeError(() => bridgeValue(cell.get())),
    pull: () =>
      refusedAsBridgeErrorAsync(async () => bridgeValue(await cell.pull())),
    ...(writable && {
      // A refused stored value rejects rather than reading as none, so a
      // guest that initializes what it reads as empty writes nothing.
      initialize: (value: FabricValue) =>
        refusedAsBridgeErrorAsync(async () =>
          bridgeValue(await cell.initialize(value))
        ),
      set: (value: FabricValue) =>
        refusedAsBridgeErrorAsync(() => cell.setStrict(value)),
      push: (values: readonly FabricValue[]) =>
        refusedAsBridgeErrorAsync(() =>
          (cell as CellHandle<FabricValue[]>).pushAllStrict(values)
        ),
    }),
    // A handle that has read nothing yet holds no value, so the guest is
    // handed none until the worker answers: a guest that took the nothing
    // for a value would compute from it.
    hasValue: () => !("unread" in cell.lastRead()),
    sink: (listener, failed) =>
      cell.subscribe((value) => {
        if ("unread" in cell.lastRead()) return;
        listener(bridgeValue(value));
      }, {
        onRefused: (refusal) =>
          failed(
            new BridgeReadRefusedError(
              new CellReadRefusedError(refusal).message,
            ),
          ),
      }),
    key: (key) => bridgeCell(cell.key(key as never), writable),
    resolve: async () => bridgeCell(await cell.resolveAsCell(), writable),
  };
}

/**
 * Returns what a guest is told of `cause`, the failure of a presence room.
 * A relay's refusal is about the guest's own publication or join, so its
 * message is passed on; any other cause is named by category alone.
 */
function presenceBridgeFailure(cause: unknown): IPC.BridgeError {
  switch (presenceFailureCategory(cause)) {
    case "configuration":
      return {
        code: IPC.BRIDGE_PRESENCE_UNSUPPORTED,
        message: "The host has no presence relay to join.",
      };
    case "protocol":
      return {
        code: IPC.BRIDGE_PRESENCE_REFUSED,
        message: cause instanceof Error
          ? cause.message
          : "The presence relay refused the room.",
      };
    case "connection":
      return {
        code: IPC.BRIDGE_PRESENCE_DISCONNECTED,
        message: "The host lost the presence room.",
      };
  }
}

function cellResource(
  cell: CellHandle<unknown>,
  schema: JSONSchema | undefined,
  kindHint?: CellContextResourceKind,
  runSqliteOperation?: SqliteOperationRunner,
): BridgeResource {
  const kind = kindHint ?? cellKind(schema);
  const description = schema && typeof schema === "object" &&
      typeof schema.description === "string"
    ? schema.description
    : undefined;
  const metadata = {
    ...(schema !== undefined && { schema: schema as FabricValue }),
    ...(description !== undefined && { description }),
  };

  if (kind === "sqlite") {
    const revisionCell = cell.asSchema<Record<string, unknown>>({
      type: "object",
      additionalProperties: true,
    });
    return {
      kind: "sqlite",
      ...metadata,
      sink: (listener) => {
        let initial = true;
        const changed = () => {
          if (initial) {
            initial = false;
            return;
          }
          listener(undefined);
        };
        // A refusal tells the guest the database changed as far as it can
        // tell, so it asks again, and each query is answered on its own.
        return revisionCell.subscribe(changed, { onRefused: changed });
      },
      methods: {
        query: async (value) => {
          const { sql, params } = sqliteInput(value);
          const operation = async () => {
            const rows = await cell.querySqlite(sql, params);
            return {
              rows: rows.map((row) =>
                Object.entries(row).map(([key, member]) => [
                  key,
                  bridgeValue(member),
                ])
              ),
            };
          };
          return await (runSqliteOperation
            ? runSqliteOperation(operation)
            : operation());
        },
        exec: async (value) => {
          const { sql, params } = sqliteInput(value);
          const operation = async (): Promise<undefined> => {
            await cell.execSqlite(sql, params);
            return undefined;
          };
          return await (runSqliteOperation
            ? runSqliteOperation(operation)
            : operation());
        },
      },
    };
  }

  // A room is granted by the embedder's explicit kind alone: a schema that
  // declared one would let whoever wrote the schema announce the user.
  if (kindHint === "presence") {
    return presenceResource({
      join: () => cell.runtime().joinPresenceRoom(cell),
      failure: presenceBridgeFailure,
    }, metadata);
  }

  if (kind === "stream") {
    return {
      kind: "stream",
      ...metadata,
      methods: {
        // Waits for the handler's run, so a guest that reads after `send()`
        // resolves reads what the handler wrote, and hears of a refused run.
        send: async (value) => {
          await cell.sendStrict(value as ClientCellValue, {
            awaitHandling: true,
          });
        },
      },
    };
  }

  return {
    kind: "cell",
    ...metadata,
    cell: bridgeCell(cell, kind !== "readonly"),
  };
}

function localResource(
  context: Record<string, unknown>,
  name: string,
): BridgeResource {
  return {
    kind: "cell",
    cell: localCell(context, [name]),
  };
}

function localCell(
  root: Record<string, unknown>,
  path: Array<string | number>,
): BridgeCell {
  const get = (): FabricValue | undefined => {
    let value: unknown = root;
    for (const key of path) {
      if (!isObjectOrArray(value)) return undefined;
      const property = Object.getOwnPropertyDescriptor(value, String(key));
      if (!property || !("value" in property)) return undefined;
      value = property.value;
    }
    return bridgeValue(value);
  };
  return {
    get,
    pull: get,
    set: (value) => {
      let parent: Record<string, unknown> = root;
      for (const key of path.slice(0, -1)) {
        const property = Object.getOwnPropertyDescriptor(parent, String(key));
        const child = property && "value" in property
          ? property.value
          : undefined;
        if (!isObjectOrArray(child)) {
          throw new TypeError("Cannot descend through a non-object value.");
        }
        parent = child as Record<string, unknown>;
      }
      Object.defineProperty(parent, String(path.at(-1)), {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
    key: (key) => localCell(root, [...path, key]),
    resolve: () => localCell(root, path),
  };
}

function schemaProperties(
  schema: JSONSchema | undefined,
): Record<string, JSONSchema> {
  return schema && typeof schema === "object" && schema.properties &&
      typeof schema.properties === "object"
    ? schema.properties as Record<string, JSONSchema>
    : {};
}

function cellContextResources(
  root: CellHandle<Record<string, unknown>>,
): Record<string, BridgeResource> {
  // A context whose read is refused names the resources its schema declares,
  // each of which answers for its own reads.
  const names = (): Set<string> => {
    const current = valueForDisplay(root);
    return new Set([
      ...Object.keys(schemaProperties(root.ref().schema)),
      ...(current && typeof current === "object" ? Object.keys(current) : []),
    ]);
  };
  const resource = (name: string): BridgeResource | undefined => {
    const properties = schemaProperties(root.ref().schema);
    const current = valueForDisplay(root);
    if (
      !Object.hasOwn(properties, name) &&
      !(current && Object.hasOwn(current, name))
    ) {
      return undefined;
    }
    const propertySchema = properties[name];
    const value = current?.[name];
    const cell = isCellHandle(value)
      ? value
      : propertySchema === undefined
      ? root.key(name)
      : root.key(name).asSchema(propertySchema);
    return cellResource(cell, propertySchema ?? cell.ref().schema);
  };

  return new Proxy<Record<string, BridgeResource>>({}, {
    get: (_target, key) =>
      typeof key === "string" && names().has(key) ? resource(key) : undefined,
    ownKeys: () => [...names()],
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === "string" && names().has(key)
        ? {
          configurable: true,
          enumerable: true,
          value: resource(key),
        }
        : undefined,
  });
}

/**
 * The names of the fields `cell` holds: the keys of its value while the
 * worker admits the read, and the fields the worker lists. The list names
 * what the read leaves out, which is every field of a cell whose read is
 * refused, each of which answers for its own reads, and the cell fields of a
 * record a view binds inline (`$context={{ state, output }}`), whose read
 * stops at the record. None when the worker refuses both, or answers that
 * the cell holds no record.
 */
async function fieldNames<T>(cell: CellHandle<T>): Promise<string[]> {
  const names = new Set<string>();
  try {
    const current = await cell.pull();
    if (current && typeof current === "object") {
      for (const name of Object.keys(current)) names.add(name);
    }
  } catch (error) {
    if (!(error instanceof CellReadRefusedError)) throw error;
  }
  try {
    for (const name of Object.keys((await cell.fields()) ?? {})) {
      names.add(name);
    }
  } catch (error) {
    if (!(error instanceof CellReadRefusedError)) throw error;
  }
  return [...names];
}

/** Builds the convenience bridge used by `cf-iframe`'s `context` property. */
export function createCellContextBridge(context: object): FabricBridge {
  if (isCellHandle(context)) {
    return createFabricBridge(
      cellContextResources(
        context as CellHandle<Record<string, unknown>>,
      ),
    );
  }

  const current = context as Record<string, unknown>;
  const resources: Record<string, BridgeResource> = {};
  for (const name of Object.keys(current)) {
    resources[name] = localResource(current, name);
  }
  return createFabricBridge(resources);
}

/**
 * Resolves every named child of a bound context into one concrete resource.
 * A child is named by the context's schema, by the fields the context holds,
 * or by `resourceKinds`. The last is what names a stream: the worker lists a
 * record's fields as cells, and a stream is not one, so a record bound inline
 * with no schema of its own names its streams only through the kinds given.
 * A name `resourceKinds` alone gives is a resource only where the context
 * holds a link under it, so a name the context does not hold grants nothing.
 */
export async function resolveCellContextBridge(
  context: CellHandle<Record<string, unknown>>,
  resourceKinds: Readonly<Record<string, CellContextResourceKind>> = {},
): Promise<FabricBridge> {
  // A context whose read is refused still names its fields, each of which
  // answers for its own reads.
  const contextNames = await fieldNames(context);
  const root = await context.resolveAsCell();
  const properties = schemaProperties(root.ref().schema);
  const listed = new Set([
    ...Object.keys(properties),
    ...contextNames,
    ...await fieldNames(root),
  ]);
  const names = new Set([...listed, ...Object.keys(resourceKinds)]);
  const entries = await Promise.all([...names].map(async (name) => {
    const source = context.key(name);
    const kindHint = Object.hasOwn(resourceKinds, name)
      ? resourceKinds[name]
      : undefined;
    const declaredKind = kindHint ?? cellKind(properties[name]);
    if (declaredKind === "sqlite") {
      await source.pull();
    }
    const cell = await source.resolveAsCell();
    // An absent name resolves to the context's own path for it, which for a
    // context that is itself a link is a path of the record it links to.
    const reached = cellRefToIdentityKey(cell.ref());
    if (
      !listed.has(name) &&
      (reached === cellRefToIdentityKey(source.ref()) ||
        reached === cellRefToIdentityKey(root.key(name).ref()))
    ) {
      return undefined;
    }
    const resolvedSchema = cell.ref().schema;
    const runSqliteOperation: SqliteOperationRunner | undefined =
      declaredKind === "sqlite"
        ? (operation) => {
          // Demand the source path, not only its resolved target. A scoped SQLite
          // factory can be lazy for this browser session; the source path retains
          // the producer edge that materializes its concrete handle. Keep that
          // demand live through the fixed target's backend operation, and refuse
          // a source that has retargeted outside the granted authority.
          return demandSqliteSource(source, cell, operation);
        }
        : undefined;
    return [
      name,
      cellResource(
        cell,
        resolvedSchema,
        kindHint,
        runSqliteOperation,
      ),
    ] as const;
  }));
  return createFabricBridge(
    Object.fromEntries(entries.filter((entry) => entry !== undefined)),
  );
}
