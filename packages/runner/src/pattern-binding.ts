import {
  debugStr,
  fabricAwareEqual,
  FabricInstance,
  FabricPrimitive,
  isKeyableObjectOrArray,
  isWalkableObjectOrArray,
  valueEqual,
} from "@commonfabric/data-model";
import { deepFrozenCloneAndInternSchema } from "@commonfabric/data-model-schema";
import { getServerExecutionConfig } from "@commonfabric/memory/v2";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { isAliasBinding } from "./alias-binding.ts";
import { noteDerivedCopy } from "./builder/pattern-metadata.ts";
import type {
  Cell,
  CellScope,
  DerivedInternalCellDescriptor,
} from "./builder/types.ts";
import {
  type FabricExecValue,
  isPattern,
  type JSONSchema,
  type JSONValue,
  type SchemaScope,
} from "./builder/types.ts";
import { type AnyCell, internCellLinkSchema } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { readMaybeLink, resolveLink } from "./link-resolution.ts";
import { toMemorySpaceAddress } from "./link-types.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCellLink,
  getMetaLink,
  isCellLink,
  isSigilLink,
  isWriteRedirectLink,
  KeepAsCell,
  type NormalizedFullLink,
  parseLink,
  sanitizeAndInternSchemaForLinks,
  sigilLinkAddressOnly,
} from "./link-utils.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { isCellScope, narrowerScopeCap, scopeRank } from "./scope.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  internalVerifierRead,
  machineryRead,
} from "./storage/reactivity-log.ts";

type SendValueToBindingOptions = {
  narrowestReadScope?: CellScope;
  preserveLinkOutput?: boolean;
  derivedInternalCells?: readonly DerivedInternalCellDescriptor[];
};

type UnwrapOneLevelOptions = {
  targetSchema?: JSONSchema;
  derivedInternalCells?: readonly DerivedInternalCellDescriptor[];

  /**
   * The containing pattern's authored argument schema, used as the source of
   * declared cell scopes when serializing binding aliases (see
   * `foldDeclaredScopeIntoLinkSchema`). The argument cell LINK only carries a
   * sanitized schema (`sanitizeSchemaForLinks` strips `asCell` entries,
   * taking their scope annotation with them), so a `PerUser<Cell<>>`
   * declaration is invisible on the link by the time aliases are bound. The
   * authored pattern schema keeps `asCell` (`keepAsCell: KeepAsCell.All` in
   * builder/pattern.ts) and is the ground truth for what each slot declared.
   * (Internal cells don't need this: each derived internal cell carries its
   * declared scope on its descriptor, realized directly on its link.)
   */
  sourceSchemas?: {
    argument?: JSONSchema;
  };

  /**
   * The containing pattern's authored argument schema, read only for the
   * follow caps an argument binding's path passes through (see
   * `linkForPath`). Unlike `sourceSchemas`, it does not fold the slot's own
   * declared scope into the binding.
   */
  argumentCapSchema?: JSONSchema;
};

/**
 * Folds the source slot's declared cell scope into the serialized alias link's
 * schema, making the stored link self-describing.
 *
 * A binding alias serialized into a sub-piece's argument doc carries the
 * sub-pattern's (typically scope-silent) input schema, not the parent slot's
 * schema — so the parent's `PerUser`/`PerSession` declaration (emitted as
 * `asCell: [{kind, scope}]`) is dropped, and any consumer of the stored link
 * must rely on the stored base-slot redirect existing to land reads and writes
 * in the scoped instance. Folding the declared scope into the link's schema
 * (as a top-level `scope`, which survives link-schema sanitization where
 * `asCell` entries do not) keeps the serialized graph self-describing: writes
 * through the link take the scope-narrowing branch and reads get the follow
 * cap, per "scope lives in the schema, realized at read/write".
 *
 * The scope is not stamped onto the link's own `scope`, as for every binding
 * `linkForPath` produces: the link addresses the base-scope slot, where
 * passed-in cell references live (see the matching guidance on
 * ContextualFlowControl.getSchemaScopeCap).
 *
 * Folding applies exactly when the write-path narrowing branch would fire for
 * the slot (declared scope narrower than the slot's link scope) and the
 * emitted schema does not declare a scope of its own (a local declaration
 * wins). Slots whose emitted link carries no schema at all are left alone so
 * they keep inheriting the reader's schema during link resolution.
 */
