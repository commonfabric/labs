// A component whose read contract entry is `complete` has its `$` binding
// decided on the contract's read alone, so what the component reads through
// the binding's handle, and what it opens beside it, must stay within that
// read. Each complete entry's component is mounted over a real `CellHandle`
// whose runtime records every request the handle sends, and every read is
// checked against the entry's schema. A read outside it is listed below with
// the reason the component makes it, or the entry is not complete.
//
// `Deno.test` rather than `describe`/`it`: `deno-web-test` runs this file, and
// does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  componentReadContracts,
  componentReadSchema,
} from "@commonfabric/runner/component-read-contract";

import "../index.ts";

/** A request a handle sent, with the cell it reads. */
type Read = { readonly type: string; readonly ref: CellRef };

/** Where a cell a component read came from. */
type Origin =
  | { readonly kind: "binding" }
  | {
    readonly kind: "address";
    readonly space: string;
    readonly cause: unknown;
  };

/**
 * A read a complete component makes outside its contract, with why the
 * component makes it. `admits` says whether `read`, of a cell from `origin`,
 * is that read.
 */
type ReadOutsideContract = {
  readonly reason: string;
  readonly admits: (read: Read, origin: Origin) => boolean;
};

/**
 * The reads each complete component makes outside its contract. Each is
 * reviewed like the component itself.
 */
const READS_OUTSIDE_CONTRACT: Readonly<
  Record<string, readonly ReadOutsideContract[]>
> = {
  "cf-profile-badge": [{
    reason: "The seal shows whether the profile is its space's root, which " +
      "`profileSpaceOf()` reads by opening the space's own cell by address, " +
      "loading it, and resolving its `defaultPattern` link.",
    admits: (read, origin) =>
      origin.kind === "address" && origin.cause === origin.space &&
      ((read.type === RequestType.CellGet && read.ref.path.length === 0) ||
        (read.type === RequestType.CellResolveAsCell &&
          read.ref.path.length === 1 &&
          read.ref.path[0] === "defaultPattern")),
  }],
};

/** The request types that answer with what a cell holds or how it is labeled. */
const READ_TYPES: ReadonlySet<string> = new Set([
  RequestType.CellGet,
  RequestType.CellPull,
  RequestType.CellInitialize,
  RequestType.CellResolveAsCell,
  RequestType.CellGetCfcLabel,
  RequestType.CellFields,
  RequestType.SqliteQuery,
]);

/** The read types that read a position rather than what it holds. */
const POSITION_READ_TYPES: ReadonlySet<string> = new Set([
  RequestType.CellResolveAsCell,
  RequestType.CellGetCfcLabel,
]);

/** The request types that read nothing a component could show. */
const NON_READ_TYPES: ReadonlySet<string> = new Set([
  RequestType.CellSet,
  RequestType.CellPush,
  RequestType.CellSend,
  RequestType.CellUnsubscribe,
]);

/** The schema at `path` within `schema`, as a read under `schema` reaches it. */
function schemaAt(
  schema: JSONSchema,
  path: readonly PropertyKey[],
): JSONSchema {
  let at: JSONSchema | undefined = schema;
  for (const step of path) {
    if (at === undefined || at === false) return false;
    if (at === true || isOpen(at)) return true;
    const key = String(step);
    at = at.properties?.[key] ??
      (/^\d+$/.test(key) && at.items !== undefined && !Array.isArray(at.items)
        ? at.items as JSONSchema
        : at.additionalProperties as JSONSchema | undefined);
  }
  return at ?? false;
}

/**
 * The schema the worker reads `ref` under: its own, or else the one the
 * nearest ancestor it was keyed from carries, narrowed to its path, and
 * everything where neither has one.
 */
function readSchemaOf(ref: CellRef): JSONSchema {
  if (ref.schema !== undefined) return ref.schema;
  if (ref.keyedFrom === undefined) return true;
  return schemaAt(ref.keyedFrom.schema, ref.path.slice(ref.keyedFrom.depth));
}

/** Whether `schema` reads everything at its position. */
function isOpen(schema: JSONSchema): boolean {
  return schema === true ||
    (typeof schema === "object" && Object.keys(schema).length === 0);
}

/** The keywords that say which positions a read reaches. */
const REACH_KEYWORDS = [
  "properties",
  "additionalProperties",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "$defs",
  "asCell",
];

/**
 * Whether a read under `read` reaches no position a read under `declared`
 * does not, answered conservatively: a shape it cannot compare reaches
 * beyond.
 */
