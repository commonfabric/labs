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
  cellRuntime,
  CFC_ATOM_TYPE,
  convertCellsToLinks,
  hostValueOf,
  isCell,
  isStream,
  type JSONSchema,
  KeepAsCell,
  parseLink,
  type SinkConsumedLabel,
  sinkProjected,
  type Stream,
  UI,
  useCancelGroup,
} from "@commonfabric/runner";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import { MATERIAL_RISK_DISCHARGE_KINDS } from "@commonfabric/runner/cfc/prompt-caveat-kinds";
import {
  componentReadContracts,
  componentReadSchema,
  type NestedRenderPath,
  NestedRenderReferenceSchema,
} from "@commonfabric/runner/component-read-contract";
import { authorPrincipalCandidates } from "@commonfabric/runner/cfc/represents-principal";
import {
  type CfcLabelView,
  cfcLabelViewForCell,
  cfcLabelViewForResolvedTarget,
  cfcLabelViewSourceForCell,
  clauseAlternatives,
  markRendererTrustedEvent,
  reportCfcDenial,
} from "@commonfabric/runner/cfc";
import type { CellRef } from "@commonfabric/runtime-client";
import { isUnavailable } from "@commonfabric/data-model/availability";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  CFC_POLICY_PLACEHOLDER_TEXT,
  getBindingPropName,
  getEventType,
  isBindingProp,
  isEventHandler,
  isEventProp,
} from "../render-utils.ts";
import { PENDING_RENDER_ATTRIBUTE } from "../pending-render.ts";
import { CONTAINER_NODE_ID, type VDomOp } from "../vdom-ops.ts";
import {
  admitsEverything,
  atomRenderableUnderPolicy,
  canRenderCellUnderPolicy,
  cellLabelRefusal,
  cellLabelSources,
  confidentialityLabels,
  confidentialityLabelsFromCellSchema,
  type DisplayFitSources,
  type FitWatch,
  integrityLabels,
  normalizeAtomBound,
  readRefusal,
  type RenderLabelSummary,
  rootRenderPolicyFor,
} from "./display-fit.ts";
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
/**
 * `$` bindings a trusted host component never shows a value from. It hands
 * each reference to a worker operation and shows only what that operation
 * answers, so the operation, not the render policy, decides what the
 * component may show; a value it reads through one serves only as a signal
 * to ask again.
 */
const REFERENCE_BINDING_SINKS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    [
      "cf-custody-seal",
      new Set(["draft", "terms", "policy", "sources", "box"]),
    ],
    ["cf-custody-answer", new Set(["terms", "policy", "output"])],
  ]);

/**
 * `$` bindings whose component shows what the binding names only through
 * renders mounted from it, and shows the element's children while it holds no
 * value for the binding. While such a binding is withheld because a space its
 * read reaches is out of reach, the access placeholder is the element's child.
 */
const ACCESS_PLACEHOLDER_BINDINGS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["cf-render", new Set(["cell"])],
    ["cf-picker", new Set(["items"])],
  ]);

/**
 * Props that make the browser load a remote resource once they are set, keyed
 * by tag name in lower case, with `*` for every element. Setting one is
 * network egress, not display, so it is decided under the remote-load policy
 * ({@link WorkerReconciler#remoteLoadPolicyOf}) as well as the render policy.
 * Prop names are compared in lower case, since a DOM property and its
 * attribute differ only in case. `style` and `theme`, on any element, are
 * decided by their value ({@link VALUE_DECIDED_REMOTE_LOAD_PROPS}). A
 * component that loads what a prop names, or renders markup or a nested view
 * that can, is listed by that prop; `test/remote-load-props.test.ts` holds every
 * component that loads anything to this table or to a reason it need not be
 * here. SVG `image` and `use` are absent because the renderer creates elements
 * in the HTML namespace only, where those tags load nothing.
 */
export const REMOTE_LOAD_PROPS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    [
      "*",
      new Set([
        "src",
        "srcset",
        "srcdoc",
        "poster",
        "background",
        "innerhtml",
        "outerhtml",
        "attributionsrc",
      ]),
    ],
    ["object", new Set(["data"])],
    ["link", new Set(["href", "imagesrcset"])],
    ["base", new Set(["href"])],
    ["meta", new Set(["content"])],
    ["style", new Set(["textcontent", "innertext", "outertext"])],
    ["cf-markdown", new Set(["content"])],
    ["cf-svg", new Set(["content"])],
    ["cf-chat", new Set(["messages"])],
    ["cf-chat-message", new Set(["avatar", "content"])],
    ["cf-fab", new Set(["previewmessage", "messages"])],
    ["cf-link-preview", new Set(["url"])],
    ["cf-cfc-authorship", new Set(["avatar"])],
    ["cf-oauth", new Set(["auth"])],
    ["cf-profile-badge", new Set(["profile"])],
    ["cf-render", new Set(["cell"])],
    ["cf-picker", new Set(["items"])],
    // The sandbox admits same-origin images, and a same-origin relay
    // (`/api/link-preview/<url>`) fetches any URL it is given.
    ["cf-iframe", new Set(["context"])],
    // Tiles come from a fixed host, but the viewport the data chooses tells
    // that host where to look.
    ["cf-map", new Set(["value", "center", "zoom", "bounds"])],
  ]);

/**
 * Props, on any element, that load a remote resource only for some values:
 * CSS (`style`), and a theme, whose colors become CSS custom properties that
 * component styles read as `background`.
 */
const VALUE_DECIDED_REMOTE_LOAD_PROPS: ReadonlySet<string> = new Set([
  "style",
  "theme",
]);

/**
 * The caveat kinds the remote-load policy refuses though the display admits
 * them: the material-risk tiers, which the display ceiling admits with the
 * rest of the prompt-caveat family (SC-54). For the default host ceiling,
 * removing them leaves the caveat allowance it had before SC-54.
 */
const REMOTE_LOAD_REFUSED_CAVEAT_KINDS: ReadonlySet<string> = new Set(
  MATERIAL_RISK_DISCHARGE_KINDS,
);

/**
 * A CSS value that could name a URL: a `url()`, an image function, `src()`,
 * an `@import`, a backslash, which can spell any of those as an escape, or a
 * custom property definition, whose value other CSS could read as a URL.
 * Broader than the grammar, so that a value this does not match cannot load
 * anything.
 */
