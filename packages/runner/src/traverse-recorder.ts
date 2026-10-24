import type { JSONSchema, SchemaPathSelector } from "@commonfabric/api";
import {
  cloneIfNecessary,
  type FabricValue,
  hashStringOf,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import { internSchema } from "@commonfabric/data-model-schema";
import {
  isSubschema,
  mapSubschemas,
} from "@commonfabric/data-model-schema/schema-walk";
import {
  formatExternalSchemaRef,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { mapLinkSchemas } from "@commonfabric/memory/v2/schema-table-links";

import { getLogger } from "../../utils/src/logger.ts";
import type { NormalizedFullLink } from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";
import { portableSnapshotId, portableSnapshotLinks } from "./data-uri.ts";
import {
  bindImmutableCells,
  hasInlineCellScheme,
  immutableCellsFor,
} from "./immutable-cell.ts";

const logger = getLogger("traverse-recorder", { enabled: true, level: "info" });

/**
 * Capture/replay fixture format for traverse workloads.
 *
 * A fixture is captured from a real run (pattern test, integration test, or
 * server query) via `CF_TRAVERSE_CAPTURE=<out.json>` and replayed by
 * `test/traverse-replay/replay.ts` against a corpus-backed read-only
 * transaction. The corpus stores each visited doc's full fact value (the
 * value at path `[]`), keyed by `space|scope|id|type`. Invocations record
 * every `SchemaObjectTraverser.traverse()` call in order, with selectors and
 * links interned into side tables (they repeat heavily).
 *
 * Known fidelity caveats (acceptable for benchmarking/regression use):
 * - Doc values are captured first-wins: if a doc is written mid-run, replay
 *   sees the earliest captured value for all invocations. Replay is still
 *   deterministic; prefer capturing steady-state phases.
 * - Client captures replay with `StandardObjectCreator` instead of the
 *   runtime's `TransformObjectCreator`, so cell/proxy construction cost is
 *   excluded; traversal control flow (branches taken, docs visited, reads
 *   issued) is preserved.
 */
export type TraverseFixtureAddress = {
  space: string;
  id: string;
  type: string;
  path: readonly string[];
  scope?: string;
};

export type TraverseFixtureInvocation = {
  /** Address passed to `SchemaObjectTraverser.traverse()`. */
  address: TraverseFixtureAddress;

  /** Index into the fixture's `selectors` table. */
  selector: number;

  /** Index into the fixture's `links` table, when traverse() got a link. */
  link?: number;

  /** `TraversalContext.traverseCells` (true on the query path). */
  traverseCells: boolean;

  /**
   * `TraversalContext.inlineArrayItemsInPlace`, written only when set. An
   * invocation without it replays with the setting off.
   */
  inlineArrayItemsInPlace?: true;

  /** Invocations sharing this id shared one `TraversalContext`. */
  context: number;

  /** Invocations sharing this id shared one `SchemaMemo`. */
  memo?: number;
};

export type TraverseFixture = {
  /** Format version; 2 is the one whose invocations carry `traverseCells`. */
  version: 2;

  meta: {
    name: string;
    source: string;
    capturedAt?: string;
    description?: string;
  };
  selectors: SchemaPathSelector[];
  links: NormalizedFullLink[];

  /** Full fact values keyed by `space|scope|id|type`. */
  docs: Record<string, FabricValue>;

  invocations: TraverseFixtureInvocation[];
};

export function fixtureDocKey(
  address: { space: string; id: string; type?: string; scope?: string },
): string {
  return `${address.space}|${address.scope ?? "space"}|${address.id}|` +
    `${address.type ?? "application/json"}`;
}

const DEFAULT_MAX_INVOCATIONS = 20_000;

/** @internal Exported for focused capture tests. */
export class TraverseCaptureRecorder {
  #docs = new Map<string, FabricValue>();
  #verifiedSchemaDocs = new Set<string>();

  #invocations: TraverseFixtureInvocation[] = [];

  #selectors: SchemaPathSelector[] = [];
  #selectorIndex = new Map<string, number>();
  #links: NormalizedFullLink[] = [];
  #linkIndex = new Map<string, number>();
  #contextIds = new WeakMap<object, number>();
  #nextContextId = 0;
  #memoIds = new WeakMap<object, number>();
  #nextMemoId = 0;
  #capHit = false;
  #maxInvocations: number;

  /** Constructs an instance that records at most `maxInvocations`. */
  constructor(maxInvocations = DEFAULT_MAX_INVOCATIONS) {
    this.#maxInvocations = maxInvocations;
  }

  #idFor(map: WeakMap<object, number>, obj: object, next: () => number) {
    let id = map.get(obj);
    if (id === undefined) {
      id = next();
      map.set(obj, id);
    }
    return id;
  }

  #internSelector(selector: SchemaPathSelector): number {
    selector = portableSnapshotLinks(selector) as SchemaPathSelector;
    const key = hashStringOf(selector);
    let index = this.#selectorIndex.get(key);
    if (index === undefined) {
      index = this.#selectors.length;
      // Snapshot via deep-frozen clone (identity-passes already-frozen
      // selectors): callers may mutate or intern them later.
      this.#selectors.push(
        cloneIfNecessary(selector) as SchemaPathSelector,
      );
      this.#selectorIndex.set(key, index);
    }
    return index;
  }

  #internLink(link: NormalizedFullLink): number {
    link = portableSnapshotLinks({
      ...link,
      id: portableSnapshotId(link.id),
    }) as unknown as NormalizedFullLink;
    const key = hashStringOf(link);
    let index = this.#linkIndex.get(key);
    if (index === undefined) {
      index = this.#links.length;
      this.#links.push(
        cloneIfNecessary(
          link,
        ) as unknown as NormalizedFullLink,
      );
      this.#linkIndex.set(key, index);
    }
    return index;
  }

  recordInvocation(
    doc: { address: IMemorySpaceAddress },
    selector: SchemaPathSelector,
    link: NormalizedFullLink | undefined,
    context: { traverseCells: boolean; inlineArrayItemsInPlace?: boolean },
    memo: object | undefined,
  ): void {
    if (this.#invocations.length >= this.#maxInvocations) {
      if (!this.#capHit) {
        this.#capHit = true;
        logger.warn("capture", () => [
          `invocation cap (${this.#maxInvocations}) hit; later traversals ` +
          "are not recorded (docs still are)",
        ]);
      }
      return;
    }
    const { space, id, type, path, scope } = doc.address;
    this.#invocations.push({
      address: {
        space,
        id: portableSnapshotId(id),
        type: type ?? "application/json",
        path: [...path],
        scope,
      },
      selector: this.#internSelector(selector),
      ...(link !== undefined && { link: this.#internLink(link) }),
      traverseCells: context.traverseCells,
      ...(context.inlineArrayItemsInPlace &&
        { inlineArrayItemsInPlace: true as const }),
      context: this.#idFor(
        this.#contextIds,
        context,
        () => this.#nextContextId++,
      ),
      ...(memo !== undefined && {
        memo: this.#idFor(this.#memoIds, memo, () => this.#nextMemoId++),
      }),
    });
  }

  /**
   * Capture the full doc behind `address` (value at path `[]`) once per doc.
   * Reads through the *unwrapped* tx with a scheduling-ignored meta so the
   * extra read does not perturb reactivity logs.
   */
  #captureDoc(
    tx: IExtendedStorageTransaction,
    address: IMemorySpaceAddress,
  ): void {
    // Inline cells have no replica document. Capture makes native snapshots
    // portable data URIs, which replay decodes directly.
    if (hasInlineCellScheme(address.id)) return;
    const key = fixtureDocKey(address);
    if (this.#docs.has(key)) return;
    const { ok } = tx.read(
      {
        space: address.space,
        id: address.id,
        type: address.type,
        ...(address.scope !== undefined && { scope: address.scope }),
        path: [],
      },
      { meta: ignoreReadForScheduling },
    );
    if (ok !== undefined && ok.value !== undefined) {
      if (
        address.id.startsWith("cid:") && isFabricPlainObject(ok.value) &&
        isSubschema(ok.value.value) &&
        `cid:${
            internSchema(cloneIfNecessary(ok.value.value), true)
              .taggedHashString
          }` ===
          address.id
      ) {
        this.#verifiedSchemaDocs.add(key);
      }
      this.#docs.set(
        key,
        cloneIfNecessary(portableSnapshotLinks(ok.value)),
      );
    }
  }

  /**
   * Wrap a transaction so every read/readOrThrow/trackReadPaths first
   * snapshots the target doc into the corpus. All other members delegate to
   * the original tx.
   */
  wrapTx(tx: IExtendedStorageTransaction): IExtendedStorageTransaction {
    // deno-lint-ignore no-this-alias
    const recorder = this;
    const wrapped = new Proxy(tx, {
      get(target, prop) {
        if (prop === "read" || prop === "readOrThrow") {
          return (address: IMemorySpaceAddress, options?: IReadOptions) => {
            recorder.#captureDoc(target, address);
            // deno-lint-ignore no-explicit-any
            return (target as any)[prop](address, options);
          };
        }
        if (prop === "trackReadPaths" && target.trackReadPaths !== undefined) {
          return (
            address: Omit<IMemorySpaceAddress, "path">,
            paths: readonly (readonly string[])[],
            options?: Omit<IReadOptions, "trackReadWithoutLoad">,
          ) => {
            const firstPath = paths[0];
            if (firstPath !== undefined) {
              recorder.#captureDoc(target, {
                ...address,
                path: [...firstPath],
              });
            }
            return target.trackReadPaths!(address, paths, options);
          };
        }
        // deno-lint-ignore no-explicit-any
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    bindImmutableCells(wrapped, immutableCellsFor(tx));
    return wrapped;
  }

  toFixture(name: string, source: string): TraverseFixture {
    // Portable IDs change schema content. Readdress verified schema documents
    // dependency-first, and rewrite schema positions against the same corpus.
    // Missing or invalid documents stay missing or invalid in the replay.
    const docs = new Map<string, FabricValue>();
    const ids = new Map<string, string>();
    const active = new Set<string>();
    type Context = { space: string; scope?: string; type?: string };
    const rewriteRef = (ref: string, context: Context): string => {
      const parsed = parseExternalSchemaRef(ref);
      if (parsed === undefined) return ref;
      const id = rewriteDoc(`cid:${parsed.taggedHash}`, {
        ...context,
        scope: "space",
        type: "application/json",
      });
      return formatExternalSchemaRef(id.slice(4), parsed.defName);
    };
    const rewriteSchema = (
      schema: JSONSchema,
      context: Context,
    ): JSONSchema => {
      if (typeof schema === "boolean") return schema;
      const children = mapSubschemas(
        schema,
        (child) => rewriteSchema(child, context),
        { includeDefs: true, includeUnused: true },
      );
      const ref = typeof children.$ref === "string"
        ? rewriteRef(children.$ref, context)
        : children.$ref;
      const result = ref === children.$ref
        ? children
        : { ...children, $ref: ref };
      // Defaults may themselves contain links with reader schemas.
      return mapLinkSchemas(
        result,
        (nested) =>
          isSubschema(nested) ? rewriteSchema(nested, context) : nested,
      ) as JSONSchema;
    };
    const rewriteValue = (value: FabricValue, context: Context): FabricValue =>
      mapLinkSchemas(
        value,
        (schema) =>
          isSubschema(schema) ? rewriteSchema(schema, context) : schema,
      );
    const rewriteDoc = (id: string, context: Context): string => {
      const key = fixtureDocKey({ ...context, id });
      const cached = ids.get(key);
      if (cached !== undefined) return cached;
      const fact = this.#docs.get(key);
      if (fact === undefined) return id;
      // External schema groups are acyclic; recursive members use local $defs.
      if (active.has(key)) {
        throw new Error("Circular captured schema documents");
      }
      active.add(key);
      let result = rewriteValue(fact, context);
      let nextId = id;
      if (isFabricPlainObject(result)) {
        if (this.#verifiedSchemaDocs.has(key) && isSubschema(result.value)) {
          const schema = internSchema(
            rewriteSchema(result.value, context),
            true,
          );
          nextId = `cid:${schema.taggedHashString}`;
          result = { ...result, value: schema.schemaOrUndefined };
        }
        if (isSubschema(result.schema)) {
          result = { ...result, schema: rewriteSchema(result.schema, context) };
        }
      }
      ids.set(key, nextId);
      docs.set(
        fixtureDocKey({ ...context, id: nextId }),
        cloneIfNecessary(result),
      );
      active.delete(key);
      return nextId;
    };
    for (const key of this.#docs.keys()) {
      const [space, scope, id, type] = key.split("|");
      rewriteDoc(id, { space, scope, type });
    }
    const selectors: SchemaPathSelector[] = [];
    const links: NormalizedFullLink[] = [];
    const selectorIndices = new Map<string, number>();
    const linkIndices = new Map<string, number>();
    const intern = <T extends FabricValue>(
      value: T,
      table: T[],
      index: Map<string, number>,
    ): number => {
      const hash = hashStringOf(value);
      const previous = index.get(hash);
      if (previous !== undefined) return previous;
      const position = table.length;
      table.push(value);
      index.set(hash, position);
      return position;
    };
    const invocations = this.#invocations.map((invocation) => {
      const context = invocation.address;
      const selector = this.#selectors[invocation.selector];
      const selectorIndex = intern(
        {
          ...selector,
          schema: selector.schema === undefined
            ? undefined
            : rewriteSchema(selector.schema, context),
        },
        selectors,
        selectorIndices,
      );
      const link = invocation.link === undefined
        ? undefined
        : this.#links[invocation.link];
      const linkIndex = link === undefined ? undefined : intern(
        {
          ...link,
          id: rewriteDoc(link.id, link) as NormalizedFullLink["id"],
          schema: link.schema === undefined
            ? undefined
            : rewriteSchema(link.schema, link),
        },
        links,
        linkIndices,
      );
      return {
        ...invocation,
        address: { ...context, id: rewriteDoc(context.id, context) },
        selector: selectorIndex,
        ...(link !== undefined && { link: linkIndex }),
      };
    });
    return {
      version: 2,
      meta: {
        name,
        source,
        capturedAt: new Date().toISOString(),
      },
      selectors,
      links,
      docs: Object.fromEntries(
        [...docs.entries()].sort(([a], [b]) => a < b ? -1 : 1),
      ),
      invocations,
    };
  }

  /**
   * Writes the capture to `path` as plain JSON (this module is bundled for
   * browsers, so no `node:zlib` here); gzip the output afterwards to check it
   * in as a fixture.
   */
  flush(path: string): void {
    const name = path.split("/").pop()?.replace(/\.json(\.gz)?$/, "") ??
      "capture";
    const fixture = this.toFixture(name, `CF_TRAVERSE_CAPTURE=${path}`);
    Deno.writeTextFileSync(path, JSON.stringify(fixture));
    logger.info("capture", () => [
      `wrote ${path}: ${this.#docs.size} docs, ` +
      `${this.#invocations.length} invocations, ` +
      `${this.#selectors.length} selectors, ${this.#links.length} links`,
    ]);
  }
}