function readWithin(read: JSONSchema, declared: JSONSchema): boolean {
  if (isOpen(declared) || read === false) return true;
  if (declared === false || isOpen(read)) return false;
  if (typeof read !== "object" || typeof declared !== "object") return false;
  // A position read as a cell reads nothing of it; what is read through the
  // cell it hands over is a read of that cell, checked as one.
  if (read.asCell !== undefined) return true;
  if (read.anyOf !== undefined) {
    return read.anyOf.every((branch) => readWithin(branch, declared));
  }
  if (declared.anyOf !== undefined) {
    return declared.anyOf.some((branch) => readWithin(read, branch));
  }
  for (const keyword of ["oneOf", "allOf", "$ref", "$defs"] as const) {
    if (keyword in read || keyword in declared) return false;
  }
  const reaches = REACH_KEYWORDS.some((keyword) => keyword in read);
  if (!reaches) {
    // A read that names no position reaches all of an object or list.
    return !REACH_KEYWORDS.some((keyword) => keyword in declared) ||
      (read.type !== "object" && read.type !== "array");
  }
  for (const [key, schema] of Object.entries(read.properties ?? {})) {
    const at = declared.properties?.[key] ?? declared.additionalProperties;
    if (at === undefined || !readWithin(schema, at)) return false;
  }
  if (
    read.additionalProperties !== undefined &&
    read.additionalProperties !== false &&
    (declared.additionalProperties === undefined ||
      !readWithin(read.additionalProperties, declared.additionalProperties))
  ) {
    return false;
  }
  if (read.items !== undefined) {
    if (Array.isArray(read.items) || Array.isArray(declared.items)) {
      return false;
    }
    if (
      declared.items !== undefined &&
      !readWithin(read.items as JSONSchema, declared.items as JSONSchema)
    ) {
      return false;
    }
  }
  return true;
}

/** Whether `schema` reads any position as a cell. */
function readsAsCell(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  if ("asCell" in schema) return true;
  return Object.values(schema).some(readsAsCell);
}

/**
 * A value of the shape `schema` reads, so that a component reading it goes
 * on to whatever it reads next; `undefined` where the schema names no shape.
 */
function sampleOf(schema: JSONSchema | undefined): unknown {
  if (typeof schema !== "object") return undefined;
  if (schema.anyOf !== undefined) return sampleOf(schema.anyOf[0]);
  switch (schema.type) {
    case "string":
      return "sample";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array": {
      const item = Array.isArray(schema.items)
        ? undefined
        : sampleOf(schema.items as JSONSchema | undefined);
      return item === undefined ? [] : [item];
    }
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
          const value = sampleOf(field);
          return value === undefined ? [] : [[key, value]];
        }),
      );
    default:
      return undefined;
  }
}

/** What `value` holds at `path`. */
function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let at = value;
  for (const step of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<PropertyKey, unknown>)[step];
  }
  return at;
}