const foldDeclaredScopeIntoLinkSchema = (
  link: NormalizedFullLink,
  authoredRootSchema: JSONSchema | undefined,
  path: readonly string[],
): NormalizedFullLink => {
  if (authoredRootSchema === undefined || !isObjectOrArray(link.schema)) {
    return link;
  }
  const emittedSchema = sanitizeAliasSchemaForBinding(link.schema);
  if (
    !isObjectOrArray(emittedSchema) ||
    ContextualFlowControl.getSchemaScopeCap(emittedSchema) !== undefined
  ) {
    return link;
  }
  const authoredSlotSchema = path.length > 0
    ? ContextualFlowControl.getSchemaAtPath(authoredRootSchema, [...path])
    : authoredRootSchema;
  const declaredCap = ContextualFlowControl.getSchemaScopeCap(
    authoredSlotSchema,
  );
  if (
    !isCellScope(declaredCap) ||
    scopeRank(declaredCap) <= scopeRank(link.scope)
  ) {
    return link;
  }
  return {
    ...link,
    schema: deepFrozenCloneAndInternSchema({
      ...emittedSchema,
      scope: declaredCap,
    }),
  };
};

/** The narrower of the follow caps `schema` declares on a value or handle. */
const declaredScopeCap = (
  schema: JSONSchema | undefined,
): SchemaScope | undefined =>
  narrowerScopeCap(
    ContextualFlowControl.getSchemaScopeCap(schema),
    ContextualFlowControl.getAsCellFollowScopeCap(schema),
  );

/**
 * Returns `link` navigated to `path`, carrying the slot's schema. The link
 * keeps its own scope: a scope the slot's schema declares is realized when
 * the link is read (as a follow cap) or written (content narrows into the
 * scoped instance behind a base-slot redirect). The base slot is where a
 * passed-in reference is stored and where that redirect lives, so a binding
 * that addressed the scoped instance directly would miss a passed reference.
 *
 * A cap declared on a slot the path passes through governs a link stored at
 * that slot. A link schema drops cell wrappers and the caps they declare, so
 * the caps are read from `authoredRootSchema` as well when the caller has it.
 * The serialized binding has only the leaf schema to carry them, so when the
 * leaf declares no scope of its own, the narrowest such cap is folded
 * into the leaf schema's `scope`, which link resolution applies to links found
 * above the leaf as well.
 */
const linkForPath = (
  link: NormalizedFullLink,
  path: readonly string[],
  schemaOverride?: JSONSchema,
  authoredRootSchema?: JSONSchema,
): NormalizedFullLink => {
  let ancestorCap: SchemaScope | undefined;
  let walked = link.schema;
  let authored = authoredRootSchema;
  for (const key of path) {
    ancestorCap = narrowerScopeCap(
      ancestorCap,
      narrowerScopeCap(declaredScopeCap(walked), declaredScopeCap(authored)),
    );
    walked = ContextualFlowControl.getSchemaAtPath(walked, [key]);
    authored = ContextualFlowControl.getSchemaAtPath(authored, [key]);
  }
  let schema = schemaOverride ?? (path.length > 0 ? walked : undefined);
  if (
    isObjectNotArray(schema) && isCellScope(ancestorCap) &&
    declaredScopeCap(schema) === undefined
  ) {
    schema = deepFrozenCloneAndInternSchema({ ...schema, scope: ancestorCap });
  }
  return {
    ...link,
    path: [...path],
    ...(schema !== undefined && { schema }),
  };
};

const sanitizeAliasSchemaForBinding = (schema: JSONSchema): JSONSchema =>
  // Compiled aliases retain asCell for schema fidelity. A live redirect carries
  // a link schema, which keeps only stream wrappers: the redirect addresses
  // the slot, and a cell wrapper describes what is read through it.
  sanitizeAndInternSchemaForLinks(schema, KeepAsCell.OnlyStream);

/**
 * Returns a link with a canonical schema without freezing the caller's input.
 */
const canonicalSchemaLink = (
  link: NormalizedFullLink | undefined,
): NormalizedFullLink | undefined => {
  if (link === undefined || !isObjectOrArray(link.schema)) return link;
  const schema = sanitizeAndInternSchemaForLinks(link.schema, KeepAsCell.All);
  return schema === link.schema ? link : { ...link, schema };
};

const descriptorForPartialCauseAlias = (
  partialCause: JSONValue,
  descriptors: readonly DerivedInternalCellDescriptor[] | undefined,
): DerivedInternalCellDescriptor | undefined => {
  const descriptor = descriptors?.find((descriptor) =>
    deepEqual(descriptor.partialCause, partialCause)
  );
  return descriptor;
};