let active: TraverseCaptureRecorder | undefined;

function capturePathFromEnv(): string | undefined {
  try {
    // Not available (or not permitted) in browser/sandboxed builds.
    return typeof Deno !== "undefined" && typeof Deno.env?.get === "function"
      ? Deno.env.get("CF_TRAVERSE_CAPTURE") || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

const capturePath = capturePathFromEnv();
if (capturePath !== undefined) {
  const max = Number(
    (() => {
      try {
        return Deno.env.get("CF_TRAVERSE_CAPTURE_MAX");
      } catch {
        return undefined;
      }
    })() ?? DEFAULT_MAX_INVOCATIONS,
  );
  active = new TraverseCaptureRecorder(
    Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_INVOCATIONS,
  );
  logger.info("capture", () => [
    `traverse capture enabled, writing to ${capturePath} on unload`,
  ]);
  globalThis.addEventListener("unload", () => {
    active!.flush(capturePath);
  });
  // Long-running processes (e.g. a local toolshed) rarely exit cleanly, so
  // "unload" alone would lose the capture. Flush periodically too; the timer
  // is unref'd so it never keeps a process alive.
  const flushTimer = setInterval(() => {
    try {
      active!.flush(capturePath);
    } catch (error) {
      logger.warn("capture", () => ["periodic flush failed", error]);
    }
  }, 30_000);
  Deno.unrefTimer(flushTimer);
}

/**
 * No-op passthrough unless `CF_TRAVERSE_CAPTURE` is set, in which case the
 * returned tx snapshots every doc it reads into the capture corpus.
 */
export function wrapTxForTraverseCapture(
  tx: IExtendedStorageTransaction,
): IExtendedStorageTransaction {
  return active === undefined ? tx : active.wrapTx(tx);
}

/**
 * Record one `SchemaObjectTraverser.traverse()` invocation. No-op unless
 * capture is enabled.
 */
export function recordTraverseInvocation(
  doc: { address: IMemorySpaceAddress },
  selector: SchemaPathSelector,
  link: NormalizedFullLink | undefined,
  context: { traverseCells: boolean; inlineArrayItemsInPlace?: boolean },
  memo: object | undefined,
): void {
  active?.recordInvocation(doc, selector, link, context, memo);
}
