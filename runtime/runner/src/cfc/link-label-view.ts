/**
 * The `cfcLabelView` side-channel that rides on a cell link's inner: the two
 * accessors for the view on a single link, and the walk that removes every
 * view from a whole inbound value.
 *
 * A view is display state rather than part of what a link addresses, and that
 * is what makes the two directions different rather than symmetric. Outbound,
 * the view may be shown but the caveat sources behind it may not, so the
 * conversion that mints a link for the main thread attaches the view's display
 * form to it, and no walk runs after the fact. Inbound, a view is an untrusted
 * artifact that must not become worker label state, so it is removed
 * outright.
 */

import {
  FabricInstance,
  FabricPrimitive,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { CellLinkRefPayload, SigilLink } from "../sigil-types.ts";
import type { CfcLabelView } from "./label-view-core.ts";

/**
 * A cell-link payload that additionally carries a CFC label view. The label
 * view is a CFC-owned side-channel smuggled on the link inner: producers write
 * it and the flow-control machinery reads it back. Keeping it out of the base
 * {@link CellLinkRefPayload} (and confined to this cfc module) is deliberate —
 * it is not part of the link's addressing identity, and link normalization /
 * equality ignore it.
 */
export type CfcCellLinkRefPayload = CellLinkRefPayload & {
  cfcLabelView?: CfcLabelView;
};

/** Reads the CFC label view carried on a sigil link, if any. */
export function linkCfcLabelView(link: SigilLink): CfcLabelView | undefined {
  return (linkRefPayload(link) as CfcCellLinkRefPayload).cfcLabelView;
}

/**
 * Returns a sigil link which is `link` with `view` attached to its inner as the
 * CFC label view, replacing any view it already carried. `link` is left as it
 * is: a link's inner is fixed once the link is made.
 */
export function withLinkCfcLabelView(
  link: SigilLink,
  view: CfcLabelView,
): SigilLink {
  return linkRefFrom<CfcCellLinkRefPayload>({
    ...(linkRefPayload(link) as CfcCellLinkRefPayload),
    cfcLabelView: view,
  });
}

/**
 * Remove every `cfcLabelView` riding a sigil link inside an INBOUND value
 * (inv-12 Stage 0): views arriving from the main thread are untrusted display
 * artifacts and must not become worker label state or link-write policy
 * inputs. `cellRefToSigilLink` already refuses to forward ref-carried views,
 * but raw sigil links bypass the CellRef path — hand-crafted JSON in write
 * values, and CellHandles serialized into `CustomEvent.detail` via `toJSON`
 * re-entering through the VDOM event ingress.
 *
 * Copy-on-write: unchanged subtrees are returned by reference, so a value
 * holding no view comes back as the same instance.
 *
 * A value that contains itself is refused, with the path at which the cycle
 * closes. A subtree reachable from two positions is shared rather than
 * cyclic, and is walked at each.
 *
 * A `FabricPrimitive` comes back as the same instance, correctly: a leaf holds
 * no sigil link for this to rewrite. A `FabricInstance` is refused, since
 * passing one through would leave a view riding a link inside it untouched.
 *
 * @throws If the value contains a cycle, or a `FabricInstance`.
 */
export function stripSigilCfcLabelViews(value: unknown): unknown {
  return stripOne(value, [], new IndexTrackingStack<object>());
}

/**
 * Recursive worker for {@link stripSigilCfcLabelViews}, carrying the state of
 * the walk in progress. `path` is the way from the root to `value`, held as
 * one array the walk pushes to and pops from. `ancestors` holds the containers
 * the walk is inside, so that what it recognizes is a cycle: an entry sits
 * there only while the walk is inside it, and a container reached again by a
 * different path is not there any more.
 */
function stripOne(
  value: unknown,
  path: string[],
  ancestors: IndexTrackingStack<object>,
): unknown {
  if (isLinkRef(value)) {
    const payload = linkRefPayload(
      value as SigilLink,
    ) as CfcCellLinkRefPayload;
    if (payload.cfcLabelView === undefined) {
      return value;
    }
    const { cfcLabelView: _cfcLabelView, ...clean } = payload;
    return linkRefFrom<CfcCellLinkRefPayload>(clean);
  }
  // A `FabricPrimitive` is `isObjectOrArray` and leaves ahead of the record
  // branch. It holds no sigil link, so returning it whole is the answer.
  if (value instanceof FabricPrimitive) return value;

  // A `FabricInstance` is refused. Its codec contents can carry a sigil link
  // with a `cfcLabelView` riding it, and those contents are not reachable by
  // property name -- so passing one through leaves that view in place. That
  // is the inv-12 Stage 0 boundary failing open: an untrusted view arriving
  // from the main thread survives into worker label state, which is the one
  // thing the strip exists to prevent.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction: a `FabricError` is ungated and exposed to pattern authors, so
  // what keeps this safe is that nothing yet routes one through this ingress.
  //
  // TODO(danfuzz): descend by codec-mediated traversal into instance state, at
  // which point this becomes a walk rather than a refusal.
  if (value instanceof FabricInstance) {
    refuseFabricInstance(value, "when stripping sigil CFC label views");
  }

  if (!isObjectOrArray(value)) {
    return value;
  }

  // A container. It goes onto `ancestors` for as long as the walk is inside
  // it, and every way out below clears it again.
  if (ancestors.has(value)) {
    throw new Error(
      "Cannot strip sigil CFC label views from a value with a cycle; " +
        `the cycle closes at path \`${path.join(".")}\`.`,
    );
  }
  ancestors.push(value);

  try {
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item, index) => {
        path.push(String(index));
        const next = stripOne(item, path, ancestors);
        path.pop();
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      path.push(key);
      const next = stripOne(item, path, ancestors);
      path.pop();
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  } finally {
    ancestors.popExpect(value);
  }
}