/** Waits until every request answered so far has been taken in. */
function drained(): Promise<void> {
  // Every answer below is a settled promise, so a component's reads follow
  // one another in microtasks, and a macrotask runs once they are all done.
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * A runtime for a handle bound as `tag`'s `prop`, which answers each request
 * with a value of the shape `declared` reads and records it, with where its
 * cell came from. A property of the runtime this does not offer is recorded
 * among `unsupported`, so that a component that uses one makes the test say
 * so rather than pass over it.
 */
function recordingRuntime(bound: CellRef, declared: JSONSchema) {
  const reads: { read: Read; origin: Origin }[] = [];
  const unsupported: string[] = [];
  const origins = new Map<string, Origin>([
    [`${bound.space}/${bound.id}`, { kind: "binding" }],
  ]);
  const originOf = (ref: CellRef): Origin =>
    origins.get(`${ref.space}/${ref.id}`) ?? {
      kind: "address",
      space: ref.space,
      cause: undefined,
    };
  const sample = sampleOf(declared);
  const answer = (request: { type: string; cell?: CellRef }): unknown => {
    const ref = request.cell;
    if (ref === undefined) return {};
    const origin = originOf(ref);
    reads.push({ read: { type: request.type, ref }, origin });
    const value = origin.kind === "binding"
      ? valueAt(sample, ref.path)
      : undefined;
    switch (request.type) {
      case RequestType.CellResolveAsCell:
        return { cell: ref };
      case RequestType.CellGetCfcLabel:
        return { cfcLabel: undefined };
      case RequestType.CellFields:
        return {};
      default:
        return { value };
    }
  };
  let opened = 0;
  const conn = {
    request: (request: {
      type: string;
      cell?: CellRef;
      space?: string;
      cause?: unknown;
      schema?: JSONSchema;
    }) => {
      if (request.type === RequestType.GetCell) {
        const ref: CellRef = {
          id: `of:opened-by-address-${opened++}` as CellRef["id"],
          space: request.space as CellRef["space"],
          scope: "space",
          path: [],
          ...(request.schema === undefined ? {} : { schema: request.schema }),
        };
        origins.set(`${ref.space}/${ref.id}`, {
          kind: "address",
          space: request.space!,
          cause: request.cause,
        });
        return Promise.resolve({ cell: ref });
      }
      if (!READ_TYPES.has(request.type) && !NON_READ_TYPES.has(request.type)) {
        unsupported.push(`request ${request.type}`);
      }
      return Promise.resolve(answer(request));
    },
    subscribe: (cell: CellHandle<unknown>) => {
      const ref = cell.ref();
      const origin = originOf(ref);
      reads.push({ read: { type: "subscribe", ref }, origin });
      queueMicrotask(() =>
        cell[$onCellUpdate](
          origin.kind === "binding" ? valueAt(sample, ref.path) : undefined,
          { cfcLabel: undefined, current: true },
        )
      );
      return Promise.resolve();
    },
    unsubscribe: () => Promise.resolve(),
    peersOf: () => [],
  };
  const offered: Record<PropertyKey, unknown> = {
    [$conn]: () => conn,
    signal: new AbortController().signal,
    // A promise's resolution asks every value whether it is a thenable.
    then: undefined,
    getCell: async (space: string, cause: unknown, schema?: JSONSchema) =>
      new CellHandle(
        runtime,
        (await conn.request({
          type: RequestType.GetCell,
          space,
          cause,
          schema,
        }) as { cell: CellRef }).cell,
      ),
  };
  const runtime = new Proxy(offered, {
    get: (target, property) => {
      if (!(property in target)) {
        unsupported.push(`runtime.${String(property)}`);
      }
      return target[property];
    },
  }) as unknown as RuntimeClient;
  return { runtime, reads, unsupported };
}

const completeEntries = Object.entries(componentReadContracts).flatMap((
  [tag, props],
) =>
  Object.entries(props).flatMap(([prop, contract]) =>
    contract.complete === true ? [{ tag, prop, contract }] : []
  )
);

Deno.test("complete read contracts name components that are registered and read no position as a cell", () => {
  expect(completeEntries.length).toBeGreaterThan(0);
  for (const { tag, contract } of completeEntries) {
    expect({ tag, registered: customElements.get(tag) !== undefined })
      .toEqual({ tag, registered: true });
    // A position read as a cell hands the component a cell it reads further,
    // which a complete read does not cover.
    expect({ tag, readsAsCell: readsAsCell(contract.schema) })
      .toEqual({ tag, readsAsCell: false });
  }
});

for (const { tag, prop, contract } of completeEntries) {
  Deno.test(`${tag} ${prop} reads nothing outside its complete read contract`, async () => {
    // A projected entry reads its schema whatever the handle carries, so the
    // handle carries the widest; another reads the handle's own schema, so
    // the handle carries the one its entry declares.
    const supplied: JSONSchema = contract.projected ? true : contract.schema;
    const bound: CellRef = {
      id: "of:bound-by-the-reconciler" as CellRef["id"],
      space: "did:key:read-contract-drift" as CellRef["space"],
      scope: "space",
      path: [],
      schema: supplied,
    };
    const declared = componentReadSchema(tag, prop, supplied) ?? true;
    const { runtime, reads, unsupported } = recordingRuntime(bound, declared);
    const element = document.createElement(tag) as HTMLElement & {
      updateComplete?: Promise<unknown>;
    };
    (element as unknown as Record<string, unknown>)[prop] = new CellHandle(
      runtime,
      bound,
    );
    document.body.append(element);
    try {
      await element.updateComplete;
      await drained();
      expect(unsupported).toEqual([]);
      const outside = reads.filter(({ read, origin }) => {
        if (!READ_TYPES.has(read.type) && read.type !== "subscribe") {
          return false;
        }
        if (origin.kind === "binding") {
          const at = schemaAt(declared, read.ref.path);
          // Resolving a position's links, or reading its label, reads the
          // position and not what it holds, whatever schema the ref carries.
          const within = POSITION_READ_TYPES.has(read.type)
            ? at !== false
            : readWithin(readSchemaOf(read.ref), at);
          if (within) return false;
        }
        return !(READS_OUTSIDE_CONTRACT[tag] ?? []).some((listed) =>
          listed.admits(read, origin)
        );
      }).map(({ read, origin }) => ({
        type: read.type,
        origin: origin.kind,
        path: read.ref.path,
        schema: read.ref.schema,
      }));
      expect(outside).toEqual([]);
      // The component read the binding at all, so the check above saw it.
      expect(reads.some(({ origin }) => origin.kind === "binding")).toBe(true);
    } finally {
      element.remove();
    }
  });
}
