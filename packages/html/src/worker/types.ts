/**
 * Worker-side VDOM types for the worker-thread rendering system.
 *
 * These types define the VDOM structure used in the worker thread,
 * where cells are accessed synchronously via cell.get() and cell.sink().
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import type { Cancel, Cell, JSONSchema } from "@commonfabric/runner";
import type {
  CfcConfClause,
  RenderConfidentialityResolver,
  SpaceMembershipProvider,
} from "@commonfabric/runner/cfc";
import type { CellRef, JSONValue } from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { VDomOp } from "../vdom-ops.ts";

/**
 * A render node in the worker VDOM tree.
 * Can be a VNode, a Cell that produces VNodes, or primitive values.
 */
export type WorkerRenderNode =
  | WorkerVNode
  | Cell<WorkerVNode>
  | Cell<WorkerRenderNode>
  | Cell<WorkerRenderNode[]>
  | WorkerRenderNode[]
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * Props for a worker VDOM node.
 * Values can be static or reactive (Cell).
 */
export type WorkerProps = {
  [key: string]:
    | JSONValue
    | undefined
    | Cell<JSONValue>
    | ((event: unknown) => void) // Event handlers
    | Cell<unknown>; // For $prop bindings
};

/**
 * A virtual DOM node in the worker thread.
 */
export interface WorkerVNode {
  type: "vnode";
  name: string;
  props: WorkerProps | Cell<WorkerProps> | null | undefined;
  children:
    | WorkerRenderNode[]
    | Cell<WorkerRenderNode | WorkerRenderNode[]>
    | undefined;
}

/**
 * JSX element type for worker components.
 */
export type WorkerJSXElement = WorkerVNode | Cell<WorkerVNode>;

/**
 * Check if a value is a WorkerVNode.
 */
export function isWorkerVNode(value: unknown): value is WorkerVNode {
  return isObjectOrArray(value) && value.type === "vnode";
}

/**
 * Tracks a prop's current Cell reference and cancel function.
 * Used for diffing props during in-place updates.
 */
export interface PropState {
  /** The Cell being subscribed to (if reactive), or undefined for static props */
  cell: Cell<unknown> | undefined;

  /** Cancel function for this prop's subscription */
  cancel: Cancel;

  /** The specific value bound (for equality checking of static props/handlers) */
  currentValue?: unknown;
}

/**
 * Tracks the children Cell reference for diffing.
 */
export interface ChildrenState {
  /** The Cell being subscribed to (if reactive), or undefined for static children */
  cell: Cell<unknown> | undefined;

  /** Cancel function for the children subscription */
  cancel: Cancel;
}

/**
 * Ambient CFC render policy while walking a VDOM subtree.
 */
export interface RenderPolicy {
  /**
   * Confidentiality atoms allowed to render in this subtree.
   * Undefined means no render-time confidentiality bound is active.
   */
  maxConfidentiality?: readonly CfcConfClause[];

  /**
   * Caveat kinds admitted by the host's default render ceiling (spec
   * §8.10.6): a Caveat-type confidentiality atom renders when its `kind` is
   * listed here even if the atom is not in `maxConfidentiality`. Inherited
   * unchanged through authored boundaries — narrowing narrows
   * `maxConfidentiality`, never widens kinds.
   */
  caveatKindAllow?: readonly string[];

  /**
   * Confidentiality atoms this subtree may declassify before applying the max bound.
   * This is a temporary low-level capability hook for trusted UI experiments.
   */
  declassifyConfidentiality: readonly CfcConfClause[];

  /**
   * Integrity required for user-visible text in this subtree.
   * Undefined means descendant text is not integrity-gated.
   */
  textIntegrity?: {
    requiredIntegrity: readonly CfcAtom[];
    allowLiteralText: boolean;

    /**
     * The enclosing text-integrity boundaries this policy applies to, innermost
     * included. A block under this policy is attributed to every id in the set
     * so each enclosing boundary can observe it. Composed (not replaced) as
     * boundaries nest — see childRenderPolicyForNode — so an inner boundary can
     * only tighten, never relax, an enclosing one.
     */
    boundaryNodeIds: ReadonlySet<number>;
  };
}

/**
 * State tracked for each rendered node in the worker reconciler.
 * This is used to manage subscriptions and track DOM node IDs.
 */
export interface NodeState {
  /** Unique ID for this node, used to reference the DOM element */
  nodeId: number;

  /** Tag name of the element */
  tagName: string;

  /** Cancel function for any subscriptions on this node */
  cancel: Cancel;

  /** Child states, keyed by their stable key */
  children: Map<string, ChildNodeState>;