/**
 * Sends a value to a binding. If the binding is an array or object, it'll
 * traverse the binding and the value in parallel accordingly. If the binding is
 * an alias, it will follow all aliases and send the value to the last aliased
 * doc. If the binding is a literal, we verify that it matches the value and
 * throw an error otherwise.
 *
 * @param tx - The transaction to use for updates
 * @param cell - The document or cell context
 * @param argumentCellLink - The link to the argument cell
 * @param binding - The binding to send to
 * @param value - The value to send
 */
export function sendValueToBinding<T>(
  tx: IExtendedStorageTransaction,
  cell: AnyCell<T>,
  argumentCellLink: NormalizedFullLink | undefined,
  binding: unknown,
  value: unknown,
  options: SendValueToBindingOptions = {},
): void {
  // Result-write plumbing is machinery (machineryRead): the redirect walk
  // and the diff reads at plumbing containers must not consume `*`-path
  // membership templates (template-population §6, the SC-8 machinery-read
  // boundary) — the action body's own reads carry the taint. Every caller
  // is the runner's result plumbing; no user code runs inside.
  tx.runWithAmbientReadMeta(
    machineryRead,
    () =>
      sendValueToBindingInner(
        tx,
        cell,
        argumentCellLink,
        binding,
        value,
        options,
      ),
  );
}

