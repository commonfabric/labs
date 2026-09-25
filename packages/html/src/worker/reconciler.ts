/**
 * Worker-side VDOM reconciler.
 *
 * This reconciler runs in the worker thread where Cell values can be
 * accessed synchronously. It emits VDomOp operations that are batched
 * and sent to the main thread for DOM application.
 *
 * It works with a `Cell` rather than a `CellHandle`, subscribes through
 * `cell.sink()`, and batches the operations it produces onto a microtask rather
 * than touching the DOM itself.
 *
 * Sub-piece cell regions: the retired cf-cell-context overlay could outline
 * the region of the page each cell rendered, because the renderer that held
 * the cells also built the DOM. This reconciler is the place that knowledge
 * crosses the worker boundary, so restoring that kind of inspection (e.g.
 * routing a region to cf-piece-menu's Data/Actions panels) means tagging
 * emitted VDomOps with the cell identity whenever reconciliation crosses a
 * cell boundary, and letting the main thread mark the applied DOM ranges.
 * Nothing does that yet; this note is the marker.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  areLinksSame,
  type Cancel,
  type Cell,
  type CellLinkInput,
  cellOfOpaqueReference,
  ContextualFlowControl,
  convertCellsToLinks,
  isCell,
  isStream,
  type JSONSchema,
  KeepAsCell,
  parseLink,
  type Stream,
  UI,
  useCancelGroup,
} from "@commonfabric/runner";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import { authorPrincipalCandidates } from "@commonfabric/runner/cfc/represents-principal";
import {
  atomsOutsideCeiling,
  CFC_LABEL_READ_FAILED_ATOM,
  type CfcLabelView,
  cfcLabelViewForCell,
  type CfcLabelViewSource,
  cfcLabelViewSourceForCell,
  clauseAlternatives,
  markRendererTrustedEvent,
  membershipSpacesInConfidentiality,
  modulePolicyRefsInConfidentiality,
  type RenderConfidentialityResolver,
  reportCfcDenial,
  type SpaceMembershipProvider,
} from "@commonfabric/runner/cfc";
import type { CellRef } from "@commonfabric/runtime-client";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  getBindingPropName,
  getEventType,
  isBindingProp,
  isEventHandler,
  isEventProp,
} from "../render-utils.ts";
import { CONTAINER_NODE_ID, type VDomOp } from "../vdom-ops.ts";
import { generateChildKeys } from "./keying.ts";
import type {
  ChildNodeState,
  NodeState,
  PropState,
  ReconcileContext,
  RenderDeclassificationPolicy,
  RenderPolicy,
  WorkerProps,
  WorkerReconcilerOptions,
  WorkerRenderNode,
  WorkerVNode,
} from "./types.ts";
import {
  isWorkerVNode,
  normalizeRenderConfidentialityCeiling,
  normalizeRenderDeclassificationPolicy,
} from "./types.ts";

/** Sentinel key in propSubscriptions for the Cell<Props> subscription itself. */
const CELL_PROPS_KEY = "__cellProps__";

const CFC_RENDER_BOUNDARY_TAG = "cf-cfc-render-boundary";
const CFC_AUTHORSHIP_TAG = "cf-cfc-authorship";
const CFC_BLOCKED_PLACEHOLDER_TAG = "cf-cfc-blocked";
const CFC_TEXT_INTEGRITY_PLACEHOLDER = "Content hidden by integrity policy";
const TEXT_INTEGRITY_PROP_SINKS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["cf-chat-message", new Set(["name", "content"])],
  ]);

function isNestedPatternOutput(value: unknown, cell: Cell<unknown>): boolean {
  if (
    !isObjectOrArray(value) || !(UI in value) ||
    !(value as Record<PropertyKey, unknown>)[UI]
  ) return false;

  try {
    const patternIdentity = cell.getMetaRaw("patternIdentity");
    return isObjectOrArray(patternIdentity) &&
      typeof (patternIdentity as Record<string, unknown>).identity ===
        "string" &&
      typeof (patternIdentity as Record<string, unknown>).symbol === "string";
  } catch {
    return false;
  }
}
// Props whose live DOM value can drift from the authored VDOM value
// independently of any worker-side change — user input (`value`), scrolling
// (`scrollTop`/`scrollLeft`), or browser / custom-element state (`checked`,
// `selected`, `selectedIndex`, `indeterminate`, `open`). On the main thread,
// setPropDefault re-asserts the authored value by comparing against the *live*
// property, so for these props a repeated set-prop is a drift-repair, not pure
// churn. The worker-side value guard (updatePropsInPlace) only knows the last
// *authored* value and cannot see live drift, so it must never skip these —
// they always re-emit.
const DOM_LIVE_PROPS: ReadonlySet<string> = new Set([
  "value",
  "checked",
  "selected",
  "selectedIndex",
  "indeterminate",
  "open",
  "scrollTop",
  "scrollLeft",
]);
const DEFAULT_RENDER_POLICY: RenderPolicy = {
  declassifyConfidentiality: [],
};

// What a prop reads through an opaque reference: `unknown` decides only when
// nothing else in the list does, so a string, number, boolean or null behind
// the reference materializes, and a record or a list stays the reference its
// declaration made it.
const REFERENCED_SCALAR_SCHEMA: JSONSchema = {
  type: ["unknown", "string", "number", "boolean", "null"],
};

// Mirrors CFC_ATOM_TYPE.Caveat in @commonfabric/api/cfc (not a dependency of
// this package).
const CFC_CAVEAT_ATOM_TYPE = "https://commonfabric.org/cfc/atom/Caveat";

const logger = getLogger("worker-reconciler", {
  enabled: false,
  level: "debug",
});

/**
 * Positions holding a longest strictly increasing run of `previousPositions`,
 * skipping the negative entries that stand for a child the document does not
 * hold yet.
 *
 * Children at those positions already sit in the order the new list wants them
 * in, relative to one another, so they are the ones that can stay where they
 * are while everything else is placed around them. Taking a *longest* such run
 * is what keeps the number of moves near the number of children that actually
 * changed place.
 *
 * @param previousPositions One entry per child of the new list, holding the
 *   position that child had in the old list, or a negative number for a child
 *   the document cannot move because it is not in it.
 */
function stationaryPositions(
  previousPositions: readonly number[],
): ReadonlySet<number> {
  // `runEnds[l]` is the position ending the smallest run of length `l + 1`
  // found so far, and `predecessor[p]` the position before `p` in the run that
  // ends there -- together enough to walk one longest run back out.
  const runEnds: number[] = [];
  const predecessor = new Array<number>(previousPositions.length).fill(-1);

  for (let position = 0; position < previousPositions.length; position++) {
    const previous = previousPositions[position];
    if (previous < 0) continue;

    let low = 0;
    let high = runEnds.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (previousPositions[runEnds[middle]] < previous) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessor[position] = runEnds[low - 1];
    runEnds[low] = position;
  }

  const stationary = new Set<number>();
  let position = runEnds.length > 0 ? runEnds[runEnds.length - 1] : -1;
  while (position >= 0) {
    stationary.add(position);
    position = predecessor[position];
  }
  return stationary;
}

/**
 * Main reconciler class for worker-side VDOM rendering.
 */
export class WorkerReconciler {
  #nodeIdCounter = 0;
  #handlerIdCounter = 0;
  #handlers = new Map<
    number,
    (event: unknown) => void
  >();
  #retiredHandlers = new Map<number, number>();
  #pendingRetiredHandlers = new Set<number>();
  #batchIdCounter = 0;
  #pendingOps: VDomOp[] = [];
  #flushScheduled = false;

  /** The actual root child node (not the container). */
  #rootChildId: number | null = null;

  #rootCancel: Cancel | null = null;

  readonly #onOps: (ops: VDomOp[]) => number | void;
  readonly #onError?: (error: Error) => void;
  readonly #renderDeclassificationPolicy: RenderDeclassificationPolicy;

  /**
   * Root-of-tree render policy: the host's default ceiling when configured
   * (spec §8.10.6), otherwise the unbounded policy. Authored boundaries can
   * only narrow from here.
   */
  readonly #rootRenderPolicy: RenderPolicy;

  /**
   * Runner-side display-boundary resolver, which rewrites a cell's
   * confidentiality label through the exchange rules before the ceiling fit,
   * admitting `Space(...)`-via-`HasRole` principal forms. When `undefined`,
   * the label is fit by exact match.
   */
  readonly #resolveRenderConfidentiality?: RenderConfidentialityResolver;

  /**
   * The membership provider (spec §4.9.3) whose `subscribe()` lets a gated
   * `Space(X)`-labeled cell re-render when `X`'s ACL syncs or changes. When
   * `undefined`, there is no reactive upgrade, and the sync snapshot still
   * gates soundly.
   */
  readonly #membershipProvider?: SpaceMembershipProvider;

  /**
   * The module-policy manifest source whose `subscribe()` lets a gated
   * `PolicyOf` cell re-render when the manifest its label selects syncs into
   * a space the label was read from.
   * When `undefined`, there is no reactive upgrade, and the sync snapshot
   * still gates soundly.
   */
  readonly #modulePolicySource?: WorkerReconcilerOptions["modulePolicySource"];
  readonly #spaceAccess?: WorkerReconcilerOptions["spaceAccess"];