  /** Props subscriptions - now tracks Cell reference for diffing */
  propSubscriptions: Map<string, PropState>;

  /** Event handler IDs registered on this node */
  eventHandlers: Map<string, number>;

  /** Children Cell reference for diffing during updates */
  childrenState?: ChildrenState;

  /** Track child order to optimize inserts */
  childOrder: string[];

  /** Ambient policy that applied to this node itself. */
  renderPolicy: RenderPolicy;

  /** Policy that should apply to this node's descendants. */
  childRenderPolicy: RenderPolicy;

  /** Whether this node's own render-policy boundary blocked its children. */
  childrenBlockedByPolicy: boolean;

  /** Original authored children, before any render-policy placeholder rewrite. */
  sourceChildren?: WorkerVNode["children"];

  /** Original authored props, used to recompute child render policy. */
  sourceProps?: WorkerVNode["props"];

  /**
   * Whether this node is the `span` the reconciler wraps a child position's
   * array in, rather than an element the author wrote. (The `cf-fragment` an
   * array renders as at a node position of its own does not carry this.) Only
   * a wrapper may be reused for a new array: an authored element that happens
   * to share the wrapper's tag holds the author's props and children, not a
   * list.
   */
  isArrayWrapper?: boolean;

  /**
   * The space this node's descendants inherit — the one stamped on this node
   * if it stamped one, and otherwise whatever it inherited itself. Rendering
   * more children into an existing node has to restore this, or they re-stamp
   * a space their parent already carries.
   */
  childEmittedSpace?: string;

  /** Text-integrity boundaries that blocked this whole rendered node. */
  textIntegrityBlockedFor?: ReadonlySet<number>;

  /** Text-integrity boundaries that blocked each visible prop on this node. */
  textIntegrityBlockedProps?: Map<string, ReadonlySet<number>>;
}

/**
 * State for a child node, which may be an element or text node.
 */
export interface ChildNodeState {
  /** The node's unique ID */
  nodeId: number;

  /** Whether this is a text node */
  isText: boolean;

  /** Cancel function for subscriptions */
  cancel: Cancel;

  /** For element nodes, the full node state */
  elementState?: NodeState;

  /** Track current value for deduping updates */
  currentValue?: unknown;

  /** Source cell for reactive child nodes; used to decide same-key reuse. */
  cell?: Cell<unknown>;

  /** Whether this element provides a piece boundary to its descendants. */
  hasPieceBoundary?: boolean;
}

/**
 * Context passed through the reconciliation process.
 */
export interface ReconcileContext {
  /**
   * The space of the cell whose render produced the current subtree.
   * Changes at cell-follow boundaries (renderCellChild) — including
   * cross-space transclusion, where a piece renders another piece's UI.
   */
  space?: string;

  /**
   * The space stamped on the nearest ancestor create-element op.
   * Elements only carry `space` when it differs from this (seefeldb's
   * elision: leave it off when the parent's space is the same).
   */
  emittedSpace?: string;

  /** Function to emit VDOM operations */
  emit: (
    ops: VDomOp[],
  ) => void;

  /** Generate a new unique node ID */
  nextNodeId: () => number;

  /** Register an event handler and get its ID */
  registerHandler: (
    handler: (event: unknown) => void,
  ) => number;

  /** Get handler by ID for event dispatch */
  getHandler: (
    handlerId: number,
  ) => ((event: unknown) => void) | undefined;

  /** Optional document for SSR or testing */
  document?: Document;
}

/**
 * Whether author-supplied `declassifyConfidentiality` on a
 * `<cf-cfc-render-boundary>` is honored.
 *
 * `declassifyConfidentiality` lets a render boundary release a confidentiality
 * atom so a labeled cell renders despite the active `maxConfidentiality` bound.
 * It is read from static/reactive VDOM props, so ANY pattern can declassify ANY
 * secret it can render — the unguarded-release shape ch. 5 forbids (audit S15).
 *
 * - `"allow"` (default): honor it — the current behavior, pending a verified-
 *   authority design / product decision on the default render policy.
 * - `"deny"`: ignore author-supplied declassification entirely. A boundary may
 *   still NARROW the confidentiality bound (`maxConfidentiality`), it just can't
 *   release a secret upward.
 *
 * The narrowing-vs-release asymmetry is the point: `deny` removes only the
 * fail-open capability, never the fail-closed one.
 */
export type RenderDeclassificationPolicy = "allow" | "deny";

/**
 * Normalize an untrusted render-declassification policy value.
 *
 * The policy is a security knob that crosses postMessage seams (e.g.
 * `InitializationData`) with no runtime validation, so a typo'd host config or
 * a version-skewed peer could otherwise silently fail OPEN to `"allow"`. A
 * present-but-unknown value therefore normalizes to `"deny"` (fail closed);
 * only an absent value keeps the documented `"allow"` default.
 */