function sendValueToBindingInner<T>(
  tx: IExtendedStorageTransaction,
  cell: AnyCell<T>,
  argumentCellLink: NormalizedFullLink | undefined,
  binding: unknown,
  value: unknown,
  options: SendValueToBindingOptions = {},
): void {
  if (argumentCellLink === undefined) {
    argumentCellLink = getMetaLink(cell as Cell<unknown>, "argument")!;
  }
  // A binding reaches a write target either as a sigil write redirect or as
  // an `$alias` record. The second is only meaningful because `binding` comes
  // from a pattern node graph; the link predicates do not match it, so this
  // function resolves it here against the instance's argument and result
  // cells. This and `unwrapOneLevelAndBindToDoc` below are the only two
  // places that do.
  if (isWriteRedirectLink(binding) || isAliasBinding(binding)) {
    if (isAliasBinding(binding)) {
      const alias = binding.$alias;
      if ((alias.defer ?? 0) > 0) {
        throw new Error(
          debugStr`Cannot write to deferred alias: $quote,long${binding}`,
        );
      }
      if (alias.partialCause !== undefined) {
        const partialCause = alias.partialCause;
        const descriptor = descriptorForPartialCauseAlias(
          partialCause,
          options.derivedInternalCells,
        )!;
        binding = createSigilLinkFromParsedLink(
          linkForPath(
            getDerivedInternalCellLink(cell as any, descriptor),
            alias.path,
            alias.schema,
          ),
          { includeSchema: true, overwrite: "redirect" },
        );
      } else if (typeof alias.cell !== "string") {
        throw new Error(
          debugStr`Invalid pseudo-alias cell: $quote,long${binding}`,
        );
      } else {
        // Certain strings have special meaning as the cell id
        const link = alias.cell === "argument"
          ? argumentCellLink
          : alias.cell === "result"
          ? cell.getAsNormalizedFullLink()
          : undefined;
        if (link === undefined) {
          throw new Error("Invalid pseudo-alias path: " + alias.path);
        }
        const path = alias.path;
        binding = createSigilLinkFromParsedLink(
          linkForPath(link, path, alias.schema),
          { includeSchema: true, overwrite: "redirect" },
        );
      }
    }

    const bindingLink = parseLink(binding, cell)!;
    const ref = resolveLink(
      cell.runtime,
      tx,
      bindingLink,
      "writeRedirect",
      { preserveOverwrite: true },
    );
    const outputScope = options.narrowestReadScope;
    if (
      outputScope !== undefined &&
      scopeRank(outputScope) > scopeRank(ref.scope)
    ) {
      const scopedRef = { ...ref, scope: outputScope };
      const valueLink = isCellLink(value) ? parseLink(value, ref) : undefined;
      if (
        valueLink === undefined ||
        !areNormalizedLinksSame(valueLink, scopedRef)
      ) {
        diffAndUpdate(
          cell.runtime,
          tx,
          scopedRef,
          value,
          { cell: cell.getAsNormalizedFullLink(), binding },
          { meta: ignoreReadForScheduling, schemaRole: "output" },
        );
      }
      // The eager via-user hop (scopes.md §2's MUST, flag-gated so the
      // OFF arm keeps today's one-hop-per-event behavior): a
      // space→session narrowing writes CHAINED redirects, space→user→
      // session — ALWAYS via user, even when discovery jumps straight to
      // session, so every chain has the one uniform shape and a later
      // user-level reader finds a well-formed user link to follow.
      if (
        getServerExecutionConfig() &&
        outputScope === "session" &&
        scopeRank(ref.scope) < scopeRank("user")
      ) {
        const userRef = { ...ref, scope: "user" as const };
        tx.writeValueOrThrow(
          userRef,
          createSigilLinkFromParsedLink(scopedRef, {
            base: userRef,
          }),
        );
        tx.writeValueOrThrow(
          bindingLink,
          createSigilLinkFromParsedLink(userRef, {
            base: bindingLink,
          }),
        );
        return;
      }
      if (
        getServerExecutionConfig() && scopeRank(ref.scope) > scopeRank("space")
      ) {
        // The chain's DEEPEST existing hop is a SCOPED slot (the shared
        // space slot already redirects to user — a sibling narrowed
        // first, or this run's own earlier discovery): a further
        // narrowing points THAT slot — this run's own instance of it —
        // at the narrower instance, and leaves the shared broad redirect
        // alone (server-execution v2 fan-out stage B, the RAGGED case —
        // scopes.md §2 as amended 2026-08-16: narrowing below the
        // space→user hop is per principal, so Bob's session hop lives in
        // `user:bob`, never on the space slot everyone follows). Writing
        // the redirect at the ORIGINAL binding link here (the OFF arm's
        // one-hop shape below) would repoint the SHARED space slot at
        // `session` and every other principal's next read would resolve
        // a session instance of a node that is user-scoped for them.
        tx.writeValueOrThrow(
          ref,
          createSigilLinkFromParsedLink(scopedRef, { base: ref }),
        );
        return;
      }
      tx.writeValueOrThrow(
        bindingLink,
        createSigilLinkFromParsedLink(scopedRef, {
          base: bindingLink,
        }),
      );
      return;
    }
    if (options.preserveLinkOutput) {
      const valueLink = isCellLink(value)
        ? parseLink(value, bindingLink)
        : undefined;
      if (
        valueLink !== undefined &&
        !areNormalizedLinksSame(valueLink, bindingLink)
      ) {
        const newValue = createSigilLinkFromParsedLink(
          valueLink,
        );
        // Skip the write when the redirect already holds this exact link. Raw
        // builtins (ifElse/when/unless/map/...) re-run and re-send their result
        // whenever their inputs change, but the output binding points at a
        // cause-stable result cell, so the link is usually unchanged. The read
        // is an internal write-elision decision: kept out of scheduling
        // (`ignoreReadForScheduling`) and CFC taint (`internalVerifierRead`),
        // and compared with the `Fabric`-aware `valueEqual`.
        const current = tx.readValueOrThrow(bindingLink, {
          meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
        });
        if (!valueEqual(current, newValue)) {
          tx.writeValueOrThrow(bindingLink, newValue);
        } else {
          tx.retainPendingWriteElision?.(toMemorySpaceAddress(bindingLink));
        }
        return;
      }
    }
    diffAndUpdate(
      cell.runtime,
      tx,
      ref,
      value,
      { cell: cell.getAsNormalizedFullLink(), binding },
      { meta: ignoreReadForScheduling, schemaRole: "output" },
    );
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(binding.length, value.length); i++) {
        sendValueToBindingInner(
          tx,
          cell,
          argumentCellLink,
          binding[i],
          value[i],
          options,
        );
      }
    }
    // A special object on either side is not keyed against the other: it is
    // not a record, whatever its `typeof` says, so it falls to the constant
    // comparison below rather than being decomposed key by key.
  } else if (
    isWalkableObjectOrArray(binding) && isWalkableObjectOrArray(value)
  ) {
    for (const key of Object.keys(binding)) {
      if (key in value) {
        sendValueToBindingInner(
          tx,
          cell,
          argumentCellLink,
          binding[key],
          value[key],
          options,
        );
      }
    }
  } else if (
    !isWalkableObjectOrArray(binding) || Object.keys(binding).length !== 0
  ) {
    // `fabricAwareEqual`, not `===`: a constant `NaN` binding legitimately
    // matches a produced `NaN`, `0` vs `-0` is a genuine mismatch, and a
    // constant fabric binding is compared by content rather than by identity.
    if (!fabricAwareEqual(binding, value)) {
      throw new Error(
        debugStr`Got $quote,long${value} instead of $quote,long${binding}`,
      );
    }
  }
}

