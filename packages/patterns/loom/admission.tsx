/**
 * The one handler that admits panel occurrences and records who added them,
 * with the panel checks it shares with the rest of the root.
 */
import {
  type AuthoredByCurrentUser,
  type Cfc,
  type CurrentPrincipal,
  currentPrincipal,
  type DID,
  handler,
  principalsOf,
  type RepresentsCurrentUser,
  spaceAccess,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import type { ParticipantProfile } from "./participants.tsx";
import type { Panel, PanelAdmission } from "./schemas.tsx";

/**
 * The DID of the principal who added a panel.
 *
 * When `admitPanel` writes it, the value is the principal its event acted for,
 * as `currentPrincipal()` returns it, and the runtime stores a declared label
 * entry at the field carrying `authored-by` for that same principal. Nothing
 * in the event chooses either. Once the root has written it, a write to the
 * field from any other handler is refused. A value an occurrence held before
 * `admitPanel` linked it is its writer's claim: the entry there, when the run
 * that wrote it minted one, names that writer rather than whomever the value
 * names.
 */
export type PanelAdderDid = AuthoredByCurrentUser<
  WriteAuthorizedBy<string, typeof admitPanel>
>;

/**
 * The profile under which the person who added a panel acted.
 *
 * Only `admitPanel` writes it. The runtime stores a declared label entry at
 * the field carrying `represents-principal` for the principal whose action
 * wrote it, resolving that principal itself. The panel also stores copies of
 * the linked profile's label, marked `origin: "link"`, which name the
 * profile's owner; the README says how a reader tells the two apart.
 */
export type PanelAdderProfile = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<ParticipantProfile, typeof admitPanel>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

/**
 * What an `admitPanel` binding does with its event: register a piece, add an
 * occurrence the caller made (a copy of it when the event names a profile), or
 * add a copy of an occurrence.
 */
export type AdmissionMode = "piece" | "panel" | "duplicate";

/** Locate an insertion anchor in the transaction's current collection. */
export function insertionIndex(
  list: readonly Writable<Panel>[],
  before?: Writable<Panel>,
): number {
  if (before === undefined) return list.length;
  const index = list.findIndex((panel) => panel.equals(before));
  if (index < 0) {
    throw new Error("The insertion anchor is no longer in this Loom");
  }
  return index;
}

/** Return an absolute HTTP(S) URL that contains no embedded credentials. */
export function externalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" || url.password !== ""
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * A DID in W3C DID Core syntax: `did:`, a lowercase method, and a
 * method-specific identifier of colon-separated segments drawn from letters,
 * digits, `.`, `-`, `_` and percent-encodings, the last segment nonempty.
 */
const DID_SYNTAX =
  /^did:[a-z0-9]+:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/;

/**
 * Whether `value` is a DID a panel may name as its adder: a DID of at most 195
 * characters, so that the adder's `peer:<did>` actor fits the service's
 * 200-character bound.
 */
function isAdderDid(value: string): boolean {
  return value.length <= 195 && DID_SYNTAX.test(value);
}

/** Validate a panel before admitting its occurrence to the shared composition. */
function validatePanel(panel: Panel): void {
  if (panel.kind === "url" && externalUrl(panel.url) === undefined) {
    throw new Error("A URL panel requires an HTTP(S) URL without credentials");
  }
  if (panel.addedBy !== undefined && !isAdderDid(panel.addedBy)) {
    throw new Error(
      "A panel's addedBy must be a DID of at most 195 characters",
    );
  }
}

/** Compare piece membership by complete link identity, including scope and space. */
function containsPiece(
  list: readonly Writable<Panel>[],
  piece: Writable<unknown>,
): boolean {
  return list.some((panel) => {
    const value = panel.get();
    return value.kind === "piece" && value.piece.equalLinks(piece);
  });
}

/** `list` with `panel` inserted at `index`. */
function withInserted(
  list: readonly Writable<Panel>[],
  index: number,
  panel: Writable<Panel>,
): Writable<Panel>[] {
  return [...list.slice(0, index), panel, ...list.slice(index)];
}

/** Whether `panel` is one of the occurrences in `list`. */
function containsOccurrence(
  list: readonly Writable<Panel>[],
  panel: Writable<Panel>,
): boolean {
  return list.some((existing) => existing.equals(panel));
}

/**
 * The adder fields a new occurrence takes: the profile the event acts under,
 * or else the principal the event acted for. A run that acts for no one
 * records neither.
 */
function adderFields(
  event: PanelAdmission,
): Pick<Panel, "addedBy" | "addedByProfile"> {
  // The terminal cell is pinned so the panel names this profile, not whatever
  // an alias later resolves to.
  if (event.as !== undefined) {
    return { addedByProfile: event.as.resolveAsCell() };
  }
  const principal = currentPrincipal();
  return principal === undefined ? {} : { addedBy: principal };
}

/**
 * Returns the principals attested on `panel`'s `addedBy` field: none for a
 * field no stamp names, and `undefined` when a claim there is in a form a
 * runtime does not mint. The stamp is the one on the field itself: a value
 * link stored there leads to a document with a label of its own, which says
 * nothing about who wrote the field. Other fields can have their own authors
 * without changing who added the occurrence.
 */
function attestedAdders(panel: Writable<Panel>): DID[] | undefined {
  return principalsOf(panel.key("addedBy"), "authored-by", {
    followLink: false,
  });
}

/**
 * Throws unless the principal the running event acts for may remove `panel`
 * for everyone: an occurrence its label attests to that principal alone, one
 * it attests to nobody, or, for an OWNER of the Loom's space, one it attests
 * to a principal the space's access list no longer admits. The adder is read
 * from the runtime's stamps on the occurrence's own fields, `authored-by` at
 * `addedBy` and `represents-principal` at `addedByProfile`, where the stamp
 * names whoever acted under the profile, never the linked profile's owner.
 * An `addedBy` value no stamp names is its writer's claim, and protects
 * nothing; nor does a label that names two principals, or holds a claim in a
 * form no runtime mints, since it settles on nobody whose contribution the
 * rule could keep.
 */
export function assertRemovable(panel: Writable<Panel>): void {
  const direct = attestedAdders(panel);
  const underProfile = principalsOf(
    panel.key("addedByProfile"),
    "represents-principal",
    { followLink: false },
  );
  const adders = direct === undefined || underProfile === undefined
    ? []
    : [...new Set([...direct, ...underProfile])];
  if (adders.length !== 1) return;
  const [adder] = adders;
  const actor = currentPrincipal();
  if (adder === actor) return;
  // An owner clears up after a participant who has left: one the list grants
  // nothing, as the list stands on this replica. A list not yet read admits
  // nobody's removal of another's panel.
  if (
    spaceAccess(panel) === "OWNER" && spaceAccess(panel, adder) === "none"
  ) return;
  throw new Error(
    "Only the principal who added a panel can remove it, unless they have left the Loom and an OWNER removes it",
  );
}

/** A copy of `source` that keeps its target and title and takes a new adder. */
function copyOf(source: Panel, event: PanelAdmission): Panel {
  // A copy is added by whoever duplicates it: the adder comes from the event,
  // never from the source.
  const fields = {
    ...(source.titleOverride === undefined
      ? {}
      : { titleOverride: source.titleOverride }),
    ...adderFields(event),
  };
  return source.kind === "piece"
    ? { kind: "piece", piece: source.piece, ...fields }
    : source.kind === "document"
    ? { kind: "document", content: source.content, ...fields }
    : { kind: "url", url: source.url, ...fields };
}

/**
 * Inserts at `index` a new occurrence copied from `source` and attributed to
 * the event's adder. The handler invocation supplies the cause, so replay
 * addresses this same occurrence.
 */
function admitCopy(
  panels: Writable<Writable<Panel>[]>,
  list: readonly Writable<Panel>[],
  index: number,
  source: Panel,
  event: PanelAdmission,
): void {
  const copy = copyOf(source, event);
  validatePanel(copy);
  const occurrence = new Writable<Panel>();
  occurrence.set(copy);
  panels.set(withInserted(list, index, occurrence));
}

/**
 * Admits one panel occurrence to the Loom and records who added it.
 *
 * It is the only handler that may write a panel's `addedByProfile` or
 * `addedBy`, so every stream that adds a panel is a binding of it, and `mode`
 * says which. An event's `as` is the profile under which the person adding
 * acts; it is linked into an occurrence this handler creates, never into a
 * document the caller passed, and the runtime labels it with the principal who
 * acted. An occurrence this handler creates without `as` records that
 * principal in `addedBy` instead, attested the same way. Nothing in the event
 * names the adder.
 *
 * The body touches the occurrences in `panels` only through helpers. Its
 * state schema is inferred from the uses the body shows, and an occurrence
 * compared with `equals` or moved with `splice` there would be narrowed to a
 * cell whose value the piece registration can no longer read.
 */
export const admitPanel = handler<
  PanelAdmission,
  { panels: Writable<Writable<Panel>[]>; mode: AdmissionMode }
>((event, { panels, mode }) => {
  const list = panels.get();
  if (mode === "piece") {
    const piece = event.piece;
    if (piece === undefined) throw new Error("addPiece requires a piece");
    if (containsPiece(list, piece)) return;
    const value: Panel = { kind: "piece", piece, ...adderFields(event) };
    validatePanel(value);
    const panel = new Writable<Panel>();
    panel.set(value);
    panels.set([...list, panel]);
    return;
  }
  const panel = event.panel;
  if (panel === undefined) throw new Error("A panel event requires a panel");
  if (mode === "panel") {
    const index = insertionIndex(list, event.before);
    // A panel already present is not admitted again, so there is nothing to
    // validate or record.
    if (containsOccurrence(list, panel)) return;
    const value = panel.get();
    validatePanel(value);
    if (event.as !== undefined) {
      // A profile is recorded only on an occurrence this handler creates, so
      // `as` admits a copy of the one passed, as `duplicate` does. Writing it
      // into the document passed would change who added that occurrence
      // wherever else it is shown, and the document may be another Loom's.
      admitCopy(panels, list, index, value, event);
      return;
    }
    // An occurrence that already names a profile is not linked again: one
    // this handler recorded carries the label of whoever added it then, to
    // this Loom or to another, so linking it would attribute this admission to
    // them.
    if (value.addedByProfile !== undefined) {
      throw new Error(
        "A panel that already records its adder's profile cannot be added again",
      );
    }
    // Nor is one whose attested adder is another principal, for the same
    // reason, nor one whose label contests its adder or names it in a form
    // no runtime mints. The principal admitting it may link an occurrence
    // attested to them alone, and one that names its adder only by claim.
    const adders = attestedAdders(panel);
    const actor = currentPrincipal();
    if (adders === undefined || adders.some((adder) => adder !== actor)) {
      throw new Error(
        "A panel another principal added, or whose adder its label contests, cannot be linked; add a copy of it with `as` instead",
      );
    }
    panels.set(withInserted(list, index, panel));
    return;
  }
  if (!containsOccurrence(list, panel)) {
    throw new Error("The panel is no longer in this Loom");
  }
  const index = insertionIndex(list, event.before);
  admitCopy(panels, list, index, panel.get(), event);
});