export function normalizeRenderDeclassificationPolicy(
  value: unknown,
): RenderDeclassificationPolicy {
  if (value === undefined) return "allow";
  return value === "allow" ? "allow" : "deny";
}

/**
 * Host-supplied default render ceiling (spec §8.10.6, S16 phase D): the
 * confidentiality a display surface admits when no authored boundary
 * narrows further. `atoms` are admitted by structural equality (the place
 * for acting-user identity atoms); `caveatKinds` admits Caveat-type atoms
 * by kind (the display-dischargeable classes). Everything else renders as
 * the blocked placeholder. Undefined = no default ceiling (today's
 * behavior); the profile may only be tightened, not loosened, without a
 * new release judgment.
 */
export interface RenderConfidentialityCeiling {
  atoms?: readonly CfcConfClause[];
  caveatKinds?: readonly string[];
}

/**
 * Normalize an untrusted render-confidentiality ceiling.
 *
 * Like the declassification policy, the ceiling crosses postMessage seams
 * (e.g. `InitializationData`) with no runtime validation. Fail-closed here
 * means a present-but-malformed value becomes the EMPTY ceiling (public-only
 * rendering) — never a mount crash, and never fail-open to unbounded. Only
 * an absent value keeps the documented no-ceiling default; malformed fields
 * inside an otherwise well-formed ceiling drop to empty individually.
 */
export function normalizeRenderConfidentialityCeiling(
  value: unknown,
): RenderConfidentialityCeiling | undefined {
  if (value === undefined) return undefined;
  if (!isObjectOrArray(value)) return {};
  const { atoms, caveatKinds } = value as {
    atoms?: unknown;
    caveatKinds?: unknown;
  };
  return {
    atoms: Array.isArray(atoms) ? atoms as readonly CfcConfClause[] : [],
    caveatKinds: Array.isArray(caveatKinds)
      ? caveatKinds.filter((kind): kind is string => typeof kind === "string")
      : [],
  };
}

/** Authoritative session access for rendered cells and their followed targets. */
export interface SpaceAccessProvider {
  /** Current authoritative access loss, if any, for the named space. */
  error(space: string): Error | undefined;

  /** Observes loss and recovery; the current snapshot is read through `error()`. */
  subscribe(space: string, onChange: () => void): Cancel;
}

/** Options for a worker-side renderer and its host authority boundaries. */
export interface WorkerReconcilerOptions {
  /** Callback when operations are ready to send to main thread */
  onOps: (
    ops: VDomOp[],
  ) => number | void;

  /** Optional: callback when an error occurs */
  onError?: (error: Error) => void;

  /** Authoritative session access, independent of cell confidentiality labels. */
  spaceAccess?: SpaceAccessProvider;

  /**
   * Policy for honoring author-supplied render-boundary declassification.
   * Defaults to `"allow"` (no behavior change). See
   * {@link RenderDeclassificationPolicy}.
   */
  renderDeclassificationPolicy?: RenderDeclassificationPolicy;

  /**
   * Default render ceiling applied at the tree root. Defaults to undefined
   * (no ceiling — today's behavior). See
   * {@link RenderConfidentialityCeiling}.
   */
  renderConfidentialityCeiling?: RenderConfidentialityCeiling;

  /**
   * Runner-side resolver (Epic H3b) that rewrites a cell's confidentiality
   * label through the display-boundary exchange rules (spec §8.10.6) before
   * the ceiling fit check — the seam that admits `Space(...)`-via-`HasRole`
   * principal forms. When absent, the ceiling admits by exact structural
   * equality only (H3a behavior). Evaluation happens here, RUNNER-side; the
   * reconciler only fits the resolved label against the ceiling.
   */
  resolveRenderConfidentiality?: RenderConfidentialityResolver;

  /**
   * The §4.9.3 membership provider backing {@link resolveRenderConfidentiality}
   * (Stage 2 reactive upgrade). When present, a rendered cell labeled
   * `Space(X)` subscribes to X's ACL doc within its cancel group, so a
   * fail-closed over-block (X's ACL not yet synced) re-renders to an admit once
   * the ACL arrives — and a later revoke re-blocks. Absent → no reactive
   * upgrade (Stage-1 sync snapshot only; still sound, just less precise).
   */
  membershipProvider?: SpaceMembershipProvider;
}

/**
 * Reference to a cell for bidirectional binding.
 * This is sent to the main thread so it can create a CellHandle.
 */
export interface BindingCellRef {
  cellRef: CellRef;
  schema?: JSONSchema;
}