/**
 * The causal form of a bound binding tree: the same tree with every link in it
 * reduced to the cell it names.
 *
 * `unwrapOneLevelAndBindToDoc()` emits its links with `includeSchema: true`,
 * because a node reads through them and the schema is how it reads. A node's
 * CAUSE is built from that same tree, and there the schema is wrong twice
 * over. It is not causal: a link's identity is the address it carries (see
 * `areNormalizedLinksSame`), so an id derived through one would be re-minted
 * by a widened type signature or a renamed `$defs` entry, neither of which
 * moves what the node reads or where it writes. And it is by far the largest
 * thing in the tree: a schema drags its whole `$defs` closure along, running
 * to kilobytes against a cause otherwise measured in hundreds of bytes.
 *
 * The reduction is to the address, not away from the schema specifically, so
 * anything else riding a link is left out too, including `cfcLabelView` and
 * the `scopeInitialization` declaration. See `sigilLinkAddressOnly()`.
 *
 * So the reduction happens here rather than in the binding itself, and the two
 * trees part company at this call: what the node reads through keeps its
 * schema, what names the node does not.
 *
 * A subtree holding nothing to reduce comes back by identity, so a cause built
 * from schema-free links allocates nothing and hashes exactly as it did.
 *
 * A deferred `$alias` is left as it stands. It is not a link but a binding on
 * its way to a nested pattern, and what it carries is that pattern's structure.
 */
export function causalFormOfBinding<T extends FabricExecValue>(binding: T): T {
  function reduce(value: FabricExecValue): FabricExecValue {
    if (isSigilLink(value)) return sigilLinkAddressOnly(value);

    // A `FabricPrimitive` is a leaf, and a `FabricInstance` holds its contents
    // behind a codec this walk cannot read. Neither can hold a link the walk
    // could reach, so both stand as they are. `unwrapOneLevelAndBindToDoc`
    // throws on the latter, so a bound tree carries none to begin with.
    if (value instanceof FabricPrimitive || value instanceof FabricInstance) {
      return value;
    }

    // Copy lazily, and skip holes, exactly as `convert()` below does -- see
    // there for why each of those is what it is. Each element is read once
    // into a local, so an accessor-backed member is not run a second time by
    // the comparison and does not land in the copy as a value the tree never
    // held.
    if (Array.isArray(value)) {
      let reduced: FabricExecValue[] | undefined;
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) continue;
        const element = value[i];
        const next = reduce(element);
        if (next === element) continue;
        reduced ??= value.slice();
        reduced[i] = next;
      }
      return reduced ?? value;
    }

    if (!isObjectOrArray(value)) return value;

    let reduced: Record<string, FabricExecValue> | undefined;
    for (const key of Object.keys(value)) {
      const element = value[key];
      const next = reduce(element);
      if (next === element) continue;
      reduced ??= { ...value };
      reduced[key] = next;
    }
    return reduced ?? value;
  }

  return reduce(binding) as T;
}