  constructor(options: WorkerReconcilerOptions) {
    this.#onOps = options.onOps;
    this.#onError = options.onError;
    this.#resolveRenderConfidentiality = options.resolveRenderConfidentiality;
    this.#membershipProvider = options.membershipProvider;
    this.#modulePolicySource = options.modulePolicySource;
    this.#spaceAccess = options.spaceAccess;
    // Security knob: a present-but-unknown value fails closed to "deny";
    // only an absent option keeps the documented "allow" default.
    this.#renderDeclassificationPolicy = normalizeRenderDeclassificationPolicy(
      options.renderDeclassificationPolicy,
    );
    // Same seam discipline: malformed ceilings normalize to the empty
    // (public-only) ceiling rather than crashing or failing open.
    const ceiling = normalizeRenderConfidentialityCeiling(
      options.renderConfidentialityCeiling,
    );
    this.#rootRenderPolicy = ceiling === undefined ? DEFAULT_RENDER_POLICY : {
      declassifyConfidentiality: [],
      maxConfidentiality: [...(ceiling.atoms ?? [])],
      caveatKindAllow: [...(ceiling.caveatKinds ?? [])],
    };
  }

  /**
   * The root render policy and the two admission checks, which a test
   * drives directly.
   */
  get accessForTestingOnly(): {
    readonly rootRenderPolicy: RenderPolicy;
    atomRenderableUnderPolicy(atom: unknown, policy: RenderPolicy): boolean;
    canRenderCellUnderPolicy(
      cell: Cell<unknown>,
      policy: RenderPolicy,
    ): boolean;
  } {
    return {
      rootRenderPolicy: this.#rootRenderPolicy,
      atomRenderableUnderPolicy: (atom, policy) =>
        this.#atomRenderableUnderPolicy(atom, policy),
      canRenderCellUnderPolicy: (cell, policy) =>
        this.#canRenderCellUnderPolicy(cell, policy),
    };
  }

  /**
   * Create a reconciliation context for this reconciler instance.
   */
  #createContext(): ReconcileContext {
    return {
      emit: (ops) => this.#queueOps(ops),
      nextNodeId: () => ++this.#nodeIdCounter,
      registerHandler: (handler) => {
        const id = ++this.#handlerIdCounter;
        this.#handlers.set(id, handler);
        return id;
      },
      getHandler: (id) => this.#handlers.get(id),
    };
  }

  /** Best-effort space of a cell; undefined when it can't name one. */
  #spaceOfCell(cell: Cell<unknown>): string | undefined {
    try {
      return cell.space;
    } catch {
      return undefined;
    }
  }

  /**
   * Mount a VDOM tree, starting the reconciliation process.
   * Children are inserted directly into the container (CONTAINER_NODE_ID).
   *
   * @param vnode - The root VNode, Cell<VNode>, or Cell<unknown> to mount
   * @returns A cancel function to unmount the tree
   */
  mount(vnode: WorkerVNode | Cell<WorkerVNode> | Cell<unknown>): Cancel {
    logger.debug(
      "mount",
      () => ({
        vnodeType: isCell(vnode) ? this.#getCellDebugId(vnode) : typeof vnode,
      }),
    );
    if (this.#rootCancel) {
      this.#rootCancel();
    }

    let ctx = this.#createContext();
    if (isCell(vnode)) {
      const rootSpace = this.#spaceOfCell(vnode);
      if (rootSpace) ctx = { ...ctx, space: rootSpace };
    }
    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<VNode> at the root
    if (isCell(vnode)) {
      // Create a wrapper state that tracks the current child in the container
      const wrapperState = this.#createWrapperState(ctx, CONTAINER_NODE_ID);

      // Ensure the current child is cancelled when the root is cancelled
      addCancel(() => wrapperState.cancel());

      // §4.9.3 Stage 2: the root cell is an egress too — if it is labeled
      // Space(X) and X's ACL has not synced, it fails closed; watch X's ACL so
      // a later grant re-renders (and a revoke re-blocks), mirroring
      // renderCellChild. `renderRoot` is re-invoked with the last resolved
      // value when an ACL changes.
      let lastRootValue: unknown;
      let rootHasRendered = false;
      const rootWatchedDocs = new Set<string>();
      const renderRoot = (resolvedVnode: unknown) => {
        logger.debug("root-cell-update", () => ({ resolvedVnode }));
        lastRootValue = resolvedVnode;
        rootHasRendered = true;
        this.#watchCellMembership(
          vnode as Cell<unknown>,
          rootWatchedDocs,
          addCancel,
          () => {
            if (rootHasRendered) renderRoot(lastRootValue);
          },
        );
        // The mounted cell is an egress like any descendant cell: gate its
        // own label against the root policy (the host ceiling when
        // configured) before rendering its resolved content. Checked per
        // update so label changes re-evaluate, mirroring renderCellChild.
        const accessLost =
          this.#cellAccessError(vnode as Cell<unknown>) !== undefined;
        if (
          accessLost ||
          !this.#canRenderCellUnderPolicy(
            vnode as Cell<unknown>,
            this.#rootRenderPolicy,
          )
        ) {
          if (!accessLost) {
            this.#denyCellRender(
              vnode as Cell<unknown>,
              this.#rootRenderPolicy,
            );
          }
          this.#reconcileIntoWrapper(
            ctx,
            wrapperState,
            accessLost
              ? this.#accessPlaceholderVNode()
              : this.#blockedPlaceholderVNode(),
            this.#rootRenderPolicy,
          );
          this.#rootChildId = wrapperState.currentChild?.nodeId ?? null;
          return;
        }
        // Validate that the resolved value is a valid render node
        if (!this.#isValidRenderNode(resolvedVnode)) {
          this.#onError?.(
            new Error(
              `Invalid VDOM content: expected WorkerVNode, string, or number, got ${typeof resolvedVnode}`,
            ),
          );
          return;
        }
        this.#reconcileIntoWrapper(
          ctx,
          wrapperState,
          resolvedVnode as WorkerRenderNode,
          this.#rootRenderPolicy,
        );
        // Track the root child for cleanup
        this.#rootChildId = wrapperState.currentChild?.nodeId ?? null;
      };

      addCancel(
        this.#sinkCell(
          vnode,
          (resolvedVnode: unknown) => renderRoot(resolvedVnode),
        ),
      );
    } else {
      // Static VNode - render directly into container
      const state = this.#renderNode(
        ctx,
        vnode,
        new Set(),
        this.#rootRenderPolicy,
      );
      if (state) {
        addCancel(state.cancel);
        this.#rootChildId = state.nodeId;
        this.#queueOps([
          {
            op: "insert-child",
            parentId: CONTAINER_NODE_ID,
            childId: state.nodeId,
            beforeId: null,
          },
        ]);
      }
    }

    // Flush any pending operations
    this.#scheduleFlush();

    this.#rootCancel = cancel;
    return cancel;
  }

  /**
   * Check if a value is a valid render node (VNode, string, number, object with [UI], or null/undefined).
   */
  #isValidRenderNode(value: unknown): value is WorkerRenderNode {
    if (value === null || value === undefined) return true;
    if (typeof value === "string" || typeof value === "number") return true;
    if (typeof value === "boolean") return true;
    if (isWorkerVNode(value)) return true;
    if (Array.isArray(value)) {
      return value.every((item) => this.#isValidRenderNode(item));
    }
    if (isCell(value)) return true;
    // Accept objects with [UI] property - will be unwrapped in renderNode
    if (typeof value === "object" && UI in value) return true;
    return false;
  }

  /**
   * Unmount the current VDOM tree.
   */
  unmount(): void {
    logger.debug("unmount", () => ({ rootChildId: this.#rootChildId }));
    if (this.#rootCancel) {
      this.#rootCancel();
      this.#rootCancel = null;
    }
    if (this.#rootChildId !== null) {
      this.#queueOps([{ op: "remove-node", nodeId: this.#rootChildId }]);
      this.#rootChildId = null;
    }
    this.#flushOps();
  }

  /**
   * Deliver operations that reconciliation has queued but not yet handed to
   * `onOps`. Queued operations otherwise leave on a microtask, so a host that
   * reads the applied result at a chosen moment — the CLI turning a piece's UI
   * into HTML — calls this first to make that moment definite.
   */
  flush(): void {
    this.#flushOps();
  }

  acknowledgeBatchApplied(batchId: number): void {
    for (const [handlerId, retiredAtBatch] of this.#retiredHandlers) {
      if (retiredAtBatch > batchId) {
        continue;
      }
      this.#retiredHandlers.delete(handlerId);
      this.#handlers.delete(handlerId);
    }
  }

  /**
   * Dispatch a DOM event to its handler.
   */
  dispatchEvent(handlerId: number, event: unknown): boolean {
    const handler = this.#handlers.get(handlerId);
    if (handler) {
      try {
        markRendererTrustedEvent(event);
        handler(event);
      } catch (error) {
        this.#onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return true;
    }
    return false;
  }

  /**
   * Get the root child node ID (the actual rendered content).
   */
  getRootNodeId(): number | null {
    return this.#rootChildId;
  }

  //
  // Private Methods
  //

  /**
   * Queue operations to be sent to the main thread.
   */
  #queueOps(ops: VDomOp[]): void {
    this.#pendingOps.push(...ops);
    this.#scheduleFlush();
  }

  /**
   * Schedule a flush of pending operations.
   */
  #scheduleFlush(): void {
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      queueMicrotask(() => this.#flushOps());
    }
  }

  /**
   * Flush all pending operations to the main thread.
   */
  #flushOps(): void {
    this.#flushScheduled = false;
    if (this.#pendingOps.length > 0) {
      const ops = this.#pendingOps;
      logger.debug("flush-ops", () => ({ count: ops.length, ops }));
      this.#pendingOps = [];
      const batchId = this.#onOps(ops) ?? this.#batchIdCounter++;
      this.#assignPendingRetiredHandlers(batchId);
    }
  }

  /**
   * Clean up event handlers for a node and its descendants.
   */
  #cleanupNodeHandlers(state: NodeState | ChildNodeState): void {
    // Clean up element state handlers if present
    const elementState = "elementState" in state ? state.elementState : state;
    if (elementState && "eventHandlers" in elementState) {
      for (const handlerId of elementState.eventHandlers.values()) {
        this.#retireHandlerId(handlerId);
      }
      elementState.eventHandlers.clear();

      // Recursively clean up children
      if (elementState.children) {
        for (const child of elementState.children.values()) {
          this.#cleanupNodeHandlers(child);
        }
      }
    }
  }

  #retireHandlerId(handlerId: number): void {
    if (!this.#handlers.has(handlerId)) {
      return;
    }
    if (
      !this.#retiredHandlers.has(handlerId) &&
      !this.#pendingRetiredHandlers.has(handlerId)
    ) {
      this.#pendingRetiredHandlers.add(handlerId);
    }
  }

  #assignPendingRetiredHandlers(batchId: number): void {
    for (const handlerId of this.#pendingRetiredHandlers) {
      this.#retiredHandlers.set(handlerId, batchId);
    }
    this.#pendingRetiredHandlers.clear();
  }

  #retireEventHandler(
    state: NodeState,
    eventType: string,
  ): number | undefined {
    const handlerId = state.eventHandlers.get(eventType);
    if (handlerId === undefined) {
      return undefined;
    }

    state.eventHandlers.delete(eventType);
    this.#retireHandlerId(handlerId);
    return handlerId;
  }

  /**
   * Check if new children are structurally the same as existing children.
   * Used by Cell child VNode in-place update to decide whether to skip
   * children reconciliation (same children have active sinks) or do a
   * full replace (children changed).
   */
  #areChildrenSame(
    state: NodeState,
    newChildren: WorkerRenderNode | WorkerRenderNode[],
  ): boolean {
    // Cell<children>: same Cell link means same subscription
    if (isCell(newChildren)) {
      return !!(
        state.childrenState?.cell &&
        areLinksSame(state.childrenState.cell, newChildren)
      );
    }

    // Static children: compare keys
    const childArray = Array.isArray(newChildren) ? newChildren : [newChildren];
    const newKeys = generateChildKeys(childArray);

    if (newKeys.length !== state.childOrder.length) return false;
    return newKeys.every((key, i) => key === state.childOrder[i]);
  }

  #childRenderPolicyForNode(
    node: WorkerVNode,
    parentPolicy: RenderPolicy,
    nodeId: number,
  ): RenderPolicy {
    let policy = parentPolicy;

    if (node.name === CFC_RENDER_BOUNDARY_TAG) {
      const props = this.#propsForRenderPolicy(node);
      const localMax = this.#normalizeAtomBound(
        this.#staticPropAsAtomList(props, "maxConfidentiality") ??
          this.#staticPropAsAtomList(props, "data-cfc-max-confidentiality"),
      );
      // Author-supplied declassification is a fail-open capability (it releases
      // a secret upward). Honor it only when the render policy allows; under
      // "deny" the boundary keeps its fail-closed power to NARROW the bound but
      // cannot declassify (audit S15). Narrowing below is unaffected.
      const declassifyConfidentiality =
        this.#renderDeclassificationPolicy === "deny" ? [] : (
          this.#staticPropAsAtomList(
            props,
            "declassifyConfidentiality",
          ) ??
            this.#staticPropAsAtomList(
              props,
              "data-cfc-declassify-confidentiality",
            ) ??
            []
        );

      policy = {
        maxConfidentiality: this.#narrowMaxConfidentiality(
          parentPolicy.maxConfidentiality,
          localMax,
        ),
        // The host's caveat-kind allowance is part of the default ceiling
        // profile; boundaries narrow maxConfidentiality but never widen or
        // shed the kind allowance.
        caveatKindAllow: parentPolicy.caveatKindAllow,
        declassifyConfidentiality: [
          ...parentPolicy.declassifyConfidentiality,
          ...declassifyConfidentiality,
        ],
        textIntegrity: parentPolicy.textIntegrity,
      };
    }

    if (node.name !== CFC_AUTHORSHIP_TAG) {
      return policy;
    }

    const verifyTextIntegrity = this.#nodePropAsBoolean(node, [
      "verifyTextIntegrity",
      "verify-text-integrity",
      "data-cfc-verify-text-integrity",
    ]) ?? false;
    if (!verifyTextIntegrity) {
      return policy;
    }

    const allowLiteralText = this.#nodePropAsBoolean(node, [
      "allowLiteralText",
      "allow-literal-text",
      "data-cfc-allow-literal-text",
    ]) ?? false;
    const explicitRequiredIntegrity = this.#nodePropAsAtomList(node, [
      "requiredTextIntegrity",
      "requiredIntegrity",
      "data-cfc-required-text-integrity",
    ]);
    // Without an explicit requirement, a cell-backed author that represents a
    // principal makes the text boundary require authored-by for that principal.
    const requiredIntegrity = explicitRequiredIntegrity ??
      this.#requiredAuthorshipIntegrityFromAuthor(node) ??
      [];

    // Compose (do not replace) the enclosing text-integrity policy so nesting
    // can only TIGHTEN it: required integrity is the union of every enclosing
    // boundary's atoms, literal text is allowed only if every enclosing
    // boundary allows it, and the block-attribution set carries every enclosing
    // boundary id. An inner boundary can never relax an outer one.
    const parentTextIntegrity = policy.textIntegrity;
    const boundaryNodeIds = new Set(parentTextIntegrity?.boundaryNodeIds ?? []);
    boundaryNodeIds.add(nodeId);
    return {
      ...policy,
      textIntegrity: {
        requiredIntegrity: [
          ...(parentTextIntegrity?.requiredIntegrity ?? []),
          ...requiredIntegrity,
        ],
        allowLiteralText: (parentTextIntegrity?.allowLiteralText ?? true) &&
          allowLiteralText,
        boundaryNodeIds,
      },
    };
  }

  #propsForRenderPolicy(
    node: WorkerVNode,
  ): WorkerProps | null | undefined {
    if (!isCell(node.props)) {
      return node.props;
    }
    try {
      const rawProps = node.props.getRawUntyped({ frozen: false });
      return isObjectNotArray(rawProps) ? rawProps as WorkerProps : undefined;
    } catch {
      return undefined;
    }
  }

  #staticPropAsAtomList(
    props: WorkerProps | null | undefined,
    key: string,
  ): readonly CfcConfClause[] | undefined {
    if (!props || typeof props !== "object" || !(key in props)) {
      return undefined;
    }
    const value = props[key];
    if (isCell(value) || typeof value === "function") {
      return undefined;
    }
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value as readonly CfcConfClause[];
    }
    return [value as CfcConfClause];
  }

  #nodePropForRenderPolicy(
    node: WorkerVNode,
    key: string,
  ): unknown {
    const props = this.#propsForRenderPolicy(node);
    if (!props || typeof props !== "object" || !(key in props)) {
      return undefined;
    }
    const value = props[key];
    if (!isCell(node.props)) {
      return value;
    }
    try {
      return this.#resolveCellPropsBindingTarget(
        node.props as Cell<WorkerProps>,
        key,
        value,
      );
    } catch {
      return value;
    }
  }

  #nodePropAsBoolean(
    node: WorkerVNode,
    keys: readonly string[],
  ): boolean | undefined {
    for (const key of keys) {
      const rawValue = this.#nodePropForRenderPolicy(node, key);
      if (typeof rawValue === "function") {
        continue;
      }
      const value = isCell(rawValue)
        ? this.#readCellPolicyValue(rawValue as Cell<unknown>)
        : rawValue;
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        if (value === "" || value.toLowerCase() === "true") {
          return true;
        }
        if (value.toLowerCase() === "false") {
          return false;
        }
      }
    }
    return undefined;
  }

  #nodePropAsAtomList(
    node: WorkerVNode,
    keys: readonly string[],
  ): readonly CfcAtom[] | undefined {
    for (const key of keys) {
      const value = this.#nodePropForRenderPolicy(node, key);
      if (typeof value === "function") {
        continue;
      }
      const resolved = isCell(value)
        ? this.#readCellPolicyValue(value as Cell<unknown>)
        : value;
      if (resolved === undefined) {
        continue;
      }
      return (Array.isArray(resolved) ? resolved : [resolved]) as CfcAtom[];
    }
    return undefined;
  }

  #requiredAuthorshipIntegrityFromAuthor(
    node: WorkerVNode,
  ): readonly CfcAtom[] | undefined {
    const author = this.#nodePropForRenderPolicy(node, "author") ??
      this.#nodePropForRenderPolicy(node, "$author");
    if (!isCell(author)) {
      return undefined;
    }
    // Text must carry `authored-by` for every principal the author claim
    // represents, one atom per principal when it names several.
    const principals = this.#representedPrincipalsForCell(
      author as Cell<unknown>,
    );
    return principals.length === 0
      ? undefined
      : principals.map((subject) => ({ kind: "authored-by", subject }));
  }

  #bindingOpsForCell(
    state: NodeState,
    propName: string,
    cell: Cell<unknown>,
  ): VDomOp[] {
    return [{
      op: "set-binding",
      nodeId: state.nodeId,
      propName,
      cellRef: this.#cellRefForBinding(cell),
    }];
  }

  /** Keep the nested pattern's whole result cell on its existing root node. */
  #updatePieceBoundary(
    childState: ChildNodeState,
    resolvedChild: unknown,
    resultCell: Cell<unknown>,
  ): void {
    const shouldBind = isNestedPatternOutput(resolvedChild, resultCell);
    if (!childState.elementState) return;

    if (shouldBind) {
      childState.hasPieceBoundary = true;
      this.#queueOps([{
        op: "set-piece-boundary",
        nodeId: childState.elementState.nodeId,
        cellRef: this.#cellRefForBinding(resultCell),
      }]);
    } else if (childState.hasPieceBoundary) {
      childState.hasPieceBoundary = false;
      this.#queueOps([{
        op: "clear-piece-boundary",
        nodeId: childState.elementState.nodeId,
      }]);
    }
  }

  /** Follow a link-valued child to the result cell whose UI is rendered. */
  #resolveCellForBinding(cell: Cell<unknown>): Cell<unknown> {
    try {
      return cell.resolveAsCell();
    } catch {
      return cell;
    }
  }

  /** Guards both the containing view and any linked event target at dispatch. */
  #registerHandler(
    ctx: ReconcileContext,
    handler: (event: unknown) => void,
    target?: Cell<unknown>,
  ): number {
    return ctx.registerHandler((event) => {
      if (
        (ctx.space !== undefined && this.#spaceAccess?.error(ctx.space)) ||
        (target !== undefined && this.#cellAccessError(target))
      ) {
        return;
      }
      handler(event);
    });
  }

  #cellAccessError(cell: Cell<unknown>): Error | undefined {
    if (this.#spaceAccess === undefined) return undefined;
    for (const candidate of [cell, this.#resolveCellForBinding(cell)]) {
      const space = this.#spaceOfCell(candidate);
      if (space !== undefined) {
        const error = this.#spaceAccess.error(space);
        if (error !== undefined) return error;
      }
    }
    return undefined;
  }

  /** Keeps a rendered subscription responsive to session access loss and recovery. */
  #sinkCell<T>(cell: Cell<T>, deliver: (value: T | undefined) => void): Cancel {
    const [cancel, addCancel] = useCancelGroup();
    const watched = new Set<string>();
    let active = true;
    let current: T | undefined;
    const emit = () => {
      if (active) deliver(this.#cellAccessError(cell) ? undefined : current);
    };
    addCancel(cell.sink((value) => {
      current = value;
      if (this.#spaceAccess !== undefined) {
        for (const candidate of [cell, this.#resolveCellForBinding(cell)]) {
          const space = this.#spaceOfCell(candidate);
          if (space !== undefined && !watched.has(space)) {
            watched.add(space);
            addCancel(this.#spaceAccess.subscribe(space, emit));
          }
        }
      }
      emit();
    }, { readOnly: true }));
    return () => {
      active = false;
      cancel();
    };
  }

  #accessPlaceholderVNode(): WorkerVNode {
    return {
      type: "vnode",
      name: "span",
      props: { "data-space-access-lost": "true", role: "status" },
      children: ["Access unavailable"],
    };
  }

  #cellRefForBinding(cell: Cell<unknown>): CellRef {
    const link = cell.getAsNormalizedFullLink();
    let labelView: CfcLabelView | undefined;
    try {
      labelView = cfcLabelViewForCell(cell);
      if (labelView === undefined) {
        labelView = cfcLabelViewForCell(cell.resolveAsCell());
      }
    } catch {
      labelView = undefined;
    }
    return {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      schema: this.#bindingSchema(link.schema),
      ...(link.overwrite !== undefined && { overwrite: link.overwrite }),
      ...(labelView !== undefined && { cfcLabelView: labelView }),
    };
  }

  #bindingSchema(schema: CellRef["schema"] | undefined): CellRef[
    "schema"
  ] {
    if (
      schema === undefined ||
      (isObjectOrArray(schema) &&
        Object.keys(schema).length === 0)
    ) {
      return true;
    }
    return schema;
  }

  /**
   * A cell's CFC label view, mirroring the render gate's resolution: the cell's
   * own view, or — when it has none — the resolved (followed) target's view,
   * whose label may carry the `Space(...)` atoms. May throw (each caller
   * decides its own fail-closed handling). The SINGLE source of label
   * resolution shared by the gate (`#canRenderCellUnderPolicy`), the
   * represents-principal read, and the Stage-2 membership watcher
   * (`watchCellMembership`), so they can never drift out of lockstep.
   */
  #resolveCellLabelView(cell: Cell<unknown>): CfcLabelView | undefined {
    return this.#resolveCellLabelSource(cell).view;
  }

  /**
   * {@link #resolveCellLabelView}, with the spaces of the documents the view
   * was read from, where a module policy the label selects has its manifest
   * (spec §4.4.1). May throw, like the view read.
   */
  #resolveCellLabelSource(cell: Cell<unknown>): CfcLabelViewSource {
    const own = cfcLabelViewSourceForCell(cell);
    return own.view !== undefined
      ? own
      : cfcLabelViewSourceForCell(cell.resolveAsCell());
  }

  /**
   * The principals `cell`'s label says it represents, as
   * `authorPrincipalCandidates()` reads them; none when its label cannot be
   * read.
   */
  #representedPrincipalsForCell(cell: Cell<unknown>): string[] {
    try {
      return authorPrincipalCandidates(this.#resolveCellLabelView(cell));
    } catch {
      return [];
    }
  }

  #staticCellProp(
    props: WorkerProps | null | undefined,
    key: string,
  ): Cell<unknown> | undefined {
    if (!props || typeof props !== "object" || !(key in props)) {
      return undefined;
    }
    const value = props[key];
    return isCell(value) ? value as Cell<unknown> : undefined;
  }

  #childrenForRenderPolicy(
    node: WorkerVNode,
    policy: RenderPolicy,
  ): {
    children:
      | WorkerRenderNode[]
      | Cell<WorkerRenderNode | WorkerRenderNode[]>
      | undefined;
    blocked: boolean;
    /** The cell whose label the block was decided on, when one was. */
    blockedBy?: Cell<unknown>;
  } {
    if (node.children === undefined) {
      return { children: undefined, blocked: false };
    }
    const blocked = this.#boundaryChildBlocker(node, policy);
    if (blocked === undefined) {
      return { children: node.children, blocked: false };
    }
    return {
      children: [this.#blockedPlaceholderVNode()],
      blocked: true,
      blockedBy: blocked,
    };
  }

  /**
   * Record whether a node's children are blocked, reporting a block the pass
   * it takes effect rather than each time the policy is asked.
   */
  #setChildrenBlocked(
    state: NodeState,
    policyChildren: { blocked: boolean; blockedBy?: Cell<unknown> },
    policy: RenderPolicy,
  ): void {
    if (
      policyChildren.blocked && !state.childrenBlockedByPolicy &&
      policyChildren.blockedBy !== undefined
    ) {
      this.#denyCellRender(policyChildren.blockedBy, policy);
    }
    state.childrenBlockedByPolicy = policyChildren.blocked;
  }

  /**
   * The value a render boundary protects, when the policy will not admit it —
   * so the caller both learns that the children are blocked and holds the cell
   * whose label says why. Undefined means the children render.
   */
  #boundaryChildBlocker(
    node: WorkerVNode,
    policy: RenderPolicy,
  ): Cell<unknown> | undefined {
    if (node.name !== CFC_RENDER_BOUNDARY_TAG) {
      return undefined;
    }
    const protectedValue = this.#boundaryProtectedValueCell(node);
    if (protectedValue === undefined) {
      return undefined;
    }
    return this.#canRenderCellUnderPolicy(protectedValue, policy)
      ? undefined
      : protectedValue;
  }

  #boundaryProtectedValueCell(
    node: WorkerVNode,
  ): Cell<unknown> | undefined {
    if (isCell(node.props)) {
      const propsCell = node.props as Cell<WorkerProps>;
      let rawProps: unknown;
      try {
        rawProps = propsCell.getRawUntyped({ frozen: false });
      } catch {
        return undefined;
      }
      if (
        !isObjectOrArray(rawProps) ||
        !("$value" in rawProps)
      ) {
        return undefined;
      }
      try {
        return this.#resolveCellPropsBindingTarget(
          propsCell,
          "$value",
          (rawProps as Record<string, unknown>)["$value"],
        );
      } catch {
        return undefined;
      }
    }
    return this.#staticCellProp(node.props, "$value");
  }

  #blockedPlaceholderVNode(
    reason: "policy" | "integrity" = "policy",
  ): WorkerVNode {
    const integrityBlocked = reason === "integrity";
    return {
      type: "vnode",
      name: CFC_BLOCKED_PLACEHOLDER_TAG,
      props: {
        "data-cfc-blocked": "true",
        "data-cfc-blocked-reason": reason,
        title: integrityBlocked
          ? "CFC text integrity policy blocked this content"
          : "CFC render policy blocked this content",
      },
      children: [
        integrityBlocked
          ? CFC_TEXT_INTEGRITY_PLACEHOLDER
          : "Content hidden by policy",
      ],
    };
  }

  #normalizeAtomBound(
    labels: readonly unknown[] | undefined,
  ): readonly CfcConfClause[] | undefined {
    if (labels === undefined) {
      return undefined;
    }
    return ContextualFlowControl.uniqueAtoms(labels);
  }

  #narrowMaxConfidentiality(
    parentMax: readonly CfcConfClause[] | undefined,
    localMax: readonly CfcConfClause[] | undefined,
  ): readonly CfcConfClause[] | undefined {
    if (parentMax === undefined) {
      return localMax;
    }
    if (localMax === undefined) {
      return parentMax;
    }
    return parentMax.filter((atom) =>
      localMax.some((localAtom) => deepEqual(atom, localAtom))
    );
  }

  #renderPolicyEquals(
    left: RenderPolicy,
    right: RenderPolicy,
  ): boolean {
    const maxConfidentialityEquals = left.maxConfidentiality === undefined ||
        right.maxConfidentiality === undefined
      ? left.maxConfidentiality === right.maxConfidentiality
      : this.#atomListsEqual(
        left.maxConfidentiality,
        right.maxConfidentiality,
      );

    const caveatKindsEqual = (left.caveatKindAllow ?? []).length ===
        (right.caveatKindAllow ?? []).length &&
      (left.caveatKindAllow ?? []).every((kind, index) =>
        kind === (right.caveatKindAllow ?? [])[index]
      );

    return maxConfidentialityEquals && caveatKindsEqual &&
      this.#atomListsEqual(
        left.declassifyConfidentiality,
        right.declassifyConfidentiality,
      ) &&
      this.#textIntegrityPolicyEquals(left, right);
  }

  #textIntegrityPolicyEquals(
    left: RenderPolicy,
    right: RenderPolicy,
  ): boolean {
    const leftPolicy = left.textIntegrity;
    const rightPolicy = right.textIntegrity;
    if (leftPolicy === undefined || rightPolicy === undefined) {
      return leftPolicy === rightPolicy;
    }
    return this.#atomListsEqual(
      leftPolicy.requiredIntegrity,
      rightPolicy.requiredIntegrity,
    ) &&
      leftPolicy.allowLiteralText === rightPolicy.allowLiteralText &&
      this.#boundaryNodeIdsEqual(
        leftPolicy.boundaryNodeIds,
        rightPolicy.boundaryNodeIds,
      );
  }

  #boundaryNodeIdsEqual(
    left: ReadonlySet<number>,
    right: ReadonlySet<number>,
  ): boolean {
    return left.size === right.size &&
      [...left].every((id) => right.has(id));
  }

  #atomListsEqual(
    left: readonly unknown[],
    right: readonly unknown[],
  ): boolean {
    return left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }

  /**
   * Whether `cell` may render under `policy`: every atom of its
   * confidentiality label (its schema's, when it carries none) sits under
   * the ceiling or is declassified, resolved through the display-boundary
   * exchange rules when a resolver is wired and a ceiling is in force. A
   * label that cannot be read fails closed.
   */
  #canRenderCellUnderPolicy(
    cell: Cell<unknown>,
    policy: RenderPolicy,
  ): boolean {
    if (
      policy.maxConfidentiality === undefined &&
      policy.declassifyConfidentiality.length === 0
    ) {
      return true;
    }

    let labelView: CfcLabelView | undefined;
    let labelSpaces: readonly string[];
    try {
      ({ view: labelView, spaces: labelSpaces } = this.#resolveCellLabelSource(
        cell,
      ));
    } catch {
      return false;
    }
    // Epic H3b: with a resolver wired and a ceiling in force, exchange-resolve
    // the cell's label (runner-side) before the fit — this is where
    // `Space(...)`-via-`HasRole` principal forms become admissible. Without a
    // resolver, or on a declassify-only boundary, fall back to the H3a
    // per-atom exact-match path.
    const useResolver = this.#resolveRenderConfidentiality !== undefined &&
      policy.maxConfidentiality !== undefined;

    if (labelView === undefined) {
      // Schema IFC is a constraint, not the data label. Use it only as a
      // conservative fallback when no stored/read label metadata is available.
      // Exchange resolution is deliberately NOT applied here: schema IFC does
      // not carry the runtime `Space(...)` principals resolution targets, and
      // the per-atom exact-match fit stays fail-closed for anything it cannot
      // admit — the resolver drives the stored-label path below.
      const schemaLabels = this.#confidentialityLabelsFromCellSchema(cell);
      if (schemaLabels.length === 0) {
        return true;
      }
      return schemaLabels.every((atom) =>
        this.#atomRenderableUnderPolicy(atom, policy)
      );
    }

    const confidentiality = this.#confidentialityLabels(labelView);
    if (useResolver) {
      return this.#resolvedConfidentialityRenderable(
        confidentiality,
        this.#integrityLabels(labelView),
        () => labelSpaces,
        policy,
      );
    }
    for (const atom of confidentiality) {
      if (!this.#atomRenderableUnderPolicy(atom, policy)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Clause-aware admission of a resolved confidentiality label (Epic H3b).
   * The resolver rewrites the raw atoms through the display-boundary exchange
   * rules (runner-side); this method fits the result by clause subsumption
   * (spec §8.10.3, `atomsOutsideCeiling`). A resolved OR-clause fits when one
   * of its alternatives sits under the ceiling — so `Space(X)` that gained a
   * `User(actingUser)` alternative renders. Each still-offending clause gets a
   * last-chance per-clause check: the read-failure marker is ungrantable
   * (audit item 22), author declassification and the caveat-kind allow-list
   * admit only bare atoms — an OR-clause never matches either, staying closed.
   */
  #resolvedConfidentialityRenderable(
    confidentiality: readonly CfcConfClause[],
    integrity: readonly CfcAtom[],
    spaces: () => readonly string[],
    policy: RenderPolicy,
  ): boolean {
    const resolved = this.#resolveRenderConfidentiality!({
      confidentiality,
      integrity,
      spaces,
    });
    const offending = atomsOutsideCeiling(resolved, policy.maxConfidentiality);
    for (const clause of offending) {
      // Ungrantable: the marker means "the label could not be read" — no
      // ceiling entry, declassification, or resolved alternative may admit it.
      if (
        clauseAlternatives(clause).some((alternative) =>
          deepEqual(alternative, CFC_LABEL_READ_FAILED_ATOM)
        )
      ) {
        return false;
      }
      // Author declassification names an ATOM; after exchange resolution an
      // offending clause may be an OR of alternatives, so match the
      // declassified atom against the clause OR any of its alternatives —
      // releasing one alternative of a disjunctive clause releases the clause.
      if (
        policy.declassifyConfidentiality.some((declassified) =>
          deepEqual(declassified, clause) ||
          clauseAlternatives(clause).some((alternative) =>
            deepEqual(declassified, alternative)
          )
        )
      ) {
        continue;
      }
      if (this.#canRenderConfidentialityAtom(clause, policy)) {
        continue;
      }
      return false;
    }
    return true;
  }

  /**
   * Per-atom admission under a render policy. The read-failure marker is
   * UNGRANTABLE (audit item 22): it means "the label could not be read", so
   * neither author declassification nor a ceiling entry — even one naming
   * the exported marker string — may admit it. Every other atom checks
   * declassification first, then the ceiling.
   */
  #atomRenderableUnderPolicy(
    atom: unknown,
    policy: RenderPolicy,
  ): boolean {
    if (deepEqual(atom, CFC_LABEL_READ_FAILED_ATOM)) {
      return false;
    }
    if (
      policy.declassifyConfidentiality.some((declassified) =>
        deepEqual(declassified, atom)
      )
    ) {
      return true;
    }
    return this.#canRenderConfidentialityAtom(atom, policy);
  }

  #confidentialityLabels(
    labelView: CfcLabelView,
  ): readonly CfcConfClause[] {
    return ContextualFlowControl.uniqueAtoms(
      labelView.entries.flatMap((entry) => [
        ...(entry.label.confidentiality ?? []),
      ]),
    );
  }

  /**
   * The label the render gate decided on, in the form an explanation reports
   * it: the cell's own view when it has one, the schema's information-flow
   * constraint as the same conservative fallback the gate uses, and the
   * read-failure case named rather than left blank.
   */
  #renderLabelSummary(cell: Cell<unknown>): {
    labelSource: "stored" | "schema" | "unreadable";
    confidentiality: readonly CfcConfClause[];
    integrity: readonly CfcAtom[];
  } {
    let labelView: CfcLabelView | undefined;
    try {
      labelView = this.#resolveCellLabelView(cell);
    } catch {
      return { labelSource: "unreadable", confidentiality: [], integrity: [] };
    }
    if (labelView === undefined) {
      return {
        labelSource: "schema",
        confidentiality: this.#confidentialityLabelsFromCellSchema(
          cell,
        ) as readonly CfcConfClause[],
        integrity: [],
      };
    }
    return {
      labelSource: "stored",
      confidentiality: this.#confidentialityLabels(labelView),
      integrity: this.#integrityLabels(labelView),
    };
  }

  /**
   * Report a cell the render policy would not admit.
   *
   * The detail carries the decision's inputs: the label the gate read, the
   * ceiling, the author declassifications, and the caveat kinds the host
   * allows. Which of those decided is the fit's business, and the fit reads
   * them together — a clause outside the ceiling still renders when a
   * declassification or an admitted caveat kind covers it, and the ungrantable
   * read-failure marker blocks with no ceiling in force at all.
   */
  #denyCellRender(cell: Cell<unknown>, policy: RenderPolicy): void {
    reportCfcDenial(
      "render-confidentiality-ceiling",
      "the render policy did not admit a cell's confidentiality label",
      () => ({
        ...this.#renderLabelSummary(cell),
        ceiling: policy.maxConfidentiality ?? "unbounded",
        declassified: policy.declassifyConfidentiality,
        caveatKindAllow: policy.caveatKindAllow,
      }),
    );
  }

  /**
   * Explain text from a cell that the boundary's integrity floor rejects.
   * `prop` names the sink when the blocked text was a prop value rather than
   * a child, so two props blocked on one node stay two decisions.
   */
  #denyCellText(
    cell: Cell<unknown>,
    policy: RenderPolicy,
    prop?: string,
  ): void {
    reportCfcDenial(
      "render-text-integrity",
      "a cell's text does not carry the integrity this boundary requires",
      () => {
        const label = this.#renderLabelSummary(cell);
        return {
          ...(prop === undefined ? {} : { prop }),
          labelSource: label.labelSource,
          integrity: label.integrity,
          textIntegrity: policy.textIntegrity,
        };
      },
    );
  }

  /** Explain literal text inside a boundary that admits none. */
  #denyLiteralText(policy: RenderPolicy, prop?: string): void {
    reportCfcDenial(
      "render-literal-text-integrity",
      "literal text cannot be endorsed, and this boundary admits no " +
        "unendorsed text",
      () => ({
        ...(prop === undefined ? {} : { prop }),
        textIntegrity: policy.textIntegrity,
      }),
    );
  }

  /**
   * §4.9.3 Stage 2 (spec §18.4.5): subscribe `reeval` to the ACL docs of the
   * spaces the render resolver consults for `cell`'s label
   * (`membershipSpacesInConfidentiality`, which adds module-policy subjects to
   * the spec's `Space(X)` candidates per `docs/specs/cfc-spec-changes.md`
   * SC-44), and to the manifest document of
   * each module policy the label selects in each space the label was read
   * from, so a fail-closed over-block re-renders when an ACL later grants (or
   * revokes) READ or a manifest arrives. Shared by the descendant-cell
   * (`renderCellChild`) and root-mounted (`mount`) egress paths. A no-op
   * without a membership provider or manifest source, or when the label
   * carries nothing either would watch; idempotent per watched document via
   * `watched`; cancels register through `addCancel` (the cell's cancel group).
   * Reads the same label view the render fit consumes, so what the fit
   * resolves and what is watched stay in lockstep. A label-read failure or a
   * subscription that throws is swallowed (fail closed on watching — the
   * render fit itself stays fail-closed independently).
   */
  #watchCellMembership(
    cell: Cell<unknown>,
    watched: Set<string>,
    addCancel: (cancel: Cancel) => void,
    reeval: () => void,
  ): void {
    const provider = this.#membershipProvider;
    const manifests = this.#modulePolicySource;
    if (provider === undefined && manifests === undefined) {
      return;
    }
    // Read the label the render gate reads (`resolveCellLabelView`, including
    // the followed-target fallback) so the watcher and the fit stay in
    // lockstep — a followed cell whose `Space(...)` label lives on the target
    // is watched, not silently left un-upgradable.
    let source: CfcLabelViewSource;
    try {
      source = this.#resolveCellLabelSource(cell);
    } catch {
      return;
    }
    // No stored label (or a read failure) → nothing to watch. The render fit
    // still fail-closes independently; we just set up no reactive upgrade.
    if (source.view === undefined) return;
    const confidentiality = this.#confidentialityLabels(source.view);
    // A subscription that throws leaves that document unwatched (fail closed
    // on watching) and must not escape into the cell's sink.
    const watch = (key: string, subscribe: () => Cancel) => {
      if (watched.has(key)) return;
      try {
        addCancel(subscribe());
        watched.add(key);
      } catch (error) {
        // Unwatched; the render fit stays fail-closed independently, but a
        // cell that can no longer upgrade should say why.
        logger.error(
          "render policy watch subscription failed",
          () => ({ key, error }),
        );
      }
    };
    if (provider !== undefined) {
      for (const space of membershipSpacesInConfidentiality(confidentiality)) {
        watch(
          `membership:${space}`,
          () => provider.subscribe(space, reeval),
        );
      }
    }
    if (manifests !== undefined) {
      for (
        const reference of modulePolicyRefsInConfidentiality(confidentiality)
      ) {
        for (const space of source.spaces) {
          watch(
            `manifest:${JSON.stringify([space, reference.policyDigest])}`,
            () => manifests.subscribe(reference, space, reeval),
          );
        }
      }
    }
  }

  #confidentialityLabelsFromCellSchema(
    cell: Cell<unknown>,
  ): readonly unknown[] {
    const schema = (cell as { schema?: JSONSchema }).schema;
    if (schema === undefined) {
      return [];
    }
    const joined = new Set<unknown>();
    try {
      ContextualFlowControl.joinSchema(joined, schema);
    } catch {
      return ["__unknown_cfc_schema_label__"];
    }
    return ContextualFlowControl.uniqueAtoms(joined);
  }

  #canRenderConfidentialityAtom(
    atom: unknown,
    policy: RenderPolicy,
  ): boolean {
    const max = this.#normalizeAtomBound(policy.maxConfidentiality);
    if (max === undefined) {
      return true;
    }
    if (max.some((allowed) => deepEqual(allowed, atom))) {
      return true;
    }
    // Default-ceiling caveat-kind allowance (spec §8.10.6): Caveat-type
    // atoms of an allow-listed kind render — these are the
    // display-dischargeable classes (e.g. prompt influence), admitted by
    // kind rather than by enumerating every (kind, source) instance.
    const kinds = policy.caveatKindAllow;
    if (
      kinds !== undefined && kinds.length > 0 &&
      isObjectOrArray(atom) && atom.type === CFC_CAVEAT_ATOM_TYPE &&
      typeof atom.kind === "string" && kinds.includes(atom.kind)
    ) {
      return true;
    }
    return false;
  }

  #refreshTextIntegrityBoundary(
    ctx: ReconcileContext,
    state: NodeState,
  ): void {
    if (
      state.tagName !== CFC_AUTHORSHIP_TAG ||
      state.sourceProps === undefined ||
      state.sourceChildren === undefined ||
      state.children.size === 0
    ) {
      return;
    }

    this.#refreshBoundaryPolicyFromProps(ctx, state, state.sourceProps);
  }

  #isTextIntegrityPolicyProp(key: string): boolean {
    return key === "requiredTextIntegrity" ||
      key === "requiredIntegrity" ||
      key === "data-cfc-required-text-integrity" ||
      key === "author" ||
      key === "$author" ||
      key === "verifyTextIntegrity" ||
      key === "verify-text-integrity" ||
      key === "data-cfc-verify-text-integrity" ||
      key === "allowLiteralText" ||
      key === "allow-literal-text" ||
      key === "data-cfc-allow-literal-text";
  }

  #initializeTextIntegrityBoundary(
    policy: RenderPolicy,
    nodeId: number,
  ): void {
    if (!policy.textIntegrity?.boundaryNodeIds.has(nodeId)) {
      return;
    }
    this.#queueOps([{
      op: "set-prop",
      nodeId,
      key: "textIntegrityState",
      value: "ok",
    }]);
  }

  #refreshTextIntegrityBoundaryState(
    state: NodeState,
    policy: RenderPolicy,
  ): void {
    if (state.tagName !== CFC_AUTHORSHIP_TAG) {
      return;
    }
    if (
      policy.textIntegrity !== undefined &&
      !policy.textIntegrity.boundaryNodeIds.has(state.nodeId)
    ) {
      return;
    }
    const value = policy.textIntegrity === undefined
      ? "ok"
      : this.#hasTextIntegrityBlockForBoundary(state, state.nodeId)
      ? "blocked"
      : "ok";
    this.#queueOps([{
      op: "set-prop",
      nodeId: state.nodeId,
      key: "textIntegrityState",
      value,
    }]);
  }

  #hasTextIntegrityBlockForBoundary(
    state: NodeState,
    boundaryNodeId: number,
  ): boolean {
    if (state.textIntegrityBlockedFor?.has(boundaryNodeId)) {
      return true;
    }
    if (
      state.textIntegrityBlockedProps !== undefined &&
      [...state.textIntegrityBlockedProps.values()].some((ids) =>
        ids.has(boundaryNodeId)
      )
    ) {
      return true;
    }
    for (const child of state.children.values()) {
      if (
        child.elementState &&
        this.#hasTextIntegrityBlockForBoundary(
          child.elementState,
          boundaryNodeId,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  #markTextIntegrityBlocked(
    policy: RenderPolicy,
  ): ReadonlySet<number> | undefined {
    const boundaryNodeIds = policy.textIntegrity?.boundaryNodeIds;
    if (boundaryNodeIds === undefined || boundaryNodeIds.size === 0) {
      return undefined;
    }
    // Attribute the block to EVERY enclosing boundary, not just the nearest, so
    // an outer boundary cannot stay "ok" over content that failed its bar.
    this.#queueOps(
      [...boundaryNodeIds].map((nodeId) => ({
        op: "set-prop" as const,
        nodeId,
        key: "textIntegrityState",
        value: "blocked",
      })),
    );
    return boundaryNodeIds;
  }

  #canRenderCellTextUnderPolicy(
    cell: Cell<unknown>,
    policy: RenderPolicy,
  ): boolean {
    const textIntegrity = policy.textIntegrity;
    if (textIntegrity === undefined) {
      return true;
    }
    if (textIntegrity.requiredIntegrity.length === 0) {
      return false;
    }

    let labelView: CfcLabelView | undefined;
    try {
      labelView = cfcLabelViewForCell(cell);
      if (labelView === undefined) {
        labelView = cfcLabelViewForCell(cell.resolveAsCell());
      }
    } catch {
      return false;
    }
    if (labelView === undefined) {
      return false;
    }

    const integrity = this.#integrityLabels(labelView);
    return textIntegrity.requiredIntegrity.every((required) =>
      integrity.some((atom) => deepEqual(atom, required))
    );
  }

  #integrityLabels(labelView: CfcLabelView): readonly CfcAtom[] {
    return ContextualFlowControl.uniqueAtoms(
      labelView.entries.flatMap((entry) =>
        entry.path.length === 0 ? [...(entry.label.integrity ?? [])] : []
      ),
    );
  }

  #readCellValue(cell: Cell<unknown>): unknown {
    const readableCell = cell as Cell<unknown> & {
      get?: (options?: { traverseCells?: boolean }) => unknown;
      getRawUntyped?: (options?: { frozen?: false }) => unknown;
    };
    try {
      if (typeof readableCell.get === "function") {
        return readableCell.get({ traverseCells: true });
      }
    } catch {
      // Fall back to the raw read below.
    }
    try {
      return readableCell.getRawUntyped?.({ frozen: false });
    } catch {
      return undefined;
    }
  }

  #readCellPolicyValue(cell: Cell<unknown>): unknown {
    const readableCell = cell as Cell<unknown> & {
      get?: (options?: { traverseCells?: boolean }) => unknown;
      getRawUntyped?: (options?: { frozen?: false }) => unknown;
    };
    try {
      return readableCell.getRawUntyped?.({ frozen: false });
    } catch {
      // Fall back to the schema-shaped read below.
    }
    try {
      if (typeof readableCell.get === "function") {
        return readableCell.get({ traverseCells: true });
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  #shouldBlockLiteralText(
    value: unknown,
    policy: RenderPolicy,
  ): boolean {
    const textIntegrity = policy.textIntegrity;
    if (textIntegrity === undefined || textIntegrity.allowLiteralText) {
      return false;
    }
    return this.#hasVisibleTextValue(value);
  }

  #shouldBlockTextFromCell(
    value: unknown,
    cell: Cell<unknown>,
    policy: RenderPolicy,
  ): boolean {
    if (policy.textIntegrity === undefined) {
      return false;
    }
    if (isWorkerVNode(value) || this.#isRenderableObject(value)) {
      return false;
    }
    if (!this.#hasVisibleTextValue(value)) return false;
    return !this.#canRenderCellTextUnderPolicy(cell, policy);
  }

  #isRenderableObject(value: unknown): boolean {
    return isObjectOrArray(value) && UI in value;
  }

  #hasVisibleTextValue(value: unknown): boolean {
    if (value === null || value === undefined || value === false) {
      return false;
    }
    if (typeof value === "string") {
      return value.length > 0;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return true;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return typeof value === "object";
  }

  #isTextIntegrityProp(state: NodeState, key: string): boolean {
    return TEXT_INTEGRITY_PROP_SINKS.get(state.tagName)?.has(key) ?? false;
  }

  /**
   * Whether re-asserting a re-supplied static primitive prop can skip its
   * worker→main set-prop op. Shared by the inline static-prop path
   * (updatePropsInPlace) and the Cell<Props> primitive path so the two cannot
   * drift apart (CT-1798 / CT-1803).
   *
   * A skip is sound only when a repeated set-prop would be a true no-op on the
   * main thread: setPropDefault value-guards the DOM write, but the op and the
   * JSON.stringify it carries are not free. It is taken only for an unchanged
   * primitive whose prior state was itself a static primitive, and never when:
   *   - the value is an object/array — reference equality is unreliable;
   *   - the prop is a text-integrity sink — its transform has policy-dependent
   *     side effects and must re-run;
   *   - the prop's live DOM value can drift independently of the VDOM
   *     (DOM_LIVE_PROPS) — there the repeated op repairs drift via
   *     setPropDefault's compare against the *live* value, which the worker
   *     cannot observe.
   * Assumes the default value-guarded setProp; a custom setProp with observable
   * same-value behavior would not be re-invoked on a skip.
   */
  #canSkipUnchangedStaticProp(
    state: NodeState,
    key: string,
    value: unknown,
    existingState: PropState | undefined,
  ): boolean {
    const isPrimitiveValue = value === null ||
      (typeof value !== "object" && typeof value !== "function");
    return isPrimitiveValue &&
      existingState !== undefined &&
      existingState.cell === undefined &&
      // `Object.is`, not `===`: an unchanged `NaN` prop must still be
      // skippable, and a `0` -> `-0` change is a real change.
      Object.is(existingState.currentValue, value) &&
      !this.#isTextIntegrityProp(state, key) &&
      !DOM_LIVE_PROPS.has(key);
  }

  /**
   * Subscribes to `cell` for a prop's value, reading through an opaque
   * reference to the scalar it names.
   *
   * A prop that reaches the reconciler as a reference — a position the
   * pattern declared `unknown`, or one reached through a link that does —
   * projects to an object carrying nothing of what it names. A DOM attribute
   * or property can hold only the value, so the renderer reads the
   * reference's own position for the scalar there and follows it as it
   * changes. A record or a list behind the reference stays the reference its
   * declaration made it.
   */
  #sinkPropValue(
    cell: Cell<unknown>,
    deliver: (value: unknown) => void,
  ): Cancel {
    let referenced: { cell: Cell<unknown>; cancel: Cancel } | undefined;
    const cancelOuter = this.#sinkCell(cell, (value) => {
      const named = cellOfOpaqueReference(value);
      if (named === undefined) {
        referenced?.cancel();
        referenced = undefined;
        deliver(value);
        return;
      }
      // The reference's position outlives the read that projected it, so the
      // subscription must not hold that read's transaction.
      const scalar = named.withTx(undefined).asSchema(REFERENCED_SCALAR_SCHEMA);
      if (referenced !== undefined && areLinksSame(referenced.cell, scalar)) {
        return;
      }
      referenced?.cancel();
      referenced = {
        cell: scalar,
        cancel: this.#sinkCell(scalar, deliver),
      };
    });
    return () => {
      cancelOuter();
      referenced?.cancel();
      referenced = undefined;
    };
  }

  #transformPropValueForState(
    state: NodeState,
    key: string,
    value: unknown,
    sourceCell?: Cell<unknown>,
    // deno-lint-ignore no-explicit-any
  ): any {
    if (this.#isTextIntegrityProp(state, key)) {
      const shouldBlock = sourceCell
        ? this.#shouldBlockTextFromCell(value, sourceCell, state.renderPolicy)
        : this.#shouldBlockLiteralText(value, state.renderPolicy);
      if (!shouldBlock) {
        state.textIntegrityBlockedProps?.delete(key);
        return this.#transformPropValue(key, value);
      }
      if (sourceCell !== undefined) {
        this.#denyCellText(sourceCell, state.renderPolicy, key);
      } else {
        this.#denyLiteralText(state.renderPolicy, key);
      }
      const boundaryNodeIds = this.#markTextIntegrityBlocked(
        state.renderPolicy,
      );
      if (boundaryNodeIds !== undefined) {
        if (state.textIntegrityBlockedProps === undefined) {
          state.textIntegrityBlockedProps = new Map();
        }
        state.textIntegrityBlockedProps.set(key, boundaryNodeIds);
      }
      this.#queueOps([{
        op: "set-prop",
        nodeId: state.nodeId,
        key: "data-cfc-blocked-props",
        value: key,
      }]);
      return CFC_TEXT_INTEGRITY_PLACEHOLDER;
    }
    return this.#transformPropValue(key, value);
  }

  /**
   * Create a wrapper state for reactive roots.
   */
  #createWrapperState(_ctx: ReconcileContext, nodeId: number): {
    nodeId: number;
    currentChild: NodeState | null;
    cancel: Cancel;
  } {
    return {
      nodeId,
      currentChild: null,
      cancel: () => {},
    };
  }

  /**
   * Extract the underlying VNode from a WorkerRenderNode.
   * Follows [UI] chains and returns the VNode, or null if not a VNode.
   * Includes cycle detection to prevent infinite loops.
   */
  #extractVNode(node: unknown): WorkerVNode | null {
    if (isWorkerVNode(node)) return node;

    // Follow [UI] chain with cycle detection
    const visited = new Set<object>();
    let current: unknown = node;
    while (current && typeof current === "object" && UI in current) {
      if (visited.has(current as object)) {
        // Cycle detected, return null
        return null;
      }
      visited.add(current as object);
      // deno-lint-ignore no-explicit-any
      current = (current as any)[UI];
    }

    return isWorkerVNode(current) ? current : null;
  }

  /**
   * Reconcile a VNode into a wrapper (for reactive roots).
   * Diffs old vs new VNodes and updates in place when possible.
   */
  #reconcileIntoWrapper(
    ctx: ReconcileContext,
    wrapper: {
      nodeId: number;
      currentChild: NodeState | null;
      cancel: Cancel;
    },
    node: WorkerRenderNode,
    policy: RenderPolicy,
  ): void {
    const newVNode = this.#extractVNode(node);
    const oldState = wrapper.currentChild;

    // Get old element's tag name (if it exists and is an element)
    const oldTagName = oldState && "tagName" in oldState
      ? oldState.tagName
      : null;
    const newTagName = newVNode?.name ?? null;

    logger.debug("reconcile-check", () => ({
      oldId: oldState?.nodeId,
      oldTagName,
      newTagName,
      match: Boolean(
        oldState && oldTagName && newTagName && oldTagName === newTagName,
      ),
      newVNodeName: newVNode?.name,
      oldStateHasTagName: oldState && "tagName" in oldState,
      isOldStateText: oldState?.tagName === "#text",
    }));

    // Case 1: Same element type - update in place
    if (oldState && oldTagName && newTagName && oldTagName === newTagName) {
      const sanitized = this.#sanitizeNode(newVNode!);
      if (sanitized) {
        const childPolicy = this.#childRenderPolicyForNode(
          sanitized,
          policy,
          oldState.nodeId,
        );
        const policyChildren = this.#childrenForRenderPolicy(
          sanitized,
          childPolicy,
        );
        const policyChanged = !this.#renderPolicyEquals(
          oldState.childRenderPolicy,
          childPolicy,
        ) || oldState.childrenBlockedByPolicy !== policyChildren.blocked;
        logger.debug("reconcile-node", () => ({
          id: wrapper.nodeId,
          strategy: "update-in-place",
          tagName: newTagName,
        }));
        oldState.renderPolicy = policy;
        oldState.childRenderPolicy = childPolicy;
        this.#setChildrenBlocked(oldState, policyChildren, childPolicy);
        oldState.sourceChildren = sanitized.children;
        oldState.sourceProps = sanitized.props;
        // Update props in place with proper diffing
        this.#updatePropsInPlace(ctx, oldState, sanitized.props);

        // Update children in place with proper diffing
        if (policyChildren.children !== undefined) {
          const childrenSame = this.#areChildrenSame(
            oldState,
            policyChildren.children,
          );
          this.#updateChildrenInPlace(
            ctx,
            oldState,
            policyChildren.children,
            new Set(),
            childPolicy,
            policyChanged,
          );
          if (!childrenSame || policyChanged) {
            this.#refreshTextIntegrityBoundaryState(oldState, childPolicy);
          }
        }
        return;
      }
      // sanitized is null (e.g., script tag) - fall through to Case 2 to remove
    }

    // Case 2: Different type, text node, array, or no previous - destroy and recreate
    if (wrapper.currentChild) {
      logger.debug("reconcile-node", () => ({
        id: wrapper.nodeId,
        strategy: "replace",
        oldTag: oldTagName,
        newTag: newTagName,
      }));
      wrapper.cancel();
      this.#cleanupNodeHandlers(wrapper.currentChild);
      this.#queueOps([{
        op: "remove-node",
        nodeId: wrapper.currentChild.nodeId,
      }]);
      wrapper.currentChild = null;
      wrapper.cancel = () => {};
    }

    // Render new node - renderNode handles all render node types
    const state = this.#renderNode(ctx, node, new Set(), policy);

    if (state) {
      this.#queueOps([
        {
          op: "insert-child",
          parentId: wrapper.nodeId,
          childId: state.nodeId,
          beforeId: null,
        },
      ]);
      wrapper.currentChild = state;
      // Use the state's cancel function directly - it owns all child subscriptions
      wrapper.cancel = state.cancel;
    } else {
      wrapper.currentChild = null;
      wrapper.cancel = () => {};
    }
  }

  /**
   * Update props in place with proper diffing.
   * - Same Cell (via areLinksSame) → leave subscription alone
   * - Different Cell → cancel old subscription, set up new one
   * - Missing prop → cancel subscription, remove prop from DOM
   */
  #updatePropsInPlace(
    ctx: ReconcileContext,
    state: NodeState,
    newProps: WorkerProps | Cell<WorkerProps> | null | undefined,
  ): void {
    // Handle Cell<Props> - if same cell, do nothing; otherwise re-subscribe
    if (isCell(newProps)) {
      const existingState = state.propSubscriptions.get(CELL_PROPS_KEY);
      if (existingState?.cell && areLinksSame(existingState.cell, newProps)) {
        // Same Cell, leave subscription in place
        logger.debug("props-same-cell", () => ({ nodeId: state.nodeId }));
        return;
      }
      // Different Cell - cancel all old subscriptions
      this.#removeAllProps(state);

      // Set up new Cell<Props> binding
      this.#bindCellProps(ctx, state, newProps as Cell<WorkerProps>);
      return;
    }

    // Handle static props object
    if (!newProps || typeof newProps !== "object") {
      // No props - remove all existing
      this.#removeAllProps(state);
      return;
    }

    const newPropKeys = new Set(Object.keys(newProps));

    // Find props to remove (exist in old but not in new)
    for (const [key, propState] of state.propSubscriptions) {
      if (key === CELL_PROPS_KEY) continue;
      if (!newPropKeys.has(key)) {
        // Prop removed - cancel subscription and remove from DOM
        propState.cancel();
        state.propSubscriptions.delete(key);
        this.#removeSingleProp(state, key);
      }
    }

    // Update or add props
    for (const [key, value] of Object.entries(newProps)) {
      const existingState = state.propSubscriptions.get(key);

      if (isEventProp(key)) {
        // Event handlers - always re-register (they don't have Cell diffing)
        this.#updateEventProp(ctx, state, key, value, existingState);
      } else if (isBindingProp(key)) {
        // Bindings - check if Cell is same
        this.#updateBindingProp(state, key, value, existingState);
      } else if (isCell(value)) {
        // Reactive prop - check if Cell is same
        if (existingState?.cell && areLinksSame(existingState.cell, value)) {
          // Same Cell, leave subscription in place
          logger.debug("prop-same-cell", () => ({ nodeId: state.nodeId, key }));
          continue;
        }
        // Different Cell - cancel old and set up new
        if (existingState) {
          existingState.cancel();
        }
        const cancel = this.#sinkPropValue(value as Cell<unknown>, (
          resolvedValue,
        ) => {
          logger.debug(
            "prop-update",
            () => ({ nodeId: state.nodeId, key, value: resolvedValue }),
          );
          const propValue = this.#transformPropValueForState(
            state,
            key,
            resolvedValue,
            value as Cell<unknown>,
          );
          this.#queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
          if (this.#isTextIntegrityPolicyProp(key)) {
            this.#refreshTextIntegrityBoundary(ctx, state);
          }
        });
        state.propSubscriptions.set(key, {
          cell: value as Cell<unknown>,
          cancel,
        });
      } else {
        // Static prop. Skip the redundant worker→main set-prop op for an
        // unchanged primitive value (see canSkipUnchangedStaticProp). #4366 made
        // updateChildrenInPlace always reconcile reused inline-VNode children,
        // so this path now fires on every parent recompute even when captured
        // values are identical; damping it removes the op + JSON.stringify
        // churn (CT-1798).
        if (
          this.#canSkipUnchangedStaticProp(state, key, value, existingState)
        ) {
          continue;
        }
        if (existingState) {
          existingState.cancel();
        }
        const propValue = this.#transformPropValueForState(state, key, value);
        this.#queueOps([{
          op: "set-prop",
          nodeId: state.nodeId,
          key,
          value: propValue,
        }]);
        state.propSubscriptions.set(key, {
          cell: undefined,
          cancel: () => {},
          currentValue: value,
        });
      }
    }
  }

  /**
   * Remove all props from a node.
   */
  #removeAllProps(state: NodeState): void {
    for (const [key, propState] of state.propSubscriptions) {
      propState.cancel();
      if (key === CELL_PROPS_KEY) continue;
      this.#removeSingleProp(state, key);
    }
    state.propSubscriptions.clear();
    state.textIntegrityBlockedProps?.clear();
  }

  /**
   * Helper to get a debug ID for a cell (space/id or similar).
   */
  #getCellDebugId(cell: Cell<unknown>): string {
    try {
      // Accessing internal link info for debugging
      const link = cell.getAsNormalizedFullLink();
      const path = link.path.length > 0 ? `:${link.path.join("/")}` : "";
      return `cell:${link.space?.toString() ?? "?"}/${link.id ?? "?"}${path}`;
    } catch {
      return "cell:unknown";
    }
  }

  /**
   * Update an event prop.
   */
  #updateEventProp(
    ctx: ReconcileContext,
    state: NodeState,
    key: string,
    value: unknown,
    existingState: PropState | undefined,
  ): void {
    const eventType = getEventType(key);

    // Equality check: if value is same as current, do nothing
    if (existingState && existingState.currentValue === value) {
      return;
    }

    // Special check for Cell equality if both are cells
    if (
      isCell(value) && existingState?.currentValue &&
      isCell(existingState.currentValue)
    ) {
      if (
        areLinksSame(value, existingState.currentValue)
      ) {
        // Same cell link, no update needed
        return;
      }
    }

    // Log for debugging
    let valueId = "";
    if (isCell(value)) {
      valueId = this.#getCellDebugId(value as Cell<unknown>);
    }

    let oldValueId = "";
    const oldValue = existingState?.currentValue;
    if (isCell(oldValue)) {
      oldValueId = this.#getCellDebugId(oldValue as Cell<unknown>);
    }

    logger.debug(
      "update-event-prop",
      () => ({
        nodeId: state.nodeId,
        key,
        valueId,
        oldValueId: oldValueId || (oldValue ? String(oldValue) : undefined),
        isCell: isCell(value),
      }),
    );

    // Cancel existing subscription
    if (existingState) {
      existingState.cancel();
    }

    if (this.#retireEventHandler(state, eventType) !== undefined) {
      this.#queueOps([{
        op: "remove-event",
        nodeId: state.nodeId,
        eventType,
      }]);
    }

    if (isStream(value)) {
      const stream = value as Stream<unknown>;
      const handlerId = this.#registerHandler(ctx, (event) => {
        stream.withTx(undefined).send(event);
      }, stream.asSchema({}));
      state.eventHandlers.set(eventType, handlerId);
      this.#queueOps([{
        op: "set-event",
        nodeId: state.nodeId,
        eventType,
        handlerId,
      }]);
      state.propSubscriptions.set(key, {
        cell: undefined,
        cancel: () => {},
        currentValue: value,
      });
    } else if (isEventHandler(value)) {
      const handlerId = this.#registerHandler(ctx, value);
      state.eventHandlers.set(eventType, handlerId);
      this.#queueOps([{
        op: "set-event",
        nodeId: state.nodeId,
        eventType,
        handlerId,
      }]);
      state.propSubscriptions.set(key, {
        cell: undefined,
        cancel: () => {},
        currentValue: value,
      });
    } else if (isCell(value)) {
      // For Cells, we don't store currentValue to compare the Cell itself here
      // because the value passed to updateEventProp is usually the Cell itself.
      // If updatePropsInPlace passed the Cell, then `currentValue === value` check above covers it.

      const cancel = this.#sinkCell(
        value as Cell<(event: unknown) => void>,
        (handler) => {
          if (this.#retireEventHandler(state, eventType) !== undefined) {
            this.#queueOps([{
              op: "remove-event",
              nodeId: state.nodeId,
              eventType,
            }]);
          }

          if (handler) {
            const handlerId = this.#registerHandler(
              ctx,
              handler as (event: unknown) => void,
              value as Cell<unknown>,
            );
            state.eventHandlers.set(eventType, handlerId);
            this.#queueOps([{
              op: "set-event",
              nodeId: state.nodeId,
              eventType,
              handlerId,
            }]);
          }
        },
      );
      state.propSubscriptions.set(key, {
        cell: value as Cell<unknown>,
        cancel,
        currentValue: value,
      });
    }
  }

  /**
   * Update a binding prop ($prop).
   */
  #updateBindingProp(
    state: NodeState,
    key: string,
    value: unknown,
    existingState: PropState | undefined,
  ): void {
    const propName = getBindingPropName(key);

    if (isCell(value)) {
      // Check if same Cell
      if (existingState?.cell && areLinksSame(existingState.cell, value)) {
        logger.debug(
          "binding-same-cell",
          () => ({ nodeId: state.nodeId, key }),
        );
        return; // Same binding, leave it alone
      }

      // Different Cell - update binding
      if (existingState) {
        existingState.cancel();
      }
      this.#queueOps(
        this.#bindingOpsForCell(state, propName, value as Cell<unknown>),
      );
      state.propSubscriptions.set(key, {
        cell: value as Cell<unknown>,
        cancel: () => {},
      });
    }
  }

  /**
   * Bind Cell<Props> with per-prop handling strategy.
   *
   * - Event props: resolved via .key().resolveAsCell() → stream/handler registration
   * - Binding props: resolved via .key().resolveAsCell() → cell reference
   * - Style objects: resolved by the Cell<Props> schema and parent sink
   * - Other object/array props: per-prop sink via .key().asSchema(true)
   * - Primitive props: set directly from the resolved Cell<Props> value
   */
  #bindCellProps(
    ctx: ReconcileContext,
    state: NodeState,
    propsCell: Cell<WorkerProps>,
  ): void {
    let hasSeenInitialProps = false;
    const refreshPolicyAfterPropsUpdate = () => {
      const childrenAlreadyBound = state.children.size > 0 ||
        state.childrenState !== undefined ||
        state.childOrder.length > 0;
      if (hasSeenInitialProps || childrenAlreadyBound) {
        this.#refreshBoundaryPolicyFromProps(ctx, state, propsCell);
      } else {
        this.#refreshInitialBoundaryPolicyFromProps(state, propsCell);
      }
      hasSeenInitialProps = true;
    };

    const sinkCancel = this.#sinkCell(propsCell, (resolvedProps) => {
      logger.debug("cell-props-emit", () => ({
        nodeId: state.nodeId,
        props: resolvedProps,
      }));

      if (!resolvedProps || typeof resolvedProps !== "object") {
        // Props cleared - remove everything
        for (const [key, propState] of state.propSubscriptions) {
          if (key === CELL_PROPS_KEY) continue;
          propState.cancel();
          this.#removeSingleProp(state, key);
        }
        // Keep only the Cell<Props> subscription itself
        const cellPropsSub = state.propSubscriptions.get(CELL_PROPS_KEY);
        state.propSubscriptions.clear();
        if (cellPropsSub) {
          state.propSubscriptions.set(CELL_PROPS_KEY, cellPropsSub);
        }
        refreshPolicyAfterPropsUpdate();
        return;
      }

      const props = resolvedProps as Record<string, unknown>;
      const newKeys = new Set(Object.keys(props));

      // Remove props that no longer exist
      for (const [key, propState] of state.propSubscriptions) {
        if (key === CELL_PROPS_KEY) continue;
        if (!newKeys.has(key)) {
          propState.cancel();
          this.#removeSingleProp(state, key);
          state.propSubscriptions.delete(key);
        }
      }

      // Process each prop
      for (const [key, value] of Object.entries(props)) {
        if (isEventProp(key)) {
          // Event prop - resolve target via Cell navigation
          let resolvedTarget: Cell<unknown>;
          try {
            // Event handlers outlive the render transaction that resolved the
            // props cell, so avoid capturing a tx-bound cell here.
            resolvedTarget = propsCell.key(key).resolveAsCell().withTx();
          } catch (e) {
            logger.error(
              "resolveAsCell failed for event prop",
              () => ({ nodeId: state.nodeId, key, error: e }),
            );
            continue;
          }
          const existingState = state.propSubscriptions.get(key);

          // Skip if same target Cell
          if (
            existingState?.cell &&
            areLinksSame(existingState.cell, resolvedTarget)
          ) {
            continue;
          }

          const eventType = getEventType(key);

          if (this.#retireEventHandler(state, eventType) !== undefined) {
            this.#queueOps([{
              op: "remove-event",
              nodeId: state.nodeId,
              eventType,
            }]);
          }
          if (existingState) existingState.cancel();

          const handlerId = this.#registerHandler(
            ctx,
            (event) => resolvedTarget.withTx(undefined).send(event),
            resolvedTarget,
          );
          state.eventHandlers.set(eventType, handlerId);
          this.#queueOps([{
            op: "set-event",
            nodeId: state.nodeId,
            eventType,
            handlerId,
          }]);
          state.propSubscriptions.set(key, {
            cell: resolvedTarget,
            cancel: () => {},
          });
        } else if (isBindingProp(key)) {
          // Binding prop - prefer a serialized cell link in the prop value.
          // Cell<Props> VDOM props can store links to the original target cell;
          // resolving the props slot itself would bind an internal VDOM cell.
          let resolvedTarget: Cell<unknown>;
          try {
            resolvedTarget = this.#resolveCellPropsBindingTarget(
              propsCell,
              key,
              value,
            );
          } catch (e) {
            logger.error(
              "resolveAsCell failed for binding prop",
              () => ({ nodeId: state.nodeId, key, error: e }),
            );
            continue;
          }
          const existingState = state.propSubscriptions.get(key);

          // Skip if same Cell
          if (
            existingState?.cell &&
            areLinksSame(existingState.cell, resolvedTarget)
          ) {
            continue;
          }
          if (existingState) existingState.cancel();

          const propName = getBindingPropName(key);
          this.#queueOps(
            this.#bindingOpsForCell(state, propName, resolvedTarget),
          );
          state.propSubscriptions.set(key, {
            cell: resolvedTarget,
            cancel: () => {},
          });
        } else if (
          key !== "style" && isObjectOrArray(value)
        ) {
          // Generic object/array values are deliberately capped in
          // rendererVDOMSchema, so they need a per-prop sink for deep
          // resolution. Style is excluded: its explicit schema already
          // traverses the object through the parent props sink.
          const existingState = state.propSubscriptions.get(key);
          if (existingState?.cell) continue; // Already has active per-prop sink

          // Cancel any existing primitive subscription for this key
          if (existingState) existingState.cancel();

          // Schema `true` = accept everything → enables deep traversal of this prop
          const propKeyCell = propsCell.key(key).asSchema(true);
          const propSinkCancel = this.#sinkPropValue(propKeyCell, (
            deepValue,
          ) => {
            const propValue = this.#transformPropValueForState(
              state,
              key,
              deepValue,
              this.#resolveTextPropSourceCell(state, propsCell, key, value),
            );
            this.#queueOps([{
              op: "set-prop",
              nodeId: state.nodeId,
              key,
              value: propValue,
            }]);
          });
          state.propSubscriptions.set(key, {
            cell: propKeyCell as Cell<unknown>,
            cancel: propSinkCancel,
          });
        } else {
          // Schema-resolved style value or primitive value - set directly
          const existingState = state.propSubscriptions.get(key);

          // Cancel a generic per-prop sink if its value became direct.
          if (existingState?.cell) {
            existingState.cancel();
          }

          // Skip a redundant op for an unchanged primitive, using the same
          // predicate as the inline static-prop path so both honor the same
          // DOM-live / text-integrity exclusions (CT-1803). Object values are
          // never skipped by the predicate, and cell prop states have no
          // currentValue, so transitions (e.g. to undefined) still emit.
          if (
            this.#canSkipUnchangedStaticProp(state, key, value, existingState)
          ) {
            continue;
          }

          const propValue = this.#transformPropValueForState(
            state,
            key,
            value,
            this.#resolveTextPropSourceCell(state, propsCell, key, value),
          );
          this.#queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
          state.propSubscriptions.set(key, {
            cell: undefined,
            cancel: () => {},
            currentValue: value,
          });
        }
      }
      refreshPolicyAfterPropsUpdate();
    });

    state.propSubscriptions.set(CELL_PROPS_KEY, {
      cell: propsCell as Cell<unknown>,
      cancel: sinkCancel,
    });
  }

  #refreshBoundaryPolicyFromProps(
    ctx: ReconcileContext,
    state: NodeState,
    props: WorkerVNode["props"],
  ): void {
    if (
      state.tagName !== CFC_RENDER_BOUNDARY_TAG &&
      state.tagName !== CFC_AUTHORSHIP_TAG
    ) {
      return;
    }
    if (state.sourceChildren === undefined) {
      return;
    }

    const node: WorkerVNode = {
      type: "vnode",
      name: state.tagName,
      props,
      children: state.sourceChildren,
    };
    const childPolicy = this.#childRenderPolicyForNode(
      node,
      state.renderPolicy,
      state.nodeId,
    );
    const policyChildren = this.#childrenForRenderPolicy(node, childPolicy);
    const policyChanged = !this.#renderPolicyEquals(
      state.childRenderPolicy,
      childPolicy,
    ) || state.childrenBlockedByPolicy !== policyChildren.blocked;

    state.sourceProps = props;
    state.childRenderPolicy = childPolicy;
    this.#setChildrenBlocked(state, policyChildren, childPolicy);
    if (policyChildren.children === undefined) {
      return;
    }

    const childrenSame = this.#areChildrenSame(state, policyChildren.children);
    if (!childrenSame || policyChanged) {
      this.#updateChildrenInPlace(
        ctx,
        state,
        policyChildren.children,
        new Set(),
        childPolicy,
        policyChanged,
      );
      this.#refreshTextIntegrityBoundaryState(state, childPolicy);
    }
  }

  #refreshInitialBoundaryPolicyFromProps(
    state: NodeState,
    props: WorkerVNode["props"],
  ): void {
    if (
      state.tagName !== CFC_RENDER_BOUNDARY_TAG &&
      state.tagName !== CFC_AUTHORSHIP_TAG
    ) {
      return;
    }
    if (state.sourceChildren === undefined) {
      return;
    }

    const node: WorkerVNode = {
      type: "vnode",
      name: state.tagName,
      props,
      children: state.sourceChildren,
    };
    const childPolicy = this.#childRenderPolicyForNode(
      node,
      state.renderPolicy,
      state.nodeId,
    );
    const policyChildren = this.#childrenForRenderPolicy(node, childPolicy);

    state.sourceProps = props;
    state.childRenderPolicy = childPolicy;
    this.#setChildrenBlocked(state, policyChildren, childPolicy);
    this.#initializeTextIntegrityBoundary(childPolicy, state.nodeId);
  }

  #resolveTextPropSourceCell(
    state: NodeState,
    propsCell: Cell<WorkerProps>,
    key: string,
    value: unknown,
  ): Cell<unknown> | undefined {
    if (!this.#isTextIntegrityProp(state, key)) {
      return undefined;
    }
    try {
      return this.#resolveCellPropsBindingTarget(propsCell, key, value);
    } catch {
      try {
        return propsCell.key(key).asSchema(true) as Cell<unknown>;
      } catch {
        return undefined;
      }
    }
  }

  #resolveCellPropsBindingTarget(
    propsCell: Cell<WorkerProps>,
    key: string,
    value: unknown,
  ): Cell<unknown> {
    const propCell = propsCell.key(key).asSchema(true);
    const rawValue = this.#readRawBindingPropValue(propsCell, propCell, key);
    let base:
      | ReturnType<Cell<WorkerProps>["getAsNormalizedFullLink"]>
      | undefined;
    try {
      base = propsCell.getAsNormalizedFullLink();
    } catch {
      base = undefined;
    }
    const link = base
      ? parseLink(rawValue, base) ?? parseLink(value, base)
      : parseLink(rawValue) ?? parseLink(value);
    if (link?.id && link.space) {
      return propsCell.runtime.getCellFromLink(link);
    }
    if (isCell(value)) {
      return value as Cell<unknown>;
    }
    return propCell.resolveAsCell();
  }

  #readRawBindingPropValue(
    propsCell: Cell<WorkerProps>,
    propCell: Cell<unknown>,
    key: string,
  ): unknown {
    try {
      const rawProps = propsCell.getRawUntyped({ frozen: false });
      if (
        isObjectOrArray(rawProps) && key in rawProps
      ) {
        return (rawProps as Record<string, unknown>)[key];
      }
    } catch {
      // Fall through to the prop cell: older/mock cells may not expose parent raw props.
    }
    try {
      return propCell.getRawUntyped({ frozen: false });
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a single prop from a node (DOM side + handler cleanup).
   */
  #removeSingleProp(state: NodeState, key: string): void {
    state.textIntegrityBlockedProps?.delete(key);
    if (isEventProp(key)) {
      const eventType = getEventType(key);
      this.#retireEventHandler(state, eventType);
      this.#queueOps([{
        op: "remove-event",
        nodeId: state.nodeId,
        eventType,
      }]);
    } else if (isBindingProp(key)) {
      this.#queueOps([{
        op: "remove-prop",
        nodeId: state.nodeId,
        key: getBindingPropName(key),
      }]);
    } else {
      this.#queueOps([{
        op: "remove-prop",
        nodeId: state.nodeId,
        key,
      }]);
    }
  }

  /**
   * Update children in place with proper diffing.
   * If children Cell is the same, leave subscription in place.
   */
  #updateChildrenInPlace(
    ctx: ReconcileContext,
    state: NodeState,
    children: WorkerRenderNode | WorkerRenderNode[],
    visited: Set<object>,
    policy: RenderPolicy,
    forceReplace = false,
  ): void {
    // Handle Cell<children> - check if same Cell
    if (isCell(children)) {
      const existingState = state.childrenState;
      if (
        !forceReplace && existingState?.cell &&
        areLinksSame(existingState.cell, children)
      ) {
        // Same Cell, leave subscription in place
        logger.debug("children-same-cell", () => ({ nodeId: state.nodeId }));
        return;
      }

      // Different Cell - cancel old subscription
      if (existingState) {
        existingState.cancel();
      }

      // Set up new subscription
      const cancel = this.#sinkCell(
        children as Cell<WorkerRenderNode | WorkerRenderNode[]>,
        (resolvedChildren) => {
          logger.debug("children-update", () => ({
            nodeId: state.nodeId,
            count: Array.isArray(resolvedChildren)
              ? resolvedChildren.length
              : 1,
          }));
          this.#updateChildren(
            ctx,
            state,
            resolvedChildren,
            visited,
            policy,
            forceReplace,
          );
        },
      );

      state.childrenState = {
        cell: children as Cell<unknown>,
        cancel,
      };
    } else {
      // Static children - cancel any existing Cell subscription
      if (state.childrenState) {
        state.childrenState.cancel();
        state.childrenState = undefined;
      }
      // Update children directly
      this.#updateChildren(ctx, state, children, visited, policy, forceReplace);
    }
  }

  /**
   * Render any render node type and return its state.
   */
  #renderNode(
    ctx: ReconcileContext,
    inputNode: WorkerRenderNode,
    visited: Set<object>,
    policy: RenderPolicy,
  ): NodeState | null {
    // Handle null/undefined
    if (inputNode === null || inputNode === undefined) {
      return null;
    }

    // Handle text nodes (strings and numbers)
    if (typeof inputNode === "string" || typeof inputNode === "number") {
      return this.#createTextNode(ctx, String(inputNode), policy);
    }

    // Handle arrays - render as fragment wrapper
    if (Array.isArray(inputNode)) {
      return this.#renderArrayAsFragment(ctx, inputNode, visited, policy);
    }

    const [cancel, addCancel] = useCancelGroup();

    // Follow [UI] chain (for objects with $UI property)
    let node: unknown = inputNode;
    while (
      node &&
      typeof node === "object" &&
      UI in node &&
      // deno-lint-ignore no-explicit-any
      (node as any)[UI]
    ) {
      if (visited.has(node as object)) {
        return this.#createCyclePlaceholder(ctx, policy);
      }
      visited.add(node as object);
      // deno-lint-ignore no-explicit-any
      node = (node as any)[UI];
    }

    // After following [UI] chain, node may have become a primitive
    if (typeof node === "string" || typeof node === "number") {
      return this.#createTextNode(ctx, String(node), policy);
    }
    if (node === null || node === undefined || typeof node === "boolean") {
      return null;
    }
    if (Array.isArray(node)) {
      return this.#renderArrayAsFragment(
        ctx,
        node as WorkerRenderNode[],
        visited,
        policy,
      );
    }

    // Handle Cell<VNode> - this path should be unreachable in practice
    // since Cell children go through renderChild → renderCellChild
    if (isCell(node)) {
      throw new Error(
        "Unexpected Cell in renderNode - this code path was thought to be unreachable. " +
          "Please report this issue.",
      );
    }

    // Now node must be an object (WorkerVNode)
    if (typeof node !== "object") {
      return null;
    }

    // Check for cycles
    if (visited.has(node as object)) {
      return this.#createCyclePlaceholder(ctx, policy);
    }
    visited.add(node as object);

    // Sanitize node
    const sanitized = this.#sanitizeNode(node as WorkerVNode);
    if (!sanitized) {
      return null;
    }

    // Create element. Stamp the producing cell's space when it differs
    // from the nearest ancestor element that carried one — descendants
    // inherit, so transcluded subtrees re-stamp at their boundary.
    const stampSpace = ctx.space !== undefined &&
        ctx.space !== ctx.emittedSpace
      ? ctx.space
      : undefined;
    const nodeId = ctx.nextNodeId();
    this.#queueOps([{
      op: "create-element",
      nodeId,
      tagName: sanitized.name,
      ...(stampSpace !== undefined ? { space: stampSpace } : {}),
    }]);
    if (stampSpace !== undefined) {
      ctx = { ...ctx, emittedSpace: stampSpace };
    }
    const childPolicy = this.#childRenderPolicyForNode(
      sanitized,
      policy,
      nodeId,
    );

    // Create state
    const state: NodeState = {
      nodeId,
      tagName: sanitized.name,
      cancel,
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: [],
      renderPolicy: policy,
      childRenderPolicy: childPolicy,
      // Set from `activePolicyChildren` below, once binding props has had its
      // chance to resolve a boundary policy prop into `childRenderPolicy`.
      childrenBlockedByPolicy: false,
      sourceChildren: sanitized.children,
      sourceProps: sanitized.props,
      // `ctx` carries the stamp this node just emitted, if it emitted one, so
      // this is what its descendants inherit.
      childEmittedSpace: ctx.emittedSpace,
    };
    addCancel(() => this.#cleanupNodeHandlers(state));
    addCancel(() => this.#cancelNodeSubscriptions(state));
    this.#initializeTextIntegrityBoundary(childPolicy, nodeId);

    // Bind props. Cell<Props> can synchronously resolve boundary policy props;
    // bind children from the current state policy after props are bound.
    this.#bindProps(ctx, state, sanitized.props);

    // Bind children
    const activePolicyChildren = this.#childrenForRenderPolicy(
      sanitized,
      state.childRenderPolicy,
    );
    this.#setChildrenBlocked(
      state,
      activePolicyChildren,
      state.childRenderPolicy,
    );
    if (activePolicyChildren.children !== undefined) {
      this.#bindChildren(
        ctx,
        state,
        activePolicyChildren.children,
        visited,
        state.childRenderPolicy,
      );
    }

    return state;
  }

  /**
   * Create a placeholder for circular references.
   */
  #createCyclePlaceholder(
    ctx: ReconcileContext,
    policy: RenderPolicy = DEFAULT_RENDER_POLICY,
  ): NodeState {
    const nodeId = ctx.nextNodeId();
    this.#queueOps([
      { op: "create-element", nodeId, tagName: "span" },
      { op: "set-prop", nodeId, key: "textContent", value: "\uD83D\uDD04" }, // 🔄
      {
        op: "set-prop",
        nodeId,
        key: "title",
        value: "Circular reference detected",
      },
    ]);

    return {
      nodeId,
      tagName: "span",
      cancel: () => {},
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: [],
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
    };
  }

  #createBlockedPlaceholder(
    ctx: ReconcileContext,
    policy: RenderPolicy,
    reason: "policy" | "integrity" | "access" = "policy",
  ): NodeState {
    if (reason === "access") {
      return this.#renderNode(
        ctx,
        this.#accessPlaceholderVNode(),
        new Set(),
        policy,
      )!;
    }
    const nodeId = ctx.nextNodeId();
    const textId = ctx.nextNodeId();
    const integrityBlocked = reason === "integrity";
    const text = integrityBlocked
      ? CFC_TEXT_INTEGRITY_PLACEHOLDER
      : "Content hidden by policy";
    if (integrityBlocked) {
      this.#markTextIntegrityBlocked(policy);
    }
    this.#queueOps([
      { op: "create-element", nodeId, tagName: CFC_BLOCKED_PLACEHOLDER_TAG },
      { op: "set-prop", nodeId, key: "data-cfc-blocked", value: "true" },
      {
        op: "set-prop",
        nodeId,
        key: "data-cfc-blocked-reason",
        value: reason,
      },
      {
        op: "set-prop",
        nodeId,
        key: "title",
        value: integrityBlocked
          ? "CFC text integrity policy blocked this content"
          : "CFC render policy blocked this content",
      },
      { op: "create-text", nodeId: textId, text },
      {
        op: "insert-child",
        parentId: nodeId,
        childId: textId,
        beforeId: null,
      },
    ]);

    return {
      nodeId,
      tagName: CFC_BLOCKED_PLACEHOLDER_TAG,
      cancel: () => {},
      children: new Map([[
        "__blocked_text__",
        {
          nodeId: textId,
          isText: true,
          cancel: () => {},
          currentValue: text,
        },
      ]]),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: ["__blocked_text__"],
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
      textIntegrityBlockedFor: integrityBlocked
        ? policy.textIntegrity?.boundaryNodeIds
        : undefined,
    };
  }

  /**
   * Create a text node.
   */
  #createTextNode(
    ctx: ReconcileContext,
    text: string,
    policy: RenderPolicy = DEFAULT_RENDER_POLICY,
    options?: { trustedText?: boolean },
  ): NodeState {
    if (!options?.trustedText && this.#shouldBlockLiteralText(text, policy)) {
      this.#denyLiteralText(policy);
      return this.#createBlockedPlaceholder(ctx, policy, "integrity");
    }

    const nodeId = ctx.nextNodeId();
    this.#queueOps([{ op: "create-text", nodeId, text }]);

    return {
      nodeId,
      tagName: "#text",
      cancel: () => {},
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: [],
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
    };
  }

  /**
   * Render an array of nodes as a fragment wrapper.
   */
  #renderArrayAsFragment(
    ctx: ReconcileContext,
    nodes: WorkerRenderNode[],
    visited: Set<object>,
    policy: RenderPolicy,
  ): NodeState | null {
    const nodeId = ctx.nextNodeId();
    this.#queueOps([
      { op: "create-element", nodeId, tagName: "cf-fragment" },
    ]);

    const [cancel, addCancel] = useCancelGroup();

    const state: NodeState = {
      nodeId,
      tagName: "cf-fragment",
      cancel,
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: [],
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
    };
    addCancel(() => this.#cleanupNodeHandlers(state));
    addCancel(() => this.#cancelNodeSubscriptions(state));

    // Array items use the same Cell-aware child path as VNode children.
    // rendererVDOMSchema projects array items as Cells, including at the root,
    // so handing them directly to renderNode would violate its invariant that
    // Cell children have already passed through renderCellChild.
    this.#bindChildren(ctx, state, nodes, visited, policy);

    return state;
  }

  /**
   * Sanitize a VNode, ensuring it has valid structure.
   */
  #sanitizeNode(node: WorkerVNode): WorkerVNode | null {
    if (node.type !== "vnode" || node.name === "script") {
      return null;
    }

    // Fragments appear as VNodes with no name property
    let result = node;
    if (!result.name) {
      result = { ...result, name: "cf-fragment" };
    }

    // Ensure props is an object or Cell
    if (
      !isCell(result.props) &&
      !isObjectOrArray(result.props)
    ) {
      result = { ...result, props: {} };
    }

    // Ensure children is an array or Cell
    if (!isCell(result.children) && !Array.isArray(result.children)) {
      result = { ...result, children: [] };
    }

    return result;
  }

  /**
   * Cancels the node's current subscriptions and descendants, including those
   * installed by in-place reconciliation.
   */
  #cancelNodeSubscriptions(state: NodeState): void {
    const [cancel, addCancel] = useCancelGroup();
    for (const propState of state.propSubscriptions.values()) {
      addCancel(propState.cancel);
    }
    addCancel(state.childrenState?.cancel);
    for (const childState of state.children.values()) {
      addCancel(childState.cancel);
    }
    state.propSubscriptions.clear();
    state.childrenState = undefined;
    state.children.clear();
    state.childOrder = [];
    cancel();
  }

  /**
   * Bind props to an element, handling reactive values and events.
   * Tracks Cell references in propSubscriptions for later diffing.
   */
  #bindProps(
    ctx: ReconcileContext,
    state: NodeState,
    props: WorkerProps | Cell<WorkerProps> | null | undefined,
  ): void {
    if (!props) return;

    // Handle Cell<Props>
    if (isCell(props)) {
      this.#bindCellProps(
        ctx,
        state,
        props as Cell<WorkerProps>,
      );
      return;
    }

    // Handle static props
    if (typeof props !== "object") {
      return;
    }

    for (const [key, value] of Object.entries(props)) {
      if (isEventProp(key)) {
        const eventType = getEventType(key);

        // Handle Streams (actions) - wrap in a handler that calls .send()
        if (isStream(value)) {
          const stream = value as Stream<unknown>;
          const handlerId = this.#registerHandler(ctx, (event) => {
            stream.withTx(undefined).send(event);
          }, stream.asSchema({}));
          state.eventHandlers.set(eventType, handlerId);
          this.#queueOps([{
            op: "set-event",
            nodeId: state.nodeId,
            eventType,
            handlerId,
          }]);
          state.propSubscriptions.set(key, {
            cell: undefined,
            cancel: () => {},
            currentValue: value,
          });
        } else if (isEventHandler(value)) {
          // Plain function event handler
          const handlerId = this.#registerHandler(ctx, value);
          state.eventHandlers.set(eventType, handlerId);
          this.#queueOps([{
            op: "set-event",
            nodeId: state.nodeId,
            eventType,
            handlerId,
          }]);
          state.propSubscriptions.set(key, {
            cell: undefined,
            cancel: () => {},
            currentValue: value,
          });
        } else if (isCell(value)) {
          // Cell containing event handler - not common but handle it
          const eventType = getEventType(key);
          const sinkCancel = this.#sinkCell(
            value as Cell<(event: unknown) => void>,
            (handler) => {
              if (this.#retireEventHandler(state, eventType) !== undefined) {
                this.#queueOps([{
                  op: "remove-event",
                  nodeId: state.nodeId,
                  eventType,
                }]);
              }

              if (handler) {
                // Cast handler to mutable function type for registration
                const handlerId = this.#registerHandler(
                  ctx,
                  handler as (event: unknown) => void,
                  value as Cell<unknown>,
                );
                state.eventHandlers.set(eventType, handlerId);
                this.#queueOps([{
                  op: "set-event",
                  nodeId: state.nodeId,
                  eventType,
                  handlerId,
                }]);
              }
            },
          );
          state.propSubscriptions.set(key, {
            cell: value as Cell<unknown>,
            cancel: sinkCancel,
            currentValue: value,
          });
        }
      } else if (isBindingProp(key)) {
        // Bidirectional binding ($prop)
        const propName = getBindingPropName(key);
        if (isCell(value)) {
          this.#queueOps(
            this.#bindingOpsForCell(state, propName, value as Cell<unknown>),
          );
          state.propSubscriptions.set(key, {
            cell: value as Cell<unknown>,
            cancel: () => {},
          });
        }
      } else if (isCell(value)) {
        // Reactive prop value
        const sinkCancel = this.#sinkPropValue(value as Cell<unknown>, (
          resolvedValue,
        ) => {
          const propValue = this.#transformPropValueForState(
            state,
            key,
            resolvedValue,
            value as Cell<unknown>,
          );
          this.#queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
          if (this.#isTextIntegrityPolicyProp(key)) {
            this.#refreshTextIntegrityBoundary(ctx, state);
          }
        });
        state.propSubscriptions.set(key, {
          cell: value as Cell<unknown>,
          cancel: sinkCancel,
        });
      } else {
        // Static prop value
        const propValue = this.#transformPropValueForState(state, key, value);
        this.#queueOps([{
          op: "set-prop",
          nodeId: state.nodeId,
          key,
          value: propValue,
        }]);
        // Record the bound value so a later in-place update can skip the
        // redundant set-prop op when it is unchanged (CT-1798).
        state.propSubscriptions.set(key, {
          cell: undefined,
          cancel: () => {},
          currentValue: value,
        });
      }
    }
  }

  /**
   * Transforms a prop value into the form the connection carries, a `style`
   * given as an object becoming a CSS string on the way.
   */
  // deno-lint-ignore no-explicit-any
  #transformPropValue(key: string, value: unknown): any {
    // TODO(danfuzz): the `typeof` gate admits a `FabricSpecialObject`, so a
    // fabric-valued `style` prop is routed into the `Object.entries` walk of
    // `styleObjectToCssString` — yielding an empty CSS string, silently —
    // before it can reach `convertCellsToLinks` below, the one conversion
    // here that knows the fabric types.
    if (
      key === "style" && value && typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return this.#styleObjectToCssString(value as Record<string, unknown>);
    }
    // Use convertCellsToLinks to handle Cells, circular refs, and non-JSON values.
    // Pass doNotConvertCellResults to prevent already-resolved values (from .sink())
    // from being converted back to links - we want the actual data for props.
    //
    // A prop is whatever a pattern put on a render node, which is `unknown` at
    // this seam and a `CellLinkInput` in fact; the conversion rejects what is
    // neither fabric nor convertible.
    return convertCellsToLinks(value as CellLinkInput, {
      doNotConvertCellResults: true,
      includeSchema: true,
      keepAsCell: KeepAsCell.OnlyStream,
    });
  }

  /**
   * Convert a style object to a CSS string.
   */
  #styleObjectToCssString(styleObject: Record<string, unknown>): string {
    const unitlessProperties = new Set([
      "animation-iteration-count",
      "column-count",
      "fill-opacity",
      "flex",
      "flex-grow",
      "flex-shrink",
      "font-weight",
      "line-height",
      "opacity",
      "order",
      "orphans",
      "stroke-opacity",
      "widows",
      "z-index",
      "zoom",
    ]);

    return Object.entries(styleObject)
      .map(([key, value]) => {
        if (value == null) return "";

        let cssKey = key;
        if (!key.startsWith("--")) {
          if (/^(webkit|moz|ms|o)[A-Z]/.test(key)) {
            cssKey = "-" + key;
          }
          cssKey = cssKey.replace(/([A-Z])/g, "-$1").toLowerCase();
        }

        let cssValue = value;
        if (
          typeof value === "number" &&
          !cssKey.startsWith("--") &&
          !unitlessProperties.has(cssKey) &&
          value !== 0
        ) {
          cssValue = `${value}px`;
        } else {
          cssValue = String(value);
        }

        return `${cssKey}: ${cssValue}`;
      })
      .filter((s) => s !== "")
      .join("; ");
  }

  /**
   * Bind children to an element with keyed reconciliation.
   * Tracks the children Cell for later diffing.
   */
  #bindChildren(
    ctx: ReconcileContext,
    state: NodeState,
    children: WorkerRenderNode | WorkerRenderNode[],
    visited: Set<object>,
    policy: RenderPolicy,
  ): void {
    // Handle Cell<children>
    if (isCell(children)) {
      const sinkCancel = this.#sinkCell(
        children as Cell<WorkerRenderNode | WorkerRenderNode[]>,
        (resolvedChildren) => {
          this.#updateChildren(ctx, state, resolvedChildren, visited, policy);
        },
      );
      // Track the children Cell for diffing
      state.childrenState = {
        cell: children as Cell<unknown>,
        cancel: sinkCancel,
      };
    } else {
      // Static children
      this.#updateChildren(ctx, state, children, visited, policy);
      state.childrenState = undefined;
    }
  }

  /**
   * Find the nodeId of the next sibling after the given key.
   * Used for position-aware insertion of reactive children.
   */
  #findNextSiblingId(
    children: Map<string, ChildNodeState>,
    afterKey: string,
  ): number | null {
    const entries = Array.from(children.entries());
    const myIndex = entries.findIndex(([key]) => key === afterKey);
    if (myIndex === -1) return null;

    // Look for next sibling with valid nodeId
    for (let i = myIndex + 1; i < entries.length; i++) {
      const [, sibling] = entries[i];
      if (sibling.nodeId !== -1) return sibling.nodeId;
    }
    return null;
  }

  /**
   * Update children with keyed reconciliation.
   */
  #updateChildren(
    ctx: ReconcileContext,
    state: NodeState,
    childrenValue:
      | WorkerRenderNode
      | WorkerRenderNode[]
      | Readonly<WorkerRenderNode | WorkerRenderNode[]>
      | null
      | undefined,
    visited: Set<object>,
    policy: RenderPolicy,
    forceReplace = false,
  ): void {
    // Normalize to array
    const newChildren = Array.isArray(childrenValue)
      ? childrenValue
      : (childrenValue === null || childrenValue === undefined)
      ? []
      : [childrenValue];

    // Generate keys for new children
    const newKeys = generateChildKeys(newChildren);
    const newMapping = new Map<string, ChildNodeState>();
    const newKeyOrder: string[] = [];

    // Where each key sat in the old order, to tell a child that merely stayed
    // put from one that has to move.
    const previousPosition = new Map<string, number>();
    for (let i = 0; i < state.childOrder.length; i++) {
      previousPosition.set(state.childOrder[i], i);
    }
    const keptInPlace = new Set<string>();

    // Process each new child
    let hasNewChildren = false;
    for (let i = 0; i < newChildren.length; i++) {
      const child = newChildren[i];
      const key = newKeys[i];
      newKeyOrder.push(key);

      if (!forceReplace && state.children.has(key)) {
        // Reuse existing child
        const existingState = state.children.get(key)!;
        const canReuse = this.#reconcileReusedChild(
          ctx,
          existingState,
          child,
          visited,
          policy,
        );
        state.children.delete(key);
        if (canReuse) {
          newMapping.set(key, existingState);
          keptInPlace.add(key);
        } else {
          existingState.cancel();
          this.#cleanupNodeHandlers(existingState);
          this.#queueOps([{ op: "remove-node", nodeId: existingState.nodeId }]);
          hasNewChildren = true;
          const childState = this.#renderChild(
            ctx,
            child,
            visited,
            state,
            key,
            policy,
          );
          if (childState) {
            newMapping.set(key, childState);
          }
        }
      } else {
        // Create new child, passing parent state and key for position tracking
        hasNewChildren = true;
        const childState = this.#renderChild(
          ctx,
          child,
          visited,
          state,
          key,
          policy,
        );
        if (childState) {
          newMapping.set(key, childState);
        }
      }
    }

    // Remove obsolete children
    for (const [_, oldState] of state.children) {
      oldState.cancel();
      this.#cleanupNodeHandlers(oldState);
      this.#queueOps([{ op: "remove-node", nodeId: oldState.nodeId }]);
    }

    // Check if order needs update - only skip inserts when ALL children were
    // reused (no new children created). New children need insert-child ops
    // even if the key order is identical.
    const isOrderSame = !hasNewChildren &&
      newKeyOrder.length === state.childOrder.length &&
      newKeyOrder.every((key, i) => key === state.childOrder[i]);

    if (isOrderSame) {
      // Order is identical and all children were reused from previous state
      state.children = newMapping;
      return;
    }

    state.childOrder = newKeyOrder;

    // The document holds exactly the children that were kept, in the order they
    // had before. A child whose position among those is unchanged is already
    // where it belongs, so the ones forming a longest such run need no op at
    // all; every other child is placed against them below.
    //
    // A child with nodeId === -1 is a Cell child that has not resolved, so the
    // document does not hold it and it cannot anchor anything. It self-inserts
    // through renderCellChild once it resolves.
    const previousPositions = newKeyOrder.map((key) => {
      const childState = newMapping.get(key);
      if (!childState || childState.nodeId === -1) return -1;
      return keptInPlace.has(key) ? previousPosition.get(key) ?? -1 : -1;
    });
    const stationary = stationaryPositions(previousPositions);

    // Walk from END to BEGINNING so each insert names a child already in its
    // final place. A stationary child emits nothing but still anchors the
    // children before it, because it is their next sibling either way.
    let nextNodeId: number | null = null;
    for (let i = newKeyOrder.length - 1; i >= 0; i--) {
      const key = newKeyOrder[i];
      const childState = newMapping.get(key);
      if (!childState || childState.nodeId === -1) continue;

      if (!stationary.has(i)) {
        // Insert this child before the next one (or append if it's the last)
        this.#queueOps([
          {
            op: "insert-child",
            parentId: state.nodeId,
            childId: childState.nodeId,
            beforeId: nextNodeId,
          },
        ]);
      }

      nextNodeId = childState.nodeId;
    }

    // Update state
    state.children = newMapping;
  }

  /**
   * Reconcile a reused keyed child. A stable key preserves DOM identity and
   * ordering, but the VNode payload may still have fresh captured values from a
   * parent recomputation, so same-key reuse cannot blindly skip descendants.
   */
  #reconcileReusedChild(
    ctx: ReconcileContext,
    childState: ChildNodeState,
    child: unknown,
    visited: Set<object>,
    policy: RenderPolicy,
  ): boolean {
    if (isCell(child)) {
      return childState.cell !== undefined &&
        this.#sameCellForReuse(childState.cell, child);
    }

    if (
      childState.isText &&
      childState.cell === undefined &&
      (typeof child === "string" || typeof child === "number" ||
        typeof child === "boolean" || child === null || child === undefined)
    ) {
      // Nothing to update. A text child is keyed by a hash of the very value
      // it renders, so one that was reused under its old key holds the text it
      // was built with; a child whose text differs keys differently and is
      // built rather than reused.
      return true;
    }

    if (!childState.elementState) return false;

    const newVNode = this.#extractVNode(child);
    if (!newVNode) return false;

    const sanitized = this.#sanitizeNode(newVNode);
    if (!sanitized || sanitized.name !== childState.elementState.tagName) {
      return false;
    }

    const childPolicy = this.#childRenderPolicyForNode(
      sanitized,
      policy,
      childState.elementState.nodeId,
    );
    const policyChildren = this.#childrenForRenderPolicy(
      sanitized,
      childPolicy,
    );
    const policyChanged = !this.#renderPolicyEquals(
      childState.elementState.childRenderPolicy,
      childPolicy,
    ) || childState.elementState.childrenBlockedByPolicy !==
        policyChildren.blocked;

    childState.currentValue = child;
    childState.elementState.renderPolicy = policy;
    childState.elementState.childRenderPolicy = childPolicy;
    this.#setChildrenBlocked(
      childState.elementState,
      policyChildren,
      childPolicy,
    );
    // Same reasoning as the keyed path above: an authored node holding this
    // element is not a wrapper, whatever it was before. A key derived from
    // content cannot match an array against a VNode today, so this only holds
    // the invariant for a keying that one day could.
    childState.elementState.isArrayWrapper = false;
    childState.elementState.sourceChildren = sanitized.children;
    childState.elementState.sourceProps = sanitized.props;

    this.#updatePropsInPlace(ctx, childState.elementState, sanitized.props);

    if (policyChildren.children !== undefined) {
      const childrenSame = this.#areChildrenSame(
        childState.elementState,
        policyChildren.children,
      );
      this.#updateChildrenInPlace(
        ctx,
        childState.elementState,
        policyChildren.children,
        new Set(visited),
        childPolicy,
        policyChanged,
      );
      if (!childrenSame || policyChanged) {
        this.#refreshTextIntegrityBoundaryState(
          childState.elementState,
          childPolicy,
        );
      }
    }
    return true;
  }

  #sameCellForReuse(left: Cell<unknown>, right: Cell<unknown>): boolean {
    try {
      return areLinksSame(left, right);
    } catch {
      return left === right;
    }
  }

  /**
   * Render a child node (which may be a VNode, text, or Cell).
   * For Cell children, uses position-aware insertion instead of wrapper elements.
   */
  #renderChild(
    ctx: ReconcileContext,
    child: unknown,
    visited: Set<object>,
    parentState: NodeState,
    childKey: string,
    policy: RenderPolicy,
  ): ChildNodeState | null {
    // Handle Cell children - no wrapper, track position dynamically
    if (isCell(child)) {
      return this.#renderCellChild(
        ctx,
        child as Cell<unknown>,
        visited,
        parentState,
        childKey,
        policy,
      );
    }

    // Handle non-Cell content
    return this.#renderChildContent(ctx, child, visited, policy);
  }

  /**
   * Render a Cell child with position-aware updates (no wrapper element).
   */
  #renderCellChild(
    ctx: ReconcileContext,
    cell: Cell<unknown>,
    visited: Set<object>,
    parentState: NodeState,
    childKey: string,
    policy: RenderPolicy,
  ): ChildNodeState {
    // A followed cell is a (potential) transclusion boundary: its
    // subtree renders in the CELL's space, not the surrounding one.
    const cellSpace = this.#spaceOfCell(cell);
    if (cellSpace !== undefined && cellSpace !== ctx.space) {
      ctx = { ...ctx, space: cellSpace };
    }
    const [cancel, addCancel] = useCancelGroup();

    // Create child state that will track the current node
    // nodeId will be set synchronously when sink fires
    const childState: ChildNodeState = {
      nodeId: -1,
      isText: false,
      cancel,
      cell,
      hasPieceBoundary: false,
    };

    let currentCancel: Cancel | undefined;
    let currentContentState:
      | "rendered"
      | "policy-blocked"
      | "integrity-blocked"
      | undefined;

    // §4.9.3 Stage 2: on each render, watch the ACL docs of the spaces this
    // cell is labeled with, so a fail-closed over-block upgrades to an admit
    // when a `Space(X)` ACL syncs in (and a revoke re-blocks) — a re-evaluation
    // with the last resolved value, forced past the value-identity dedupe.
    const watchedDocs = new Set<string>();

    const renderResolved = (resolvedChild: unknown, forced = false) => {
      const isInitialRender = childState.nodeId === -1;
      const resultCell = this.#resolveCellForBinding(cell);
      const valueUnchanged = Object.is(
        resolvedChild,
        childState.currentValue,
      );
      childState.currentValue = resolvedChild;
      this.#watchCellMembership(
        cell,
        watchedDocs,
        addCancel,
        () => renderResolved(childState.currentValue, true),
      );
      const accessLost = this.#cellAccessError(cell) !== undefined;
      const blockedByPolicy = accessLost ||
        !this.#canRenderCellUnderPolicy(cell, policy);
      const blockedByIntegrity = !blockedByPolicy &&
        this.#shouldBlockTextFromCell(resolvedChild, cell, policy);

      if (
        !forced && !isInitialRender && valueUnchanged
      ) {
        if (blockedByPolicy && currentContentState === "policy-blocked") {
          return;
        }
        if (
          blockedByIntegrity && currentContentState === "integrity-blocked"
        ) {
          return;
        }
        if (
          !blockedByPolicy && !blockedByIntegrity &&
          currentContentState === "rendered"
        ) {
          this.#updatePieceBoundary(childState, resolvedChild, resultCell);
          return;
        }
      }

      if (blockedByPolicy) {
        if (!accessLost) this.#denyCellRender(cell, policy);
        if (!isInitialRender) {
          if (currentCancel) {
            currentCancel();
            currentCancel = undefined;
          }
          this.#cleanupNodeHandlers(childState);
          this.#queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
        }

        childState.nodeId = -1;
        childState.elementState = undefined;
        childState.isText = false;
        childState.hasPieceBoundary = false;

        const blockedState = this.#createBlockedPlaceholder(
          ctx,
          policy,
          accessLost ? "access" : "policy",
        );
        childState.nodeId = blockedState.nodeId;
        childState.elementState = blockedState;
        childState.isText = false;
        currentCancel = blockedState.cancel;
        currentContentState = "policy-blocked";

        const beforeId = this.#findNextSiblingId(
          parentState.children,
          childKey,
        );
        this.#queueOps([{
          op: "insert-child",
          parentId: parentState.nodeId,
          childId: blockedState.nodeId,
          beforeId,
        }]);
        return;
      }

      if (blockedByIntegrity) {
        this.#denyCellText(cell, policy);
        if (!isInitialRender) {
          if (currentCancel) {
            currentCancel();
            currentCancel = undefined;
          }
          this.#cleanupNodeHandlers(childState);
          this.#queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
        }

        childState.nodeId = -1;
        childState.elementState = undefined;
        childState.isText = false;
        childState.hasPieceBoundary = false;

        const blockedState = this.#createBlockedPlaceholder(
          ctx,
          policy,
          "integrity",
        );
        childState.nodeId = blockedState.nodeId;
        childState.elementState = blockedState;
        childState.isText = false;
        currentCancel = blockedState.cancel;
        currentContentState = "integrity-blocked";

        const beforeId = this.#findNextSiblingId(
          parentState.children,
          childKey,
        );
        this.#queueOps([{
          op: "insert-child",
          parentId: parentState.nodeId,
          childId: blockedState.nodeId,
          beforeId,
        }]);
        return;
      }

      // Try to update in place if not initial render
      if (
        !isInitialRender &&
        childState.nodeId !== -1
      ) {
        // Case 1: Text update
        if (
          childState.isText &&
          (typeof resolvedChild === "string" ||
            typeof resolvedChild === "number")
        ) {
          this.#queueOps([{
            op: "update-text",
            nodeId: childState.nodeId,
            text: String(resolvedChild),
          }]);
          return;
        }

        // Case 2: VNode in-place update (same tag)
        if (
          childState.elementState && currentContentState === "rendered"
        ) {
          const newVNode = this.#extractVNode(
            resolvedChild as WorkerRenderNode,
          );
          if (newVNode) {
            const sanitized = this.#sanitizeNode(newVNode);
            if (
              sanitized &&
              sanitized.name === childState.elementState.tagName
            ) {
              const childPolicy = this.#childRenderPolicyForNode(
                sanitized,
                policy,
                childState.elementState.nodeId,
              );
              const policyChildren = this.#childrenForRenderPolicy(
                sanitized,
                childPolicy,
              );
              const policyChanged = !this.#renderPolicyEquals(
                childState.elementState.childRenderPolicy,
                childPolicy,
              ) ||
                childState.elementState.childrenBlockedByPolicy !==
                  policyChildren.blocked;
              childState.elementState.renderPolicy = policy;
              childState.elementState.childRenderPolicy = childPolicy;
              this.#setChildrenBlocked(
                childState.elementState,
                policyChildren,
                childPolicy,
              );
              childState.elementState.sourceChildren = sanitized.children;
              childState.elementState.sourceProps = sanitized.props;
              // Taking over a wrapper for an authored node of the same tag is
              // sound -- the props below replace the wrapper's own -- but the
              // node stops being a wrapper, and a later array must not adopt
              // the authored props it now carries.
              childState.elementState.isArrayWrapper = false;
              this.#updatePieceBoundary(childState, resolvedChild, resultCell);
              // Same tag - update props in place
              this.#updatePropsInPlace(
                ctx,
                childState.elementState,
                sanitized.props,
              );

              if (policyChildren.children !== undefined) {
                const childrenSame = this.#areChildrenSame(
                  childState.elementState,
                  policyChildren.children,
                );
                this.#updateChildrenInPlace(
                  ctx,
                  childState.elementState,
                  policyChildren.children,
                  new Set(),
                  childPolicy,
                  policyChanged,
                );
                if (!childrenSame || policyChanged) {
                  this.#refreshTextIntegrityBoundaryState(
                    childState.elementState,
                    childPolicy,
                  );
                }
              }
              return;
            }
          }
        }

        // Case 3: array in-place update (same wrapper). A mapped list resolves
        // to an array rather than to a VNode, so Case 2 never sees it. Keeping
        // the wrapper hands the array to the keyed reconciler, which reuses
        // every row whose key is unchanged; replacing it instead rebuilds the
        // whole list for a one-row change.
        //
        // Only a wrapper qualifies, and only while it holds rendered content
        // rather than a placeholder. The reconciler synthesizes it with fixed
        // props, so nothing about it can change but its children, and the child
        // policy it stored still holds -- it carries no policy-bearing props to
        // derive a new one from.
        //
        // An array cannot be a nested pattern's output, which is an object
        // carrying `UI`, so reaching here leaves no piece boundary to update.
        if (
          Array.isArray(resolvedChild) &&
          childState.elementState?.isArrayWrapper &&
          currentContentState === "rendered"
        ) {
          const wrapper = childState.elementState;
          const children = resolvedChild as WorkerRenderNode[];
          wrapper.sourceChildren = children;
          this.#updateChildrenInPlace(
            // Rows render below the wrapper, so they inherit the space it
            // stamped; handing them the surrounding ctx would have each row
            // re-stamp a space the wrapper already carries.
            { ...ctx, emittedSpace: wrapper.childEmittedSpace },
            wrapper,
            children,
            new Set(visited),
            wrapper.childRenderPolicy,
          );
          return;
        }
      }

      // Fallback: Replace (existing logic)
      // Clean up previous (skip if initial render - nothing to clean)
      if (!isInitialRender) {
        if (currentCancel) {
          currentCancel();
          currentCancel = undefined;
        }
        // Clean up event handlers before removing node
        this.#cleanupNodeHandlers(childState);
        // Log replacement
        logger.debug(
          "reconcile-cell-child",
          () => ({
            id: childState.nodeId,
            cellId: this.#getCellDebugId(cell),
            type: "replace",
            reason: "fallback",
          }),
        );
        this.#queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
      }

      // Reset nodeId
      childState.nodeId = -1;
      childState.elementState = undefined;
      childState.isText = false;
      childState.hasPieceBoundary = false;
      currentContentState = undefined;

      if (resolvedChild === null || resolvedChild === undefined) {
        return;
      }

      // Render new content. Primitive text from a Cell has already passed
      // source-cell text integrity verification above, so do not reclassify
      // it as an untrusted literal.
      const newState = this.#hasVisibleTextValue(resolvedChild) &&
          (typeof resolvedChild === "string" ||
            typeof resolvedChild === "number" ||
            typeof resolvedChild === "boolean")
        ? {
          nodeId: this.#createTextNode(
            ctx,
            this.#stringifyText(resolvedChild),
            policy,
            { trustedText: true },
          ).nodeId,
          isText: true,
          cancel: () => {},
        }
        : this.#renderChildContent(
          ctx,
          resolvedChild,
          new Set(visited),
          policy,
        );
      if (newState) {
        childState.nodeId = newState.nodeId;
        childState.elementState = newState.elementState;
        childState.isText = newState.isText;
        currentCancel = newState.cancel;
        currentContentState = "rendered";
        this.#updatePieceBoundary(childState, resolvedChild, resultCell);

        // Always insert the child into its parent. On initial render,
        // updateChildren also emits insert-child but may see nodeId=-1
        // (Cell hasn't resolved yet), making that op a no-op. This
        // ensures the node is inserted once it actually exists.
        // Double inserts are harmless (DOM appendChild/insertBefore is idempotent).
        const beforeId = this.#findNextSiblingId(
          parentState.children,
          childKey,
        );
        this.#queueOps([
          {
            op: "insert-child",
            parentId: parentState.nodeId,
            childId: newState.nodeId,
            beforeId,
          },
        ]);
      }
    };

    addCancel(
      this.#sinkCell(cell, (resolvedChild) => renderResolved(resolvedChild)),
    );

    // When the cancel group fires (parent teardown), also cancel the current
    // rendered content. Without this, deeper sinks (e.g. children/props of the
    // rendered content) leak because currentCancel is only called on re-fire
    // inside the sink callback, not on teardown.
    addCancel(() => {
      if (currentCancel) {
        currentCancel();
        currentCancel = undefined;
      }
    });

    return childState;
  }

  /**
   * Render non-Cell child content (VNode, array, text, etc).
   */
  #renderChildContent(
    ctx: ReconcileContext,
    child: unknown,
    visited: Set<object>,
    policy: RenderPolicy,
  ): ChildNodeState | null {
    // Handle arrays - wrap in a span with display:contents
    if (Array.isArray(child)) {
      const wrapperVNode: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: { style: "display:contents" },
        children: child,
      };
      const state = this.#renderNode(
        ctx,
        wrapperVNode,
        new Set(visited),
        policy,
      );
      if (!state) return null;
      state.isArrayWrapper = true;

      return {
        nodeId: state.nodeId,
        isText: false,
        cancel: state.cancel,
        elementState: state,
      };
    }

    // Handle VNode
    if (isWorkerVNode(child)) {
      const state = this.#renderNode(ctx, child, new Set(visited), policy);
      if (!state) return null;

      return {
        nodeId: state.nodeId,
        isText: false,
        cancel: state.cancel,
        elementState: state,
      };
    }

    // Handle objects with [UI] property (pattern outputs)
    // deno-lint-ignore no-explicit-any
    if (
      child && typeof child === "object" && UI in child && (child as any)[UI]
    ) {
      const state = this.#renderNode(
        ctx,
        child as WorkerRenderNode,
        new Set(visited),
        policy,
      );
      if (!state) return null;

      return {
        nodeId: state.nodeId,
        isText: false,
        cancel: state.cancel,
        elementState: state,
      };
    }

    // Cell<Cell<X>> shouldn't happen - Cell chains are resolved by runtime.
    // If we hit this, it's likely a bug - throw to surface it.
    if (isCell(child)) {
      throw new Error(
        "Unexpected Cell in renderChildContent - Cell chains should be resolved by runtime. " +
          "Please report this issue.",
      );
    }

    // Handle primitive values (text nodes)
    const text = this.#stringifyText(child);
    const state = this.#createTextNode(ctx, text, policy);
    const isText = state.tagName === "#text";

    return {
      nodeId: state.nodeId,
      isText,
      cancel: state.cancel,
      elementState: isText ? undefined : state,
    };
  }

  /**
   * Convert a primitive value to text content.
   */
  #stringifyText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    } else if (value === null || value === undefined || value === false) {
      return "";
    } else if (typeof value === "object") {
      // Objects are not expected here - warn and render their JSON as a fallback
      //
      // TODO(danfuzz): this is an unsafe use of `stringify()`: a
      // `FabricSpecialObject` child (a `FabricEpochNsec` timestamp placed in
      // `children`, say) renders as the literal text `{}` — the warn fires
      // but nothing throws. Wants a `FabricSpecialObject` test ahead of this
      // point, rendered via `toCompactDebugString()` from
      // `@commonfabric/data-model` (or the primitive's own
      // string form).
      console.warn("unexpected object when value was expected", value);
      return JSON.stringify(value);
    }
    return String(value);
  }
}

/**
 * Create a new reconciler instance.
 */
export function createReconciler(
  options: WorkerReconcilerOptions,
): WorkerReconciler {
  return new WorkerReconciler(options);
}