const STYLE_MAY_LOAD_REMOTE =
  /url|image|src\s*\(|@import|\\|(?:^|[;{\s])--[\w-]*\s*:/i;

/**
 * Whether a `style` or `theme` value could make the browser load a URL. An
 * object is decided entry by entry, so a quoted font name, which a JSON
 * rendering would escape, is not mistaken for an escape; a key that defines a
 * custom property counts as one that could.
 */
function valueMayLoadRemote(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return STYLE_MAY_LOAD_REMOTE.test(value);
  if (typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("--") || STYLE_MAY_LOAD_REMOTE.test(key)) return true;
    if (valueMayLoadRemote(entry)) return true;
  }
  return false;
}

/** A prop whose value is not known where it is decided: a binding. */
const UNKNOWN_PROP_VALUE = Symbol("unknown prop value");

/**
 * Why a prop that would fetch a URL was refused: the view it is in carries a
 * caveat the remote-load policy refuses, or its own value does.
 */
type RemoteLoadRefusal =
  | { readonly byView: true }
  | { readonly byView: false; readonly label: RenderLabelSummary };

/**
 * A read a prop's admission rests on: the cell read, and the labels each read
 * of it consumed, as {@link readRefusal} fits them.
 */
type DecidingRead = {
  readonly source: Cell<unknown>;
  readonly reads: readonly (SinkConsumedLabel | undefined)[];
};

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
  /** {@link #remoteLoadPolicyOf}, per policy object. */
  readonly #remoteLoadPolicies = new WeakMap<RenderPolicy, RenderPolicy>();

  /**
   * What this reconciler's display decisions consult beyond the labels: the
   * exchange-rule resolver, which rewrites a label before the ceiling fit and
   * without which the label is fitted by exact match, and the membership
   * provider and module-policy manifest source whose `subscribe()` lets a
   * refused cell re-render when an access list or a manifest its label names
   * syncs or changes (spec §4.9.3). A source left out leaves no reactive
   * upgrade, and the sync snapshot still gates soundly.
   */
  readonly #fitSources: DisplayFitSources;
  readonly #spaceAccess?: WorkerReconcilerOptions["spaceAccess"];

  /**
   * The handlers of the retry controls access placeholders offer, which a
   * refusal does not withhold the way it withholds every other handler.
   */
  readonly #accessRetryHandlers = new WeakSet<(event: unknown) => void>();

  constructor(options: WorkerReconcilerOptions) {
    this.#onOps = options.onOps;
    this.#onError = options.onError;
    this.#fitSources = {
      resolveConfidentiality: options.resolveRenderConfidentiality,
      membership: options.membershipProvider,
      modulePolicies: options.modulePolicySource,
    };
    this.#spaceAccess = options.spaceAccess;
    // Security knob: a present-but-unknown value fails closed to "deny";
    // only an absent option keeps the documented "allow" default.
    this.#renderDeclassificationPolicy = normalizeRenderDeclassificationPolicy(
      options.renderDeclassificationPolicy,
    );
    // Same seam discipline: malformed ceilings normalize to the empty
    // (public-only) ceiling rather than crashing or failing open.
    this.#rootRenderPolicy =
      rootRenderPolicyFor(options.renderConfidentialityCeiling) ??
        DEFAULT_RENDER_POLICY;
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
    /**
     * Mounts as {@link mount} does, with the root's remote loads blocked, as
     * when the mounted data carries a caveat the remote-load policy refuses.
     * Separates the subtree block from the per-read fit, which today refuses
     * most of the same loads on its own.
     */
    mountWithRemoteLoadsBlocked(
      vnode: WorkerVNode | Cell<WorkerVNode> | Cell<unknown>,
    ): Cancel;
  } {
    return {
      rootRenderPolicy: this.#rootRenderPolicy,
      mountWithRemoteLoadsBlocked: (vnode) =>
        this.#mount(vnode, {
          ...this.#rootRenderPolicy,
          remoteLoadsBlocked: true,
        }),
      atomRenderableUnderPolicy: (atom, policy) =>
        atomRenderableUnderPolicy(atom, policy),
      canRenderCellUnderPolicy: (cell, policy) =>
        canRenderCellUnderPolicy(cell, policy, this.#fitSources),
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
    return this.#mount(vnode, this.#rootRenderPolicy);
  }

  /** {@link mount}, under `rootPolicy` rather than the configured root policy. */
  #mount(
    vnode: WorkerVNode | Cell<WorkerVNode> | Cell<unknown>,
    rootPolicy: RenderPolicy,
  ): Cancel {
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
      let rootIsPending = false;
      let rootConsumed: SinkConsumedLabel | undefined;
      const rootWatch: FitWatch = {
        watched: new Set<string>(),
        addCancel,
        reeval: () => renderRoot(lastRootValue),
      };
      const renderRoot = (resolvedVnode: unknown) => {
        logger.debug("root-cell-update", () => ({ resolvedVnode }));
        lastRootValue = resolvedVnode;
        // The mounted cell is an egress like any descendant cell: gate its
        // read against the root policy (the host ceiling when configured)
        // before rendering its resolved content. Checked per update so label
        // changes re-evaluate, mirroring renderCellChild.
        const refusal = readRefusal(
          vnode,
          [rootConsumed],
          rootPolicy,
          this.#fitSources,
          rootWatch,
        );
        const refusedSpace = this.#refusedSpaceOf(vnode);
        if (refusedSpace !== undefined || refusal !== undefined) {
          if (refusedSpace === undefined && refusal !== undefined) {
            this.#reportRenderDenial(() => refusal, rootPolicy);
          }
          this.#reconcileIntoWrapper(
            ctx,
            wrapperState,
            refusedSpace !== undefined
              ? this.#accessPlaceholderVNode(refusedSpace)
              : this.#blockedPlaceholderVNode(),
            rootPolicy,
          );
          this.#rootChildId = wrapperState.currentChild?.nodeId ?? null;
          return;
        }
        // Pending behaves like suspense. Before the first usable value the
        // wrapper remains empty; after one, retain and mark its rendered tree.
        // Other unavailable reasons render no content unless explicitly
        // handled by the authored VDOM. Policy checks deliberately run first.
        if (isUnavailable(resolvedVnode)) {
          if (resolvedVnode.reason === "pending") {
            if (wrapperState.currentChild && !rootIsPending) {
              this.#queuePendingRenderState(
                wrapperState.currentChild.nodeId,
                true,
              );
              rootIsPending = true;
            }
            return;
          }

          rootIsPending = false;
          this.#reconcileIntoWrapper(
            ctx,
            wrapperState,
            undefined,
            this.#rootRenderPolicy,
          );
          this.#rootChildId = null;
          return;
        }
        if (rootIsPending && wrapperState.currentChild) {
          this.#queuePendingRenderState(
            wrapperState.currentChild.nodeId,
            false,
          );
          rootIsPending = false;
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
        // The root's data may be admitted for display yet carry a caveat a
        // URL fetch does not admit; its subtree then sets no prop that would
        // fetch one (SC-56).
        const remoteLoadsBlocked = rootPolicy.remoteLoadsBlocked === true ||
          this.#mayCarryRemoteRefusedCaveat(vnode, [rootConsumed]) &&
            readRefusal(
                vnode,
                [rootConsumed],
                this.#remoteLoadPolicyOf(rootPolicy),
                this.#fitSources,
                rootWatch,
              ) !== undefined;
        this.#reconcileIntoWrapper(
          ctx,
          wrapperState,
          resolvedVnode as WorkerRenderNode,
          remoteLoadsBlocked && !rootPolicy.remoteLoadsBlocked
            ? { ...rootPolicy, remoteLoadsBlocked: true }
            : rootPolicy,
        );
        // Track the root child for cleanup
        this.#rootChildId = wrapperState.currentChild?.nodeId ?? null;
      };

      addCancel(
        this.#sinkCell(vnode, (resolvedVnode: unknown, read) => {
          rootConsumed = read;
          renderRoot(resolvedVnode);
        }, !admitsEverything(rootPolicy)),
      );
    } else {
      // Static VNode - render directly into container
      const state = this.#renderNode(
        ctx,
        vnode,
        new Set(),
        rootPolicy,
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
    for (const op of ops) this.#pendingOps.push(op);
    this.#scheduleFlush();
  }

  #queuePendingRenderState(nodeId: number, pending: boolean): void {
    this.#queueOps([
      pending
        ? {
          op: "set-prop",
          nodeId,
          key: PENDING_RENDER_ATTRIBUTE,
          value: true,
        }
        : {
          op: "remove-prop",
          nodeId,
          key: PENDING_RENDER_ATTRIBUTE,
        },
    ]);
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
    // A style element's text is CSS, which can fetch (`url()`, `@import`),
    // so it is decided under the remote-load policy; in a view whose data a remote load
    // does not admit, `#childrenForRenderPolicy` blocks it outright.
    let policy = node.name.toLowerCase() === "style"
      ? this.#remoteLoadPolicyOf(parentPolicy)
      : parentPolicy;

    if (node.name === CFC_RENDER_BOUNDARY_TAG) {
      const props = this.#propsForRenderPolicy(node);
      const localMax = normalizeAtomBound(
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

      // Everything else is inherited as it stands: the host's caveat-kind
      // allowance, the text-integrity policy, and the subtree's remote-load
      // block. A boundary narrows maxConfidentiality and never sheds a field.
      policy = {
        ...parentPolicy,
        maxConfidentiality: this.#narrowMaxConfidentiality(
          parentPolicy.maxConfidentiality,
          localMax,
        ),
        declassifyConfidentiality: [
          ...parentPolicy.declassifyConfidentiality,
          ...declassifyConfidentiality,
        ],
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
    // boundary allows it, cell text is admitted only if every enclosing
    // boundary requires some atom, and the block-attribution set carries every
    // enclosing boundary id. An inner boundary can never relax an outer one.
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
        admitsCellText: (parentTextIntegrity?.admitsCellText ?? true) &&
          requiredIntegrity.length > 0,
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

  /**
   * Binds `cell` to the element's `propName` while the node's render policy
   * admits what a read of it consumes. A binding hands the host a live handle
   * to the cell, whose reads return what the worker's read of it returns, so
   * the decision follows that read: it is made again whenever what the read
   * consumed changes, labels included, and whenever the membership those
   * labels name changes, and the binding is removed while the policy refuses
   * it. A nested render root, a binding whose `componentReadContracts` entry
   * lists `renders`, is decided on the reads its component makes of it
   * instead, wherever a render mounted from a reference is held to everything
   * the element is (see `#rootPolicyCovers()`): the read of the binding, and
   * the read of each reference at a path in `renders`, decided as a
   * `cf-render` cell is. A reference's read stops at the document it lands on
   * and leaves that document's contents to the render mounted from it.
   * Elsewhere a nested render root is decided on everything the bound cell
   * reaches. A read that could not complete, one
   * whose space is out of reach or whose labels or links could not be read,
   * withholds the binding and is never taken for an empty read. While a
   * binding {@link ACCESS_PLACEHOLDER_BINDINGS} names is withheld because the
   * space of the read refusing it is out of reach, the element holds the
   * access placeholder as its child, rendered in `ctx`; a binding withheld for
   * any other reason leaves the element empty. `replacing` says whether the
   * element may hold a binding for `propName` from before. `read` is the cell
   * whose read decides, when the binding was reached through a slot whose
   * labels the choice of `cell` carries.
   */
  #bindCell(
    ctx: ReconcileContext,
    state: NodeState,
    propName: string,
    cell: Cell<unknown>,
    replacing: boolean,
    read: Cell<unknown> = cell,
  ): Cancel {
    const bind = () =>
      this.#queueOps([{
        op: "set-binding",
        nodeId: state.nodeId,
        propName,
        cellRef: this.#cellRefForBinding(cell),
      }]);
    if (
      REFERENCE_BINDING_SINKS.get(state.tagName)?.has(propName) ||
      admitsEverything(state.renderPolicy)
    ) {
      bind();
      return () => {};
    }
    const [cancel, addCancel] = useCancelGroup();
    const watch = { watched: new Set<string>(), addCancel, reeval: () => {} };
    let shown: boolean | undefined = replacing || undefined;
    let consumed: SinkConsumedLabel | undefined;
    let first = true;
    const renders = componentReadContracts[state.tagName]?.[propName]?.renders;
    const covered = renders !== undefined &&
      this.#rootPolicyCovers(state.renderPolicy);
    // The empty path is the binding's own reference, which the read of the
    // binding decides.
    const paths = renders?.filter((path) => path.length > 0) ?? [];
    const elements = covered && paths.length > 0
      ? this.#nestedRenderElements(paths, () => watch.reeval())
      : undefined;
    if (elements !== undefined) addCancel(elements.cancel);
    // The placeholder is rendered as the element's children are.
    const childCtx = { ...ctx, emittedSpace: state.childEmittedSpace };
    const placeholder =
      ACCESS_PLACEHOLDER_BINDINGS.get(state.tagName)?.has(propName)
        ? this.#createWrapperState(childCtx, state.nodeId)
        : undefined;
    if (placeholder !== undefined) {
      addCancel(() =>
        this.#reconcileIntoWrapper(
          childCtx,
          placeholder,
          null,
          state.childRenderPolicy,
        )
      );
    }
    watch.reeval = () => {
      if (elements?.settling === true) return;
      const decision = this.#admitProp(
        state,
        propName,
        [{ source: read, reads: [consumed] }, ...(elements?.reads() ?? [])],
        shown,
        first,
        bind,
        watch,
      );
      shown = decision.shown;
      first = false;
      if (
        placeholder !== undefined &&
        (decision.outOfReach !== undefined ||
          placeholder.currentChild !== null)
      ) {
        this.#reconcileIntoWrapper(
          childCtx,
          placeholder,
          decision.outOfReach !== undefined
            ? this.#accessPlaceholderVNode(
              this.#refusedSpaceOf(decision.outOfReach)!,
            )
            : null,
          state.childRenderPolicy,
        );
      }
    };
    // The component reads the binding under the schema the handle it is
    // handed carries, or the one it projects that handle to.
    const hostRead = renders === undefined ? read : read.asSchema(
      covered
        ? componentReadSchema(
          state.tagName,
          propName,
          this.#bindingSchema(cell.getAsNormalizedFullLink().schema),
        ) ?? true
        : true,
    );
    // The binding hands the host a handle whose reads take in the whole
    // value, so its decision is made on the read they are decided on: each
    // value as the worker hands it to a host (`hostValueOf()`), so a field the
    // schema leaves untyped is measured as the host's read takes it in. A
    // stream, which holds no value, is heard as anything else is.
    const subscribe = (
      onRead: (value: unknown, labels?: SinkConsumedLabel) => void,
    ): Cancel =>
      hostRead.sink((value, _cfcLabel, labels) => onRead(value, labels), {
        readOnly: true,
        includeConsumedLabel: true,
      });
    addCancel(this.#sinkRead(
      hostRead,
      (onRead) =>
        isStream(hostRead) ? subscribe(onRead) : sinkProjected(
          hostRead,
          (value) => {
            try {
              hostValueOf(value);
              return { value, complete: true };
            } catch {
              // Links that cannot be followed, as a cycle of them cannot, end
              // a read that does not complete.
              return { value, complete: false };
            }
          },
          ({ value, complete }, labels) =>
            onRead(value, complete ? labels : undefined),
        ),
      (value, labels) => {
        consumed = labels;
        elements?.update(read, value);
        watch.reeval();
      },
    ));
    return cancel;
  }

  /**
   * The reads a component makes of each reference it mounts a render from, at
   * `paths` from the bound value, each read as `cf-render` reads its cell.
   * `update()` keeps one read per reference that `value`, the binding's read
   * of `root`, holds at those paths, keyed by the slot holding it, and
   * `settling` holds while it runs, so that the reads it starts, each
   * reporting its first result to `changed` as it starts, are decided together
   * once it returns. `reads()` returns each reference as the path through the
   * binding's links names it, whose labels a decision reads through those
   * links as they stand then, with what the reference's read consumed.
   *
   * A read addressed through the binding's links crosses them under their
   * stored schemas, and one that declares a reference ends the read at its own
   * link. So each reference is read at the slot holding it in the document the
   * links on the way resolve to, following its own links to the document they
   * land on; the links up to that slot are the binding read's to decide.
   * Links on the way, or a reference's own, that cannot be followed, and a
   * position on the way that the binding's read holds as a reference, add a
   * read that did not complete.
   */
  #nestedRenderElements(
    paths: readonly NestedRenderPath[],
    changed: () => void,
  ): {
    readonly settling: boolean;
    update(root: Cell<unknown>, value: unknown): void;
    reads(): DecidingRead[];
    cancel(): void;
  } {
    type Element = {
      source: Cell<unknown>;
      consumed: SinkConsumedLabel | undefined;
      cancel?: Cancel;
    };
    let elements = new Map<string, Element>();
    let failed: Cell<unknown>[] = [];
    let settling = false;
    return {
      get settling() {
        return settling;
      },
      update: (root, value) => {
        settling = true;
        try {
          const next = new Map<string, Element>();
          const unread: Cell<unknown>[] = [];
          const visit = (
            source: Cell<unknown>,
            at: Cell<unknown>,
            held: unknown,
            path: readonly string[],
          ): void => {
            try {
              if (path.length === 0) {
                const slot = at.getAsNormalizedFullLink();
                const key = JSON.stringify([
                  slot.space,
                  slot.scope,
                  slot.id,
                  slot.path,
                  source.getAsNormalizedFullLink().path,
                ]);
                const kept = next.get(key) ?? elements.get(key);
                if (kept !== undefined) {
                  next.set(key, kept);
                  return;
                }
                const element: Element = { source, consumed: undefined };
                element.cancel = this.#sinkCell(
                  at.asSchema(NestedRenderReferenceSchema),
                  (_value, labels) => {
                    element.consumed = labels;
                    changed();
                  },
                  true,
                );
                next.set(key, element);
                return;
              }
              // A position the binding's read holds as a reference was not
              // read into, so what lies past it is unknown rather than absent.
              if (isCell(held)) {
                unread.push(source);
                return;
              }
              const resolved = at.resolveAsCell();
              const [head, ...rest] = path;
              if (head === "*") {
                if (!Array.isArray(held)) return;
                held.forEach((item, index) =>
                  visit(source.key(index), resolved.key(index), item, rest)
                );
              } else if (isObjectNotArray(held)) {
                visit(source.key(head), resolved.key(head), held[head], rest);
              }
            } catch {
              // Links that cannot be followed, as a cycle of them cannot, end
              // a read that does not complete.
              unread.push(source);
            }
          };
          for (const path of paths) visit(root, root, value, path);
          for (const [key, element] of elements) {
            if (!next.has(key)) element.cancel?.();
          }
          elements = next;
          failed = unread;
        } finally {
          settling = false;
        }
      },
      reads: () => [
        ...failed.map((source) => ({ source, reads: [undefined] })),
        ...[...elements.values()].map(({ source, consumed }) => ({
          source,
          reads: [consumed],
        })),
      ],
      cancel: () => {
        for (const element of elements.values()) element.cancel?.();
        elements.clear();
      },
    };
  }

  /**
   * Decides whether the node's render policy admits a prop or binding whose
   * value rests on `decidingReads`, each a cell and the reads of it that
   * consumed the labels they report, as {@link readRefusal} decides for each,
   * and emits only what the decision changes. The policy has to admit every
   * one of them. `shown` says whether the prop may be showing before the
   * decision, or is undefined when nothing has been shown for it; the result's
   * `shown` says whether it may be showing after, and its `outOfReach`, when
   * the prop is refused because the space of the read refusing it is out of
   * reach, is that read's cell. `show` runs when the prop is admitted and
   * either its value `changed` or it was not showing. A refused prop is
   * removed when it may be showing, and the refusal reported once per standing
   * block.
   */
  #admitProp(
    state: NodeState,
    key: string,
    decidingReads: readonly DecidingRead[],
    shown: boolean | undefined,
    changed: boolean,
    show: () => void,
    watch: FitWatch,
    value: unknown = UNKNOWN_PROP_VALUE,
  ): { shown: boolean; outOfReach?: Cell<unknown> } {
    const policy = state.renderPolicy;
    // The first read that refuses, with what refused it, and whether its
    // space is in reach: a read whose space is out of reach is refused
    // because it could not complete, which is not a denial to report.
    const firstRefusal = <R>(
      refusalOf: (read: DecidingRead) => R | undefined,
    ):
      | { refusal: R; source: Cell<unknown>; reachable: boolean }
      | undefined => {
      for (const read of decidingReads) {
        const refusal = refusalOf(read);
        if (refusal !== undefined) {
          return {
            refusal,
            source: read.source,
            reachable: this.#cellAccessError(read.source) === undefined,
          };
        }
      }
      return undefined;
    };
    const refused = firstRefusal(({ source, reads }) =>
      readRefusal(source, reads, policy, this.#fitSources, watch)
    );
    const remoteRefused =
      refused === undefined && this.#isRemoteLoadProp(state, key, value)
        ? firstRefusal(({ source, reads }) =>
          this.#remoteLoadRefusal(source, reads, policy, watch)
        )
        : undefined;
    if (refused === undefined && remoteRefused === undefined) {
      if (changed || shown !== true) show();
      return { shown: true };
    }
    if (shown !== false) {
      if (refused?.reachable === true) {
        this.#reportRenderDenial(() => refused.refusal, policy);
      } else if (remoteRefused?.reachable === true) {
        this.#reportRemoteLoadDenial(key, policy, remoteRefused.refusal);
      }
      if (shown) {
        this.#queueOps([{ op: "remove-prop", nodeId: state.nodeId, key }]);
      }
    }
    const refusing = refused ?? remoteRefused;
    return {
      shown: false,
      outOfReach: refusing?.reachable === false ? refusing.source : undefined,
    };
  }

  /**
   * Whether setting `key` on `state`'s element could make the browser fetch a
   * URL ({@link REMOTE_LOAD_PROPS}). `value` decides a `style`; a binding,
   * whose value is not known here, counts as one that could.
   */
  #isRemoteLoadProp(
    state: NodeState,
    key: string,
    value: unknown = UNKNOWN_PROP_VALUE,
  ): boolean {
    const prop = key.toLowerCase();
    if (VALUE_DECIDED_REMOTE_LOAD_PROPS.has(prop)) {
      return value === UNKNOWN_PROP_VALUE || valueMayLoadRemote(value);
    }
    return (REMOTE_LOAD_PROPS.get("*")?.has(prop) ?? false) ||
      (REMOTE_LOAD_PROPS.get(state.tagName.toLowerCase())?.has(prop) ?? false);
  }

  /**
   * The policy a URL fetch is decided under: `policy` without the caveat
   * kinds a fetch does not admit ({@link REMOTE_LOAD_REFUSED_CAVEAT_KINDS}). That is
   * the display ceiling as it stood before the prompt-caveat family was
   * admitted (SC-54, SC-56).
   */
  #remoteLoadPolicyOf(policy: RenderPolicy): RenderPolicy {
    const known = this.#remoteLoadPolicies.get(policy);
    if (known !== undefined) return known;
    const kinds = policy.caveatKindAllow;
    const derived = kinds === undefined ||
        !kinds.some((kind) => REMOTE_LOAD_REFUSED_CAVEAT_KINDS.has(kind))
      ? policy
      : {
        ...policy,
        caveatKindAllow: kinds.filter((kind) =>
          !REMOTE_LOAD_REFUSED_CAVEAT_KINDS.has(kind)
        ),
      };
    this.#remoteLoadPolicies.set(policy, derived);
    return derived;
  }

  /**
   * Whether two policies decide remote loads alike. Content laid out under
   * one is never reused under the other: a literal prop the old decision set
   * would be skipped as unchanged. Keyed children need no check of their own:
   * a change makes their parent's child policy differ, and a parent whose
   * child policy changed replaces its children rather than reusing them.
   */
  #sameRemoteLoadDecision(left: RenderPolicy, right: RenderPolicy): boolean {
    return (left.remoteLoadsBlocked ?? false) ===
      (right.remoteLoadsBlocked ?? false);
  }

  /**
   * Whether `reads` of `cell` could carry a caveat the remote-load policy
   * refuses: a confidentiality atom of one of those kinds, in a clause or as
   * an alternative, in what the reads consumed or in the cell's own labels.
   * When none does, the remote-load policy decides exactly as the render
   * policy already did, so the second fit is skipped.
   */
  #mayCarryRemoteRefusedCaveat(
    cell: Cell<unknown>,
    reads: readonly (SinkConsumedLabel | undefined)[],
  ): boolean {
    const refusedAtom = (atom: unknown): boolean =>
      isObjectOrArray(atom) && atom.type === CFC_ATOM_TYPE.Caveat &&
      typeof atom.kind === "string" &&
      REMOTE_LOAD_REFUSED_CAVEAT_KINDS.has(atom.kind);
    const refused = (clauses: readonly CfcConfClause[]): boolean =>
      clauses.some((clause) => clauseAlternatives(clause).some(refusedAtom));
    if (reads.some((read) => read === undefined)) return true;
    if (reads.some((read) => refused(read?.confidentiality ?? []))) {
      return true;
    }
    for (const source of cellLabelSources(cell) ?? []) {
      if (source.view === undefined) return true;
      if (refused(confidentialityLabels(source.view))) return true;
    }
    // The schema's atoms, which `readRefusal()` falls back to when the reads
    // consumed none.
    return confidentialityLabelsFromCellSchema(cell).some(refusedAtom);
  }

  /**
   * Why a prop that would fetch a URL, read from `source` by `reads`, may not
   * be set under `policy`, or undefined when it may: refused when the view it
   * is in carries a caveat the remote-load policy refuses, or when the read's own
   * labels do.
   */
  #remoteLoadRefusal(
    source: Cell<unknown>,
    reads: readonly (SinkConsumedLabel | undefined)[],
    policy: RenderPolicy,
    watch: FitWatch,
  ): RemoteLoadRefusal | undefined {
    if (policy.remoteLoadsBlocked) return { byView: true };
    if (!this.#mayCarryRemoteRefusedCaveat(source, reads)) return undefined;
    const label = readRefusal(
      source,
      reads,
      this.#remoteLoadPolicyOf(policy),
      this.#fitSources,
      watch,
    );
    return label === undefined ? undefined : { byView: false, label };
  }

  /**
   * Whether a literal prop, part of the view `state` renders, would fetch a
   * URL in a view whose data carries a caveat the remote-load policy refuses.
   */
  #literalRemoteLoadBlocked(
    state: NodeState,
    key: string,
    value: unknown,
  ): boolean {
    return state.renderPolicy.remoteLoadsBlocked === true &&
      this.#isRemoteLoadProp(state, key, value);
  }

  #reportRemoteLoadDenial(
    prop: string,
    policy: RenderPolicy,
    refusal: RemoteLoadRefusal,
  ): void {
    reportCfcDenial(
      "render-remote-load",
      "a prop that would fetch a URL was not set: its value, or the view it is in, carries a caveat a fetch does not admit",
      () => ({
        prop,
        ...(refusal.byView ? { blockedByView: true } : refusal.label),
        caveatKindAllow: this.#remoteLoadPolicyOf(policy).caveatKindAllow,
      }),
    );
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

  /**
   * Guards both the containing view and any linked event target at dispatch,
   * except for an access placeholder's retry control, whose whole purpose is
   * to be used while access is refused.
   */
  #registerHandler(
    ctx: ReconcileContext,
    handler: (event: unknown) => void,
    target?: Cell<unknown>,
  ): number {
    if (this.#accessRetryHandlers.has(handler)) {
      return ctx.registerHandler(handler);
    }
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
    const space = this.#refusedSpaceOf(cell);
    return space === undefined ? undefined : this.#spaceAccess?.error(space);
  }

  /**
   * The space of `cell`, or of the cell it links to, whose session the access
   * provider reports refused, or `undefined` when neither is.
   */
  #refusedSpaceOf(cell: Cell<unknown>): string | undefined {
    if (this.#spaceAccess === undefined) return undefined;
    for (const candidate of [cell, this.#resolveCellForBinding(cell)]) {
      const space = this.#spaceOfCell(candidate);
      if (space !== undefined && this.#spaceAccess.error(space) !== undefined) {
        return space;
      }
    }
    return undefined;
  }

  /**
   * Keeps a rendered subscription responsive to session access loss and
   * recovery. `deliver` receives the value and the labels the read consumed.
   * While a space the cell is read from is out of reach, the read does not
   * complete: the value is undefined and no consumed labels are reported,
   * which {@link readRefusal} refuses, so a decision on the read withholds
   * rather than taking it for an empty read.
   */
  #sinkCell<T>(
    cell: Cell<T>,
    deliver: (value: T | undefined, consumed?: SinkConsumedLabel) => void,
    includeConsumedLabel = false,
  ): Cancel {
    return this.#sinkRead(
      cell,
      (onRead) =>
        cell.sink((value, _cfcLabel, read) => onRead(value, read), {
          readOnly: true,
          includeConsumedLabel,
        }),
      deliver,
    );
  }

  /**
   * {@link #sinkCell} over the subscription `subscribe` makes of `cell`, which
   * reports each value and the labels its read consumed to the `onRead` it is
   * handed.
   */
  #sinkRead<T>(
    cell: Cell<T>,
    subscribe: (
      onRead: (value: T | undefined, read?: SinkConsumedLabel) => void,
    ) => Cancel,
    deliver: (value: T | undefined, consumed?: SinkConsumedLabel) => void,
  ): Cancel {
    const [cancel, addCancel] = useCancelGroup();
    const watched = new Set<string>();
    let active = true;
    let current: T | undefined;
    let consumed: SinkConsumedLabel | undefined;
    const emit = () => {
      if (active) {
        const reachable = this.#cellAccessError(cell) === undefined;
        deliver(
          reachable ? current : undefined,
          reachable ? consumed : undefined,
        );
      }
    };
    const onRead = (value: T | undefined, read?: SinkConsumedLabel) => {
      current = value;
      consumed = read;
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
    };
    addCancel(subscribe(onRead));
    return () => {
      active = false;
      cancel();
    };
  }

  /**
   * What stands in for content of `space` while its session is refused: a
   * status saying so, and, when the access provider can retry, a control that
   * asks once more. While a retry of the space is in flight the status is
   * `aria-busy` and reads "Retrying…" after the control, and it carries how
   * many retries have settled as `data-space-access-retries`. The control
   * itself is the same whatever the retry state, so a placeholder updated in
   * place keeps it and its keyboard focus, and a press while a retry is in
   * flight shares that retry. An admission re-renders the content through the
   * provider's `subscribe()`.
   */
  #accessPlaceholderVNode(space: string): WorkerVNode {
    const props: WorkerProps = {
      "data-space-access-lost": "true",
      role: "status",
    };
    const children: WorkerRenderNode[] = ["Access unavailable"];
    const retries = this.#spaceAccess?.retries;
    if (retries !== undefined) {
      const { retrying, settled } = retries.state(space);
      const retry = () => retries.retry(space);
      this.#accessRetryHandlers.add(retry);
      props["aria-busy"] = retrying ? "true" : "false";
      props["data-space-access-retries"] = String(settled);
      children.push(" ", {
        type: "vnode",
        name: "button",
        props: {
          type: "button",
          "data-space-access-retry": "true",
          onClick: retry,
        },
        children: ["Retry"],
      });
      if (retrying) children.push(" Retrying…");
    }
    return { type: "vnode", name: "span", props, children };
  }

  /**
   * Names the access placeholder `space` gets now, which changes whenever
   * what the placeholder shows does.
   */
  #accessPlaceholderKey(space: string): string {
    const state = this.#spaceAccess?.retries?.state(space);
    return state === undefined
      ? `access:${space}`
      : `access:${space}:${state.retrying}:${state.settled}`;
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
   * The cell's own CFC label view, or — when it has none — the view of the
   * place its path resolves to, which a text-integrity denial reports. May
   * throw.
   */
  #resolveCellLabelView(cell: Cell<unknown>): CfcLabelView | undefined {
    return cfcLabelViewSourceForCell(cell).view ??
      cfcLabelViewSourceForCell(cell.resolveAsCell()).view;
  }

  /**
   * The principals the label of `cell`'s value says it represents, as
   * `authorPrincipalCandidates()` reads them from the document that holds the
   * value; none when that label cannot be read.
   */
  #representedPrincipalsForCell(cell: Cell<unknown>): string[] {
    return authorPrincipalCandidates(cfcLabelViewForResolvedTarget(cell));
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
    if (policy.remoteLoadsBlocked && node.name.toLowerCase() === "style") {
      return { children: [this.#blockedPlaceholderVNode()], blocked: true };
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
    return canRenderCellUnderPolicy(protectedValue, policy, this.#fitSources)
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
          : CFC_POLICY_PLACEHOLDER_TEXT,
      ],
    };
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
      this.#sameRemoteLoadDecision(left, right) &&
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
      leftPolicy.admitsCellText === rightPolicy.admitsCellText &&
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
   * Whether a render mounted from a reference, which starts from the root
   * policy, holds what it shows to everything `policy` holds an element to:
   * the policy's ceiling holds every clause (`CfcConfClause`) of the root
   * ceiling, and no text-integrity requirement is in force, since a nested
   * render applies none. A boundary only narrows a ceiling and only adds
   * declassification, so the first condition holds exactly when no boundary
   * above the element lowered the ceiling.
   */
  #rootPolicyCovers(policy: RenderPolicy): boolean {
    const root = this.#rootRenderPolicy.maxConfidentiality;
    const own = policy.maxConfidentiality;
    return policy.textIntegrity === undefined &&
      (root === undefined ? own === undefined : own !== undefined &&
        root.every((atom) => own.some((held) => deepEqual(atom, held))));
  }

  /**
   * The label a text-integrity denial reports, in the form an explanation
   * reports it: the view {@link #resolveCellLabelView} reads, the schema's
   * information-flow constraint when there is none, and the read-failure case
   * named rather than left blank.
   */
  #renderLabelSummary(cell: Cell<unknown>): RenderLabelSummary {
    let labelView: CfcLabelView | undefined;
    try {
      labelView = this.#resolveCellLabelView(cell);
    } catch {
      return { labelSource: "unreadable", confidentiality: [], integrity: [] };
    }
    if (labelView === undefined) {
      return {
        labelSource: "schema",
        confidentiality: confidentialityLabelsFromCellSchema(
          cell,
        ) as readonly CfcConfClause[],
        integrity: [],
      };
    }
    return {
      labelSource: "stored",
      confidentiality: confidentialityLabels(labelView),
      integrity: integrityLabels(labelView),
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
    this.#reportRenderDenial(
      () =>
        cellLabelRefusal(
          cell,
          cellLabelSources(cell),
          policy,
          this.#fitSources,
        ) ??
          this.#renderLabelSummary(cell),
      policy,
    );
  }

  /** {@link #denyCellRender}, for the label `summary` gives. */
  #reportRenderDenial(
    summary: () => RenderLabelSummary,
    policy: RenderPolicy,
  ): void {
    reportCfcDenial(
      "render-confidentiality-ceiling",
      "the render policy did not admit a cell's confidentiality label",
      () => ({
        ...summary(),
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
    if (!textIntegrity.admitsCellText) {
      return false;
    }

    // The value's own document vouches for the text. The documents the read
    // passed through on the way vouch only for the links they hold.
    const labelView = cfcLabelViewForResolvedTarget(cell, {
      kickCrossSpaceTargets: false,
    });
    if (labelView === undefined) {
      return false;
    }

    const integrity = integrityLabels(labelView);
    return textIntegrity.requiredIntegrity.every((required) =>
      integrity.some((atom) => deepEqual(atom, required))
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
   *
   * `deliver` receives each value with the cell it was read from and the
   * labels each read behind it consumed.
   */
  #sinkPropValue(
    cell: Cell<unknown>,
    deliver: (
      value: unknown,
      source: Cell<unknown>,
      reads: readonly (SinkConsumedLabel | undefined)[],
    ) => void,
    includeConsumedLabel: boolean,
  ): Cancel {
    type Referenced = {
      cell: Cell<unknown>;
      cancel: Cancel;
      value: unknown;
      consumed: SinkConsumedLabel | undefined;
    };
    let referenced: Referenced | undefined;
    // The labels the read of the reference consumed: a dereference retains
    // them, since which target it names can depend on them (spec §4.6.3).
    let outer: SinkConsumedLabel | undefined;
    const deliverReferenced = (current: Referenced) =>
      deliver(current.value, current.cell, [outer, current.consumed]);
    const cancelOuter = this.#sinkCell(cell, (value, consumed) => {
      outer = consumed;
      const named = cellOfOpaqueReference(value);
      if (named === undefined) {
        referenced?.cancel();
        referenced = undefined;
        deliver(value, cell, [consumed]);
        return;
      }
      // The reference's position outlives the read that projected it, so the
      // subscription must not hold that read's transaction.
      const scalar = named.withTx(undefined).asSchema(REFERENCED_SCALAR_SCHEMA);
      if (referenced !== undefined && areLinksSame(referenced.cell, scalar)) {
        if (includeConsumedLabel) deliverReferenced(referenced);
        return;
      }
      referenced?.cancel();
      const current: Referenced = {
        cell: scalar,
        cancel: () => {},
        value: undefined,
        consumed: undefined,
      };
      referenced = current;
      current.cancel = this.#sinkCell(scalar, (value, consumed) => {
        current.value = value;
        current.consumed = consumed;
        deliverReferenced(current);
      }, includeConsumedLabel);
    }, includeConsumedLabel);
    return () => {
      cancelOuter();
      referenced?.cancel();
      referenced = undefined;
    };
  }

  /**
   * {@link #sinkPropValue}, delivering only values whose read consumed
   * labels the node's render policy admits, and removing the prop while it
   * does not. The decision is made again whenever what the read consumed
   * changes, labels included, and whenever the membership those labels name
   * changes, as it is for a cell child.
   * `replacing` says whether the element may hold a value for `key` from
   * before.
   */
  #sinkAdmittedPropValue(
    state: NodeState,
    key: string,
    cell: Cell<unknown>,
    replacing: boolean,
    deliver: (value: unknown) => void,
  ): Cancel {
    const [cancel, addCancel] = useCancelGroup();
    const watch = { watched: new Set<string>(), addCancel, reeval: () => {} };
    let shown: boolean | undefined = replacing || undefined;
    let latest: {
      value: unknown;
      source: Cell<unknown>;
      reads: readonly (SinkConsumedLabel | undefined)[];
    } = { value: undefined, source: cell, reads: [] };
    const decide = (changed: boolean) => {
      const { value, source, reads } = latest;
      shown = this.#admitProp(
        state,
        key,
        [{ source, reads }],
        shown,
        changed,
        () => deliver(value),
        watch,
        value,
      ).shown;
    };
    watch.reeval = () => decide(false);
    addCancel(this.#sinkPropValue(cell, (value, source, reads) => {
      latest = { value, source, reads };
      decide(true);
    }, !admitsEverything(state.renderPolicy)));
    return cancel;
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
   * Emit a resolved reactive prop only when it is usable. Availability markers
   * are control-flow values: initially the DOM prop remains unset, and a later
   * marker retains the last usable prop value until another usable value
   * arrives.
   */
  #emitReactivePropValueIfAvailable(
    state: NodeState,
    key: string,
    value: unknown,
    sourceCell?: Cell<unknown>,
  ): boolean {
    if (isUnavailable(value)) return false;

    const propValue = this.#transformPropValueForState(
      state,
      key,
      value,
      sourceCell,
    );
    this.#queueOps([{
      op: "set-prop",
      nodeId: state.nodeId,
      key,
      value: propValue,
    }]);
    return true;
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

    // Case 1: Same element type - update in place.
    if (oldState && this.#updateInPlace(ctx, oldState, node, policy)) {
      logger.debug("reconcile-node", () => ({
        id: wrapper.nodeId,
        strategy: "update-in-place",
        tagName: newTagName,
      }));
      return;
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
   * Helper for `#reconcileIntoWrapper()` and the refused-content placeholder,
   * which updates `oldState` in place to render `node`, diffing its props and
   * children, and returns whether it could. It cannot when `node` is not an
   * element of the same tag, when sanitizing drops it, or across a change in
   * the subtree's fetch block, where a literal prop the old decision set
   * would be skipped as unchanged.
   */
  #updateInPlace(
    ctx: ReconcileContext,
    oldState: NodeState,
    node: WorkerRenderNode,
    policy: RenderPolicy,
  ): boolean {
    const newVNode = this.#extractVNode(node);
    const oldTagName = "tagName" in oldState ? oldState.tagName : null;
    const newTagName = newVNode?.name ?? null;
    if (
      !oldTagName || !newTagName || oldTagName !== newTagName ||
      !this.#sameRemoteLoadDecision(oldState.renderPolicy, policy)
    ) {
      return false;
    }
    const sanitized = this.#sanitizeNode(newVNode!);
    if (!sanitized) return false;
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
    return true;
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
        this.#updateBindingProp(ctx, state, key, value, existingState);
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
        this.#bindCellProp(
          ctx,
          state,
          key,
          value as Cell<unknown>,
          existingState !== undefined,
        );
      } else {
        // Static prop. Skip the redundant worker→main set-prop op for an
        // unchanged primitive value (see canSkipUnchangedStaticProp). #4366 made
        // updateChildrenInPlace always reconcile reused inline-VNode children,
        // so this path now fires on every parent recompute even when captured
        // values are identical; damping it removes the op + JSON.stringify
        // churn (CT-1798).
        if (this.#literalRemoteLoadBlocked(state, key, value)) {
          if (existingState) {
            existingState.cancel();
            state.propSubscriptions.delete(key);
            this.#removeSingleProp(state, key);
          }
          this.#reportRemoteLoadDenial(key, state.renderPolicy, {
            byView: true,
          });
          continue;
        }
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
    ctx: ReconcileContext,
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
      state.propSubscriptions.set(key, {
        cell: value as Cell<unknown>,
        cancel: this.#bindCell(
          ctx,
          state,
          propName,
          value as Cell<unknown>,
          existingState !== undefined,
        ),
      });
    }
  }

  /**
   * The keys among `keys` whose value the node's render policy has to decide
   * on by what a read of that key consumes: each whose stored value is a
   * link, and every one when the policy does not admit the props object's
   * own label, as when the props are linked from a document of their own. A
   * props object that cannot be read counts every key.
   */
  #propKeysReadAlone(
    state: NodeState,
    propsCell: Cell<WorkerProps>,
    keys: readonly string[],
  ): ReadonlySet<string> {
    const raw = this.#readCellPolicyValue(propsCell);
    if (
      !isObjectNotArray(raw) ||
      !canRenderCellUnderPolicy(propsCell, state.renderPolicy, this.#fitSources)
    ) {
      return new Set(keys);
    }
    return new Set(
      keys.filter((key) => parseLink(raw[key], propsCell) !== undefined),
    );
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
      const gated = !admitsEverything(state.renderPolicy);
      const readAlone = gated
        ? this.#propKeysReadAlone(state, propsCell, [...newKeys])
        : new Set<string>();

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

          state.propSubscriptions.set(key, {
            cell: resolvedTarget,
            cancel: this.#bindCell(
              ctx,
              state,
              getBindingPropName(key),
              resolvedTarget,
              existingState !== undefined,
              // Read through the props' slot, whose labels govern which cell
              // is bound, as the host's handle reads the target.
              propsCell.key(key).asSchema(
                resolvedTarget.getAsNormalizedFullLink().schema,
              ),
            ),
          });
        } else if (
          (isObjectOrArray(value) && (key !== "style" || gated)) ||
          readAlone.has(key)
        ) {
          // Generic object/array values are deliberately capped in
          // rendererVDOMSchema, so they need a per-prop sink for deep
          // resolution. Style is excluded while no render policy gates the
          // node: its explicit schema already traverses the object through
          // the parent props sink. Under a policy, a style object and a value
          // read through a link take a per-prop sink too, so the policy
          // decides on the labels that read consumed; a literal is part of
          // this view, which the policy already admitted.
          const existingState = state.propSubscriptions.get(key);
          if (existingState?.cell) continue; // Already has active per-prop sink

          // Cancel any existing primitive subscription for this key
          if (existingState) existingState.cancel();

          // Schema `true` = accept everything → enables deep traversal of this prop
          const propKeyCell = propsCell.key(key).asSchema(true);
          const propSinkCancel = this.#sinkAdmittedPropValue(
            state,
            key,
            propKeyCell,
            existingState !== undefined,
            (deepValue) => {
              this.#emitReactivePropValueIfAvailable(
                state,
                key,
                deepValue,
                this.#resolveTextPropSourceCell(state, propsCell, key, value),
              );
            },
          );
          state.propSubscriptions.set(key, {
            cell: propKeyCell as Cell<unknown>,
            cancel: propSinkCancel,
          });
        } else {
          // Literal primitive or style string - set directly
          const existingState = state.propSubscriptions.get(key);

          // Cancel a generic per-prop sink if its value became direct.
          if (existingState?.cell) {
            existingState.cancel();
          }

          // A literal that would fetch a URL is decided on the view it is
          // part of: the subtree's bit, and the props cell's own labels, so
          // the decision does not depend on whether this sink fires before
          // the one that sets the bit.
          if (this.#isRemoteLoadProp(state, key, value)) {
            const label = state.renderPolicy.remoteLoadsBlocked
              ? undefined
              : admitsEverything(state.renderPolicy)
              ? undefined
              : cellLabelRefusal(
                propsCell,
                cellLabelSources(propsCell),
                this.#remoteLoadPolicyOf(state.renderPolicy),
                this.#fitSources,
              );
            if (state.renderPolicy.remoteLoadsBlocked || label !== undefined) {
              if (existingState) {
                state.propSubscriptions.delete(key);
                this.#removeSingleProp(state, key);
              }
              this.#reportRemoteLoadDenial(
                key,
                state.renderPolicy,
                label === undefined
                  ? { byView: true }
                  : { byView: false, label },
              );
              continue;
            }
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

          if (
            !this.#emitReactivePropValueIfAvailable(
              state,
              key,
              value,
              this.#resolveTextPropSourceCell(state, propsCell, key, value),
            )
          ) continue;
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
      return cellRuntime(propsCell).getCellFromLink(link);
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

  /** Renders what stands in for content of `space` while it is refused. */
  #createAccessPlaceholder(
    ctx: ReconcileContext,
    policy: RenderPolicy,
    space: string,
  ): NodeState {
    return this.#renderNode(
      ctx,
      this.#accessPlaceholderVNode(space),
      new Set(),
      policy,
    )!;
  }

  #createBlockedPlaceholder(
    ctx: ReconcileContext,
    policy: RenderPolicy,
    reason: "policy" | "integrity" = "policy",
  ): NodeState {
    const nodeId = ctx.nextNodeId();
    const textId = ctx.nextNodeId();
    const integrityBlocked = reason === "integrity";
    const text = integrityBlocked
      ? CFC_TEXT_INTEGRITY_PLACEHOLDER
      : CFC_POLICY_PLACEHOLDER_TEXT;
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
   * Sets `key` from a cell's value each time it changes. `replacing` says
   * whether the element may hold a value for `key` from before.
   */
  #bindCellProp(
    ctx: ReconcileContext,
    state: NodeState,
    key: string,
    cell: Cell<unknown>,
    replacing: boolean,
  ): void {
    state.propSubscriptions.set(key, {
      cell,
      cancel: this.#sinkAdmittedPropValue(state, key, cell, replacing, (
        value,
      ) => {
        this.#emitReactivePropValueIfAvailable(state, key, value, cell);
        if (this.#isTextIntegrityPolicyProp(key)) {
          this.#refreshTextIntegrityBoundary(ctx, state);
        }
      }),
    });
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
        if (isCell(value)) {
          state.propSubscriptions.set(key, {
            cell: value as Cell<unknown>,
            cancel: this.#bindCell(
              ctx,
              state,
              getBindingPropName(key),
              value as Cell<unknown>,
              false,
            ),
          });
        }
      } else if (isCell(value)) {
        this.#bindCellProp(ctx, state, key, value as Cell<unknown>, false);
      } else if (this.#literalRemoteLoadBlocked(state, key, value)) {
        this.#reportRemoteLoadDenial(key, state.renderPolicy, {
          byView: true,
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
    // Whether the rendered content was laid out with its URL fetches blocked.
    // A change re-renders rather than reusing what the old decision set.
    let currentRemoteLoadsBlocked = false;
    // Which placeholder stands in for policy-blocked content, and which
    // refused space it stands in for, so that a change of placeholder
    // re-renders even when the value it stands in for has not changed.
    let currentPlaceholder: string | undefined;
    let currentRefusedSpace: string | undefined;
    let childIsPending = false;

    // §4.9.3 Stage 2: on each render, watch the ACL docs of the spaces this
    // cell's read is labeled with, so a fail-closed over-block upgrades to an
    // admit when a `Space(X)` ACL syncs in (and a revoke re-blocks) — a
    // re-evaluation with the last resolved value, which emits only a change
    // in the decision.
    let consumed: SinkConsumedLabel | undefined;
    const watch: FitWatch = {
      watched: new Set<string>(),
      addCancel,
      reeval: () => renderResolved(childState.currentValue),
    };

    const renderResolved = (resolvedChild: unknown) => {
      const isInitialRender = childState.nodeId === -1;
      const resultCell = this.#resolveCellForBinding(cell);
      const unavailable = isUnavailable(resolvedChild);
      const valueUnchanged = Object.is(
        resolvedChild,
        childState.currentValue,
      );
      childState.currentValue = resolvedChild;
      const refusal = readRefusal(
        cell,
        [consumed],
        policy,
        this.#fitSources,
        watch,
      );
      const refusedSpace = this.#refusedSpaceOf(cell);
      const blockedByPolicy = refusedSpace !== undefined ||
        refusal !== undefined;
      const blockedByIntegrity = !blockedByPolicy &&
        this.#shouldBlockTextFromCell(resolvedChild, cell, policy);
      // Admitted for display, the cell may still carry a caveat a URL fetch
      // does not admit; what it renders then sets no prop that would fetch
      // one (SC-56).
      const remoteLoadsBlocked = !blockedByPolicy &&
        (policy.remoteLoadsBlocked === true ||
          this.#mayCarryRemoteRefusedCaveat(cell, [consumed]) &&
            readRefusal(
                cell,
                [consumed],
                this.#remoteLoadPolicyOf(policy),
                this.#fitSources,
                watch,
              ) !== undefined);
      const contentPolicy: RenderPolicy =
        remoteLoadsBlocked && !policy.remoteLoadsBlocked
          ? { ...policy, remoteLoadsBlocked: true }
          : policy;
      const sameRemoteLoadDecision =
        currentRemoteLoadsBlocked === remoteLoadsBlocked;

      const placeholder = refusedSpace !== undefined
        ? this.#accessPlaceholderKey(refusedSpace)
        : "policy";
      if (!isInitialRender && valueUnchanged) {
        if (blockedByPolicy && currentContentState === "policy-blocked") {
          if (currentPlaceholder === placeholder) return;
          // A retry starting or settling changes the placeholder of the same
          // space, which is updated where it stands, so that its control
          // keeps keyboard focus.
          if (
            refusedSpace !== undefined &&
            refusedSpace === currentRefusedSpace &&
            childState.elementState !== undefined &&
            this.#updateInPlace(
              ctx,
              childState.elementState,
              this.#accessPlaceholderVNode(refusedSpace),
              policy,
            )
          ) {
            currentPlaceholder = placeholder;
            return;
          }
        }
        if (
          blockedByIntegrity && currentContentState === "integrity-blocked"
        ) {
          return;
        }
        if (
          !blockedByPolicy && !blockedByIntegrity &&
          currentContentState === "rendered" && sameRemoteLoadDecision
        ) {
          this.#updatePieceBoundary(childState, resolvedChild, resultCell);
          return;
        }
      }

      if (blockedByPolicy) {
        if (refusedSpace === undefined && refusal !== undefined) {
          this.#reportRenderDenial(() => refusal, policy);
        }
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
        childIsPending = false;

        const blockedState = refusedSpace !== undefined
          ? this.#createAccessPlaceholder(ctx, policy, refusedSpace)
          : this.#createBlockedPlaceholder(ctx, policy);
        childState.nodeId = blockedState.nodeId;
        childState.elementState = blockedState;
        childState.isText = false;
        currentCancel = blockedState.cancel;
        currentContentState = "policy-blocked";
        currentPlaceholder = placeholder;
        currentRefusedSpace = refusedSpace;

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

      // Pending behaves like suspense: retain the last rendered child and mark
      // it stale, but render nothing before the first usable value. Other
      // unavailable reasons clear the child. Policy and integrity refusals
      // remain authoritative over availability retention.
      if (unavailable && !blockedByIntegrity) {
        if (resolvedChild.reason === "pending") {
          if (
            currentContentState === "rendered" && childState.nodeId !== -1 &&
            !childIsPending
          ) {
            this.#queuePendingRenderState(childState.nodeId, true);
            childIsPending = true;
          }
          return;
        }

        if (childState.nodeId !== -1) {
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
        childIsPending = false;
        currentContentState = undefined;
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
        childIsPending = false;

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

      if (childIsPending && childState.nodeId !== -1) {
        this.#queuePendingRenderState(childState.nodeId, false);
        childIsPending = false;
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
          childState.elementState && currentContentState === "rendered" &&
          sameRemoteLoadDecision
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
                contentPolicy,
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
              childState.elementState.renderPolicy = contentPolicy;
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
          currentContentState === "rendered" && sameRemoteLoadDecision
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
            contentPolicy,
            { trustedText: true },
          ).nodeId,
          isText: true,
          cancel: () => {},
        }
        : this.#renderChildContent(
          ctx,
          resolvedChild,
          new Set(visited),
          contentPolicy,
        );
      currentRemoteLoadsBlocked = remoteLoadsBlocked;
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
      this.#sinkCell(cell, (resolvedChild, read) => {
        consumed = read;
        renderResolved(resolvedChild);
      }, !admitsEverything(policy)),
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