/**
 * Unwraps one level of aliases, and
 * - binds top-level aliases to passed doc
 *
 * This is used for arguments to nodes (which can be patterns, e.g. for map) and
 * for the pattern in pattern nodes.
 *
 * An alias will go through these stages:
 * - { $alias: { cell: "argument", path: ["a"], defer: 1 } }
 *   = Deferred one level, e.g. a nested pattern's argument alias
 * - { $alias: { partialCause: "foo", path: [], defer: 1 } }
 *   = Deferred one level, e.g. a nested pattern's derived internal alias
 * - { $alias: { cell: <doc>, path: ["a"] } }
 *   = Unwrapped, executing the pattern
 *
 * @param cfc - The ContextualFlowControl object, which we need to get the schema at sub-paths
 * @param binding - The binding to unwrap.
 * @param argumentCellLink - The link to the argument cell or undefined if not available.
 * @param resultCell - The result cell used to resolve result aliases
 * @param options - Optional configuration.
 * @param options.targetSchema - Schema for the binding being produced. Source
 *   links still resolve through the argument/result links above, but emitted
 *   links are annotated with the corresponding target schema.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindToDoc<T extends FabricExecValue>(
  binding: T,
  argumentCellLink: NormalizedFullLink | undefined,
  resultCell: AnyCell<unknown>,
  options?: UnwrapOneLevelOptions,
): T {
  const resultCellLink = canonicalSchemaLink(
    resultCell.getAsNormalizedFullLink(),
  )!;
  argumentCellLink = canonicalSchemaLink(argumentCellLink);

  /**
   * Rebinds one value, returning it unchanged when nothing under it rebound.
   *
   * A `FabricPrimitive` leaves first, ahead of the container branches. It is a
   * genuine leaf: an opaque scalar whose state lives in private fields, so
   * `Object.entries()` reports none of it and a rebuild from those entries
   * would yield a bare `{}`. Returning it as-is preserves it, and skips an
   * `Object.entries()` call that can only ever come back empty.
   *
   * A `FabricInstance` leaves next, by throwing. It is NOT a leaf: it is a
   * container holding other `FabricValue`s, so it does need descending into,
   * but by its codec contents rather than by property name — which this walk
   * has no way to do. The alternative to throwing is to hand one back whole,
   * which reads as success while leaving any bound alias in its contents
   * silently unbound. Neither disposition is correct, so this one takes the
   * one that reports itself, and names the class and the work it needs.
   *
   * TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
   * point the throw becomes a rebind. The two sibling walks in this file carry
   * `Latent` markers for the same hazard.
   *
   * The container branches hand back the original when nothing under one
   * rebound, so a container nothing touched survives exactly as it arrived,
   * whatever shape it has. Once something does rebind, the copy carries only
   * what its rebuild carries, and the two branches differ. `slice()` honors
   * `Symbol.species`, so an `Array` subclass comes back a subclass instance,
   * still carrying its prototype; that is deliberate, and
   * `pattern-binding.test.ts` pins the length handed to that species. The
   * object spread keeps enumerable string and symbol keys and nothing else: a
   * foreign prototype is dropped, a non-enumerable property is dropped, and an
   * accessor-backed property is read and stored on as a data property. That
   * last one costs a getter two firings on the rebuild path — one for the
   * keyed read, one for the spread.
   *
   * So a container arriving here is not assumed to be inert, and a rebuild is
   * not assumed to reproduce it. The special objects handled above leave first
   * because a rebuild could not reproduce them at all.
   */
  function convert(
    binding: FabricExecValue,
    targetSchema: JSONSchema | undefined,
  ): FabricExecValue {
    if (isAliasBinding(binding)) {
      const { defer: optDefer, ...aliasRest } = { ...binding.$alias };
      const defer = optDefer ?? 0;
      if (defer > 0) {
        return {
          $alias: { ...aliasRest, ...((defer > 1) && { defer: defer - 1 }) },
        };
      }
      const alias = binding.$alias;
      if (alias.partialCause !== undefined) {
        // If we've provided derivedInternalCells, we can look up this alias
        const descriptor = descriptorForPartialCauseAlias(
          alias.partialCause,
          options?.derivedInternalCells,
        );
        // If we're providing derivedInternalCells, and we didn't find our
        // cell, we should throw an error.
        if (
          descriptor === undefined &&
          options?.derivedInternalCells !== undefined
        ) {
          throw new Error(
            `Unknown derived internal cell with partial cause: ${
              JSON.stringify(alias.partialCause)
            }`,
          );
        }
        // For manually constructed patterns, we don't always have
        // derivedInternalCells, so we won't find a descriptor.
        // In that case, we'll just create a link with the partial
        // cause and hope it gets resolved later.
        // Without the derivedInternalCells, we also won't be able to set the
        // initial values.
        const link = descriptor !== undefined
          ? getDerivedInternalCellLink(resultCell, descriptor)
          : getDerivedInternalCellLink(resultCell, {
            partialCause: alias.partialCause,
            scope: alias.scope,
          });
        const path = alias.path;
        const sourceSchema = alias.schema !== undefined
          ? sanitizeAliasSchemaForBinding(alias.schema)
          : link.schema !== undefined
          ? ContextualFlowControl.schemaAtPath(link.schema, path)
          : undefined;
        return createSigilLinkFromParsedLink(
          linkForPath(link, path, targetSchema ?? sourceSchema),
          { includeSchema: true, overwrite: "redirect" },
        );
      } else {
        // Resolve the special values for "argument" and "result" — the only
        // `cell` values isAliasBinding admits.
        const link = alias.cell === "argument"
          ? argumentCellLink
          : resultCellLink;
        if (link === undefined) {
          throw new Error(
            "Cannot bind argument alias: no argument cell link available",
          );
        }
        const path = alias.path;
        // we might have a schema in the alias, but if not, we may have one
        // in the link (from the pattern)
        const sourceSchema = alias.schema !== undefined
          ? sanitizeAliasSchemaForBinding(alias.schema)
          : link.schema !== undefined
          ? ContextualFlowControl.schemaAtPath(link.schema, path)
          : undefined;
        const authoredRootSchema = alias.cell === "argument"
          ? options?.sourceSchemas?.argument
          : undefined;
        return createSigilLinkFromParsedLink(
          foldDeclaredScopeIntoLinkSchema(
            linkForPath(
              link,
              path,
              targetSchema ?? sourceSchema,
              alias.cell === "argument"
                ? authoredRootSchema ?? options?.argumentCapSchema
                : undefined,
            ),
            authoredRootSchema,
            path,
          ),
          { includeSchema: true, overwrite: "redirect" },
        );
      }
    } else if (binding instanceof FabricPrimitive) {
      return binding;
    } else if (binding instanceof FabricInstance) {
      throw new Error(
        `Cannot yet handle \`${binding.constructor.name}\` (a ` +
          "`FabricInstance`) as a pattern binding.",
      );
    } else if (Array.isArray(binding)) {
      // Copy lazily: allocate only once a child actually converts to something
      // else, so the shared path allocates nothing.
      //
      // Holes are skipped rather than visited, as `map()` skips them. That is a
      // cost guard, not a correctness one: `convert()` returns a hole's
      // `undefined` unchanged, so the `next === value` test below would skip it
      // regardless. Testing membership first keeps a sparse array priced by its
      // element count rather than by its extent — length 100k with two elements
      // is otherwise 100k pointless `convert()` calls.
      let converted: FabricExecValue[] | undefined;
      for (let i = 0; i < binding.length; i++) {
        if (!(i in binding)) continue;
        const value = binding[i];
        const next = convert(
          value,
          ContextualFlowControl.getSchemaAtPath(targetSchema, [String(i)]),
        );
        if (next === value) continue;
        // First change: copy the whole array, not just the prefix. `slice()`
        // with no arguments hands the species constructor the same length
        // `map()` did, so an `Array` subclass with a custom `Symbol.species`
        // sees what it always saw; and the copy already carries every unchanged
        // element and every hole, leaving only changed indices to write.
        converted ??= binding.slice();
        converted[i] = next;
      }
      // Nothing rebound, so the original is the answer.
      return converted ?? binding;
    } else if (isObjectOrArray(binding)) {
      // Copy lazily, as the array branch does: allocate only once a value
      // actually converts to something else, so the shared path — the common
      // one, and the majority of nodes — allocates nothing at all.
      let converted: Record<string, FabricExecValue> | undefined;
      for (const key of Object.keys(binding)) {
        const value = binding[key];
        const next = convert(
          value,
          ContextualFlowControl.getSchemaAtPath(targetSchema, [key]),
        );
        if (next === value) continue;
        converted ??= { ...binding };
        converted[key] = next;
      }
      if (converted === undefined) {
        // Nothing under here rebound, so hand back the original.
        // `noteDerivedCopy()` is skipped deliberately: it no-ops when copy and
        // original are the same value, and `resolveOriginal()` already returns
        // the original.
        return binding;
      }
      // Carry the derivation link (trust + content-addressed entry ref) onto
      // the bound copy so a pattern value re-bound here still resolves its
      // `{ identity, symbol }` and stays trusted.
      if (isPattern(binding)) noteDerivedCopy(converted, binding);
      return converted;
    } else return binding;
  }

  return convert(binding, options?.targetSchema) as T;
}

/**
 * Compute the set of TOP-LEVEL argument keys an argument schema declares
 * OPAQUE — i.e. carrying an `asCell: ["opaque"]` marker. Distinguished from
 * `asCell: ["cell"]` (a potentially value-read cell reference). ifElse marks
 * its pass-through `ifTrue`/`ifFalse` branches opaque so they can be dropped
 * from the node's declared reads.
 *
 * Returns an empty set when the schema declares no opaque keys (the common
 * case), so callers can cheaply skip the filter.
 */
export function opaqueArgumentKeys(
  argumentSchema: JSONSchema | undefined,
): Set<string> {
  const keys = new Set<string>();
  if (!isObjectOrArray(argumentSchema)) return keys;
  const properties = argumentSchema.properties;
  if (!isObjectOrArray(properties)) return keys;
  for (const [key, propSchema] of Object.entries(properties)) {
    const isOpaque = ContextualFlowControl.getAsCellValues(
      propSchema as JSONSchema,
    ).some((entry) => ContextualFlowControl.getAsCellKind(entry) === "opaque");
    if (isOpaque) keys.add(key);
  }
  return keys;
}

/**
 * Traverses binding and returns all cells reachable through write redirects.
 *
 * @param binding - The binding to traverse.
 * @param baseCell - The base cell to use for resolving links.
 * @param options - Optional configuration.
 * @param options.skipTopLevelKeys - Top-level argument keys to skip entirely.
 *   Used to drop OPAQUE forwarded references (e.g. ifElse's
 *   `ifTrue`/`ifFalse` branches) so they don't become declared reads that pull
 *   their (possibly unselected) writer. The opacity marker lives on the
 *   module's argument schema (link schemas are sanitized of `asCell` when a
 *   sigil link is created — see `sanitizeSchemaForLinks` — so it cannot be
 *   read off the resolved link), hence keying off the binding KEY here.
 * @returns All links reachable through write redirects.
 */
export function findAllWriteRedirectCells<T>(
  binding: unknown,
  baseCell: AnyCell<T>,
  options?: {
    skipTopLevelKeys?: ReadonlySet<string>;
    followRedirectChains?: boolean;
  },
): NormalizedFullLink[] {
  const skipTopLevelKeys = options?.skipTopLevelKeys;
  const seen: NormalizedFullLink[] = [];
  function find(binding: unknown): void {
    if (isAliasBinding(binding)) {
      // Callers unwrap bindings (unwrapOneLevelAndBindToDoc) before walking,
      // so a surviving `$alias` belongs to a nested level — it just crossed
      // its `defer` boundary, or sits inside an embedded Pattern value —
      // and is not part of this level's read/write surface.
      return;
    } else if (isWriteRedirectLink(binding)) {
      // Follow a *chain* of write redirects: record this redirect, then if its
      // target value is ITSELF a write redirect, follow that too (one string of
      // redirects). We stop as soon as the target is a non-redirect value — we
      // do NOT recurse into it looking for further nested redirects.
      let link = parseLink(binding, baseCell.getAsNormalizedFullLink());
      // One transaction for the whole chain, so every hop shares a resolution
      // memo, and none at all for a walk that stops at the first redirect.
      let chainTx: IExtendedStorageTransaction | undefined;
      while (true) {
        if (seen.find((s) => areNormalizedLinksSame(s, link))) return;
        seen.push(link);
        if (options?.followRedirectChains === false) return;
        const tx = (chainTx ??= baseCell.runtime.readTx(baseCell.tx));
        // Whether the target holds a further redirect is a question about
        // which reference sits there, so the probe stops at the reference and
        // leaves the target's content unread: it consumes the pointer's own
        // label and none of the content labels at that position. The walk
        // builds no cell, so it kicks no sync of its own; resolution kicks a
        // document's pull where it follows a hop the replica cannot serve, as
        // it does for every reader. The link's schema carries the scope caps
        // resolution honors along the path, interned so that the schema-keyed
        // caches downstream of the walk stay warm.
        const target = resolveLink(
          baseCell.runtime,
          tx,
          link.schema === undefined
            ? link
            : { ...link, schema: internCellLinkSchema(link.schema) },
          "top",
          { markIfcCrossings: true },
        );
        // A chained redirect resolves against the document it is stored in —
        // where resolution landed — rather than against the original
        // `baseCell`: a relative redirect in a cross-document target must
        // resolve against its own document.
        const next = tx.runWithAmbientReadMeta(
          ignoreReadForScheduling,
          () => readMaybeLink(tx, target, true),
        );
        if (next === undefined) return;
        link = next;
      }
    } else if (isCellLink(binding)) {
      // Links that are not write redirects: Ignore them.
      return;
    } else if (isPattern(binding)) {
      // Embedded Pattern values are opaque here: their `$alias` records and
      // sigil links are the embedded pattern's own binding vocabulary,
      // interpreted only when THAT pattern is instantiated (`defer`
      // bookkeeping positions its aliases for that moment). Walking into them
      // would declare reads at the wrong nesting level.
      return;
    } else if (Array.isArray(binding)) {
      // If the binding is an array, recurse into each element.
      for (const value of binding) find(value);
      // A special object ends the walk. A `FabricPrimitive` is an opaque
      // scalar and can contain no redirect. An instance ends it here too; the
      // link arm above has already returned for every link, so this arm sees
      // no link of either representation.
      //
      // TODO(danfuzz): a `FabricInstance` can hold a write redirect, and its
      // contents are reached by its codec rather than by property name, so one
      // nested inside is missed here.
    } else if (isKeyableObjectOrArray(binding)) {
      // If the binding is an object, recurse into each value.
      for (const value of Object.values(binding)) find(value);
    }
  }
  if (
    skipTopLevelKeys !== undefined && skipTopLevelKeys.size > 0 &&
    isObjectOrArray(binding) && !isCellLink(binding) && !isAliasBinding(binding)
  ) {
    // Drop the named top-level argument keys (opaque forwarded references)
    // before traversing — they must not contribute to declared reads.
    for (const [key, value] of Object.entries(binding)) {
      if (skipTopLevelKeys.has(key)) continue;
      find(value);
    }
  } else {
    find(binding);
  }
  return seen;
}
