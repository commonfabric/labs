import {
  Cell,
  Cfc,
  computed,
  CurrentPrincipal,
  Default,
  equals,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  RepresentsCurrentUser,
  RequiresIntegrity,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

export const TRUSTED_PROFILE_HOME_SURFACE = "ProfileHome";
export const TRUSTED_PROFILE_EDIT_ACTION = "EditProfile";

type OwnerProtectedProfileWrite<
  T,
  Binding,
> = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<T, Binding>,
    {
      ownerPrincipal: CurrentPrincipal;
    }
  >
>;

type ProfileElementCell = {
  [NAME]?: string;
};

// NOTE(CT-1628): `cell: any` here/below and the `(Pattern(...) as any).for(...)`
// casts later in this file are required until the CFC wrapper / pattern-factory
// types expose a typed cell ref and `.for()`. Tracked for a proper type fix.
export type ProfileElement = {
  cell: any;
  tag: string;
  userTags: readonly string[];
  title?: string;
  source?: "catalog" | "url" | "piece";
};

export type AddProfileElementEvent = {
  catalogId?: string;
  patternUrl?: string;
  title?: string;
  tag?: string;
  userTags?: readonly string[];
};

export type RemoveProfileElementEvent = {
  cell: any;
};

/**
 * The single event shape for every element mutation (see `mutateElements`):
 * a `cell` (from the event or the instance's bound state) removes that
 * element; a `patternUrl` (or a bound link form) adds a link reference card;
 * otherwise a catalog card is added. `AddProfileElementEvent` /
 * `RemoveProfileElementEvent` are subsets kept for the exported stream types.
 */
export type MutateProfileElementsEvent = {
  catalogId?: string;
  patternUrl?: string;
  title?: string;
  tag?: string;
  userTags?: readonly string[];
  cell?: any;
  // "addPiece" inputs: a link to an EXISTING deployed piece (CT-1755). The
  // card becomes a followable reference to the live piece rather than a local
  // title-only placeholder. `pieceSpace` is the target space DID; `pieceId` is
  // the piece id (with or without the `of:` prefix).
  pieceSpace?: string;
  pieceId?: string;
};

export type SetProfileNameEvent = {
  name?: string;
  detail?: { message?: string };
  key?: string;
  target?: { value?: string };
};

export type SetProfileAvatarEvent = {
  avatar?: string;
  detail?: { message?: string };
  key?: string;
  target?: { value?: string };
};

export type SetProfileBioEvent = {
  bio?: string;
  detail?: { message?: string };
  key?: string;
  target?: { value?: string };
};

/** A public link to a profile the owner maintains elsewhere, such as GitHub,
 * LinkedIn, or a personal site. Links are deliberately data, not profile
 * elements: unlike an element, an external link does not create or reference a
 * Common Fabric piece. */
export type ExternalProfileLink = {
  label: string;
  url: string;
};

export type MutateExternalProfileLinksEvent = {
  label?: string;
  url?: string;
};

/**
 * An external account identifier observed by Loom after that connector
 * successfully authenticated as the profile owner. Stable and human-facing
 * identifiers are separate assertions (for example `github.node_id` and
 * `github.login`) so consumers can use either without weakening provenance.
 *
 * Keep this tuple deliberately small: the integrity label covers the identity
 * type, value, and observation time together. Connector/provider metadata that
 * is not part of the assertion belongs in the writer event, not this record.
 */
export type ExternalIdentityAssertion = {
  type: string;
  value: string;
  verifiedAt: string;
};

/**
 * A system integrity atom (`CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM`, spelled
 * out because the schema lowering reads only a local literal): the runtime
 * keeps it only on a write authored by a trusted builtin, so the writer of an
 * assertion must attribute its transaction to one, and a profile cannot
 * collect a self-asserted identity.
 */
export const LOOM_VERIFIED_EXTERNAL_IDENTITY_INTEGRITY =
  "loom-verified-external-identity" as const;

export type VerifiedExternalIdentity = RequiresIntegrity<
  ExternalIdentityAssertion,
  readonly [typeof LOOM_VERIFIED_EXTERNAL_IDENTITY_INTEGRITY]
>;

export type VerifiedExternalIdentityCell = Cell<VerifiedExternalIdentity>;

/** What the profile knows of its share inbox piece: its name, at most. */
export type ShareInboxPiece = {
  [NAME]?: string;
};

/**
 * Where things shared with this profile's owner are delivered: a link to the
 * owner's share inbox piece — the piece whose `receive` stream other daemons
 * call, in the dedicated inbox space the owner's daemon minted (loom
 * `shares/inbox.py`; the design is loom's weaver-multiuser-sharing D8 and
 * share-inbox proposal). The link names the piece and its space together;
 * it carries no memory host because the inbox lives on the host the profile
 * pointing at it lives on, so a reader uses the host it read the profile
 * from. Public on purpose and no secret in it: the inbox space's ACL is the
 * gate, the link only says where to knock. Stored as the `link@1` sigil,
 * `{ "/": { "link@1": { id: "of:…", space: "did:key:…", path: [] } } }`,
 * the same form the profile's pinned-piece elements take; `piece` is absent
 * when the owner has no inbox.
 *
 * The link sits under a key rather than being the stored value itself
 * because a write to a cell whose document root holds a link goes through
 * the link into the piece it names, so a pointer stored bare could be set
 * once and never re-pointed or cleared. Under a key, a new link re-binds the
 * slot and an omitted key removes it.
 */
export type ProfileInbox = {
  /** The owner's share inbox piece. */
  piece?: Cell<ShareInboxPiece>;
};

export type SetProfileInboxEvent = {
  /** The inbox piece to point at; absent clears the pointer. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // handler's event schema marks a reference position only where the wrapper
  // is spelled in the event type, and through an alias the member compiles
  // to the piece's value shape, so the handler is handed a value instead of
  // the link it stores.
  inbox?: Cell<ShareInboxPiece>;
};

type VerifiedIdentityListWrite<Binding> = OwnerProtectedProfileWrite<
  VerifiedExternalIdentityCell[],
  Binding
>;

export type MutateVerifiedIdentitiesEvent = {
  identities?: readonly VerifiedExternalIdentityCell[];
};

export type ProfileHomeOutput = {
  [NAME]: string;
  [UI]: VNode;
  name: OwnerProtectedProfileWrite<string, typeof setName>;
  avatar: OwnerProtectedProfileWrite<string, typeof setAvatar>;
  // A short, human-authored free-text description of the profile owner
  // (CT-1648). Owner-protected like name/avatar; the canonical shared-profile
  // bio (distinct from Home's legacy `learned.summary`). Readable from the
  // profile result and via `wish({ query: "#profileBio" })`.
  // Default outside the wrapper, like externalLinks below: bio arrived
  // 2026-06-17, so stored profiles predating it have no such property — a
  // required field here fails consumer argument validation on those docs
  // (masked until now only because `addExternalLink` sorts earlier in the
  // required check).
  bio: Default<OwnerProtectedProfileWrite<string, typeof setBio>, "">;
  // The owner's share inbox pointer. Owner-protected like bio; readable by
  // anyone who can read the profile, which is what a sender needs. OPTIONAL
  // rather than defaulted, unlike bio: a stored profile predating the field
  // has no such property, and a profile with no inbox holds a pointer with
  // no `piece`. A running profile always binds it.
  inbox?: OwnerProtectedProfileWrite<ProfileInbox, typeof setInbox>;
  // Public web profiles the owner has chosen to associate with this profile.
  // The owner-protected list is distinct from `elements`, whose entries are
  // Common Fabric piece references.
  // The default is outside the CFC wrapper: an old profile has no stored
  // property, while new profiles get an empty owner-protected list. Putting
  // the default inside the wrapper produces divergent CFC union branches when
  // a home appends more than one profile.
  externalLinks: Default<
    OwnerProtectedProfileWrite<
      ExternalProfileLink[],
      typeof mutateExternalProfileLinks
    >,
    []
  >;
  // Connector-observed account identifiers. The list contains the original
  // assertion cells, each of which must already carry Loom's integrity label.
  // This pattern only collects those capabilities; it never mints or copies
  // their integrity-bearing values.
  verifiedIdentities: Default<
    VerifiedIdentityListWrite<typeof publishVerifiedIdentities>,
    []
  >;
  elements: OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>;
  // The mutation streams are REQUIRED here on purpose: this type describes
  // what a RUNNING current profile provides, and a live profile always binds
  // every stream. Consumers that read stored profiles of any vintage must not
  // reuse this type — they take `BackwardsCompatibleProfile` (below), which
  // makes the post-genesis streams optional, because streams are affordances
  // and never exist on a stored doc that predates them.
  setName: Stream<SetProfileNameEvent>;
  setAvatar: Stream<SetProfileAvatarEvent>;
  setBio: Stream<SetProfileBioEvent>;
  setInbox: Stream<SetProfileInboxEvent>;
  addExternalLink: Stream<MutateExternalProfileLinksEvent>;
  removeExternalLink: Stream<MutateExternalProfileLinksEvent>;
  publishVerifiedIdentities: Stream<MutateVerifiedIdentitiesEvent>;
  revokeVerifiedIdentities: Stream<MutateVerifiedIdentitiesEvent>;
  // Both element streams accept the full mutation event (the union shape of
  // the one authorized writer); `AddProfileElementEvent` /
  // `RemoveProfileElementEvent` remain the documented per-stream subsets.
  addElement: Stream<MutateProfileElementsEvent>;
  removeElement: Stream<MutateProfileElementsEvent>;
  // Pin an existing deployed piece as a followable card (CT-1755).
  addPiece: Stream<MutateProfileElementsEvent>;
  // Flips the rendered profile view (CT-1748) between the read-only
  // presentation and the edit form. UI state — not owner-protected.
  toggleEditing: Stream<void>;
  // Current view mode: false = read-only presentation, true = edit form.
  // Data field, so backwards compatibility rides Default<> (like bio and
  // externalLinks): stored profiles predating CT-1748 (2026-06-16) have no
  // such property, and validation fills the default instead of failing.
  isEditing: Default<boolean, false>;
  initialNameApplied: string;
};

export type ProfileHomeInput = {
  initialName?: string;
};

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// The consumer-side view of a profile: every field a stored profile doc of ANY
// supported vintage satisfies. Streams added after profile genesis (2026-05-31,
// #3762) are optional here — a stored doc written before a stream existed has
// no such property, and a consumer schema that requires it bricks at argument
// validation (fleet incident 2026-07-22: `profiles: 0: missing required
// property addExternalLink` for June-era profiles). Genesis streams stay
// required: every doc has them.
//
// Standard idiom (seefeld, #4901 review): the producer type keeps its honest,
// required shape; consumers of stored docs take this weakened view and handle
// absence (`profile.addPiece?.send(...)`). ADD EVERY FUTURE STREAM TO THIS
// LIST in the same change that adds it to ProfileHomeOutput — a new stream
// missing here re-bricks old docs at every consumer seam.
// Introduction dates: setBio/addPiece 2026-06-17, toggleEditing 2026-06-16,
// external links #4731 and verified identities #4745 both 2026-07-15.
//
// The rendered screen is weakened here too, for the other reason a consumer
// view exists. `ProfileHomeOutput` names it `VNode`, which is what a reader of
// a profile's own result needs to reach the tree it holds. An argument
// declaration is checked the other way round: it has to keep accepting every
// value it accepted before, and a stored profile written under any earlier
// vintage of this type has to pass it. `unknown` accepts them all.
export type BackwardsCompatibleProfile = PartialBy<
  & Omit<ProfileHomeOutput, typeof UI>
  & { [UI]: unknown },
  | "setBio"
  | "setInbox"
  | "addExternalLink"
  | "removeExternalLink"
  | "publishVerifiedIdentities"
  | "revokeVerifiedIdentities"
  | "addPiece"
  | "toggleEditing"
>;

const trimInitialName = (initialName?: string): string =>
  (initialName ?? "").trim();

/** Only http(s) URLs may be rendered as links. This is enforced at write time
 * and again at render time because a profile can contain older stored data. */
const isSafeExternalProfileUrl = (url: string): boolean =>
  /^https?:\/\//i.test((url ?? "").trim());

/** The verified identity types a profile shows to people, with the provider
 * name and public profile URL each displays. A type absent here, such as the
 * stable `github.node_id`, stays in the list for consumers but is not
 * rendered. */
const DISPLAYED_IDENTITY_TYPES: Readonly<
  Record<string, { provider: string; profileUrlPrefix: string }>
> = {
  "github.login": {
    provider: "GitHub",
    profileUrlPrefix: "https://github.com/",
  },
};

const isDisplayedIdentityType = (type: string): boolean =>
  Object.hasOwn(DISPLAYED_IDENTITY_TYPES, type);

const identityProvider = (type: string): string =>
  DISPLAYED_IDENTITY_TYPES[type]?.provider ?? type;

/** How long after `verifiedAt` an assertion still counts as verified, the
 * consumer freshness window of the shared profile space spec. */
const VERIFIED_IDENTITY_FRESHNESS_MS = 48 * 60 * 60 * 1000;

/** Whether an assertion verified at `verifiedAt` is inside the freshness
 * window at `nowMs`. An unknown clock or an unreadable timestamp is not
 * fresh, so the profile shows nothing it cannot date. */
export const isFreshIdentity = (
  verifiedAt: string | undefined,
  nowMs: number | undefined,
): boolean => {
  if (typeof nowMs !== "number" || typeof verifiedAt !== "string") {
    return false;
  }
  const verifiedMs = Date.parse(verifiedAt);
  return Number.isFinite(verifiedMs) &&
    nowMs - verifiedMs <= VERIFIED_IDENTITY_FRESHNESS_MS;
};

export const isShownIdentity = (
  identity: Partial<ExternalIdentityAssertion> | undefined,
  nowMs: number | undefined,
): boolean =>
  isDisplayedIdentityType(identity?.type ?? "") &&
  isFreshIdentity(identity?.verifiedAt, nowMs);

export const identityProfileUrl = (type: string, value: string): string => {
  const prefix = DISPLAYED_IDENTITY_TYPES[type]?.profileUrlPrefix;
  return prefix === undefined ? "" : prefix + encodeURIComponent(value);
};

// One verified account in the profile presentation, or nothing for a type the
// profile does not display or an assertion outside the freshness window. The account name and the badge both bind the
// stored assertion's own `value` field, so the badge reports the Loom
// integrity label the runtime holds for the text shown beside it. The input
// takes the plain assertion type. Requiring the integrity atom here would put
// a write floor on the row's input that the `map` writing each list item into
// it cannot meet; the badge reports the atom instead.
export const VerifiedIdentityRow = pattern<
  { assertion: ExternalIdentityAssertion; nowMs: number | undefined },
  { [UI]: VNode; profileUrl: string }
>(
  ({ assertion, nowMs }) => {
    const displayed = computed(() => isShownIdentity(assertion, nowMs));
    const provider = computed(() => identityProvider(assertion.type));
    const profileUrl = computed(() =>
      identityProfileUrl(assertion.type, assertion.value)
    );
    return {
      profileUrl,
      [UI]: (
        <cf-fragment>
          {ifElse(
            displayed,
            <cf-hstack
              gap="2"
              align="center"
              data-ui-region="profile-verified-identity"
            >
              <cf-text variant="caption" tone="muted">{provider} ·</cf-text>
              <a href={profileUrl} target="_blank" rel="noopener noreferrer">
                {assertion.value}
              </a>
              <cf-cfc-label
                variant="badge"
                atom={LOOM_VERIFIED_EXTERNAL_IDENTITY_INTEGRITY}
                $value={assertion.value}
              />
            </cf-hstack>,
            null,
          )}
        </cf-fragment>
      ),
    };
  },
);

// The verified accounts in the profile presentation: one row per shown
// assertion, and nothing at all when none is shown, so an empty section adds
// no gap to the presentation. The input takes plain assertion cells for the
// same reason `VerifiedIdentityRow` takes a plain assertion.
export const VerifiedIdentitiesSection = pattern<
  {
    identities: Cell<ExternalIdentityAssertion>[];
    nowMs: number | undefined;
  },
  { [UI]: VNode; shown: boolean }
>(({ identities, nowMs }) => {
  const shown = computed(() =>
    identities.some((identity) => isShownIdentity(identity.get(), nowMs))
  );
  return {
    shown,
    [UI]: (
      <cf-fragment>
        {ifElse(
          shown,
          <cf-vstack gap="1" data-ui-region="profile-verified-identities">
            {identities.map((identity) => (
              <VerifiedIdentityRow assertion={identity} nowMs={nowMs} />
            ))}
          </cf-vstack>,
          null,
        )}
      </cf-fragment>
    ),
  };
});

const ProfileCatalogCard = pattern<{ title: string }, ProfileElementCell>(
  ({ title }) => ({
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="2" style={{ padding: "12px" }}>
        <strong>{title}</strong>
      </cf-vstack>
    ),
  }),
);

const UrlPatternReference = pattern<
  { title: string; url: string },
  ProfileElementCell
>(
  ({ title, url }) => ({
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="2" style={{ padding: "12px" }}>
        <strong>{title}</strong>
        <span style={{ color: "var(--cf-theme-color-text-secondary)" }}>
          {url}
        </span>
      </cf-vstack>
    ),
  }),
);

// Build a link to an EXISTING deployed piece in (possibly) another space
// (CT-1755). This is the canonical serialized cross-space link shape
// (`createSigilLinkFromParsedLink`'s output): a `link@1` sigil carrying the
// target piece id (URI form, `of:` prefix) and space DID. Stored as a
// `ProfileElement.cell`, it resolves to the live piece and renders as a
// followable `<cf-cell-link>` exactly like a `profiles[]` roster entry.
const pieceReferenceLink = (space: string, pieceId: string): unknown => {
  const id = pieceId.startsWith("of:") ? pieceId : `of:${pieceId}`;
  return { "/": { "link@1": { id, space, path: [] } } };
};

const appendElement = (
  element: ProfileElement,
  elements: Writable<ProfileElement[]>,
) => {
  const current = elements.get();
  if (current.some((existing) => equals(existing.cell, element.cell))) {
    return;
  }
  elements.push(element);
};

// THE single authorized writer for the owner-protected `elements` list. A
// `writeAuthorizedBy` claim carries exactly one handler binding, verified
// against the writing handler's implementation identity — so every element
// mutation (the exported add/remove streams, the catalog/link-form buttons,
// the per-row remove) must be an INSTANCE of this one implementation.
// Instances differ only in bound state — including the explicit `mode`
// below — which doesn't change the implementation identity.
const mutateElements = handler<
  MutateProfileElementsEvent,
  {
    elements: Writable<ProfileElement[]>;
    // Instance intent. Each binding site declares what its events may do, so
    // a malformed/empty event can never cross purposes (an empty remove must
    // not add; an empty link form must not add a catalog card):
    //   "add"     — the exported add stream: event-driven, url or catalog.
    //   "addCard" — the catalog button: one fixed "Profile card".
    //   "addLink" — the link form: reads (and clears) the bound form; no-op
    //               without a URL.
    //   "remove"  — the exported remove stream / per-row button: removes
    //               `event.cell ?? state.cell`; no-op without one.
    mode: "add" | "addCard" | "addLink" | "addPiece" | "remove";
    // Per-row remove binding ("remove" mode).
    cell?: any;
    // Link form binding ("addLink" mode).
    patternUrl?: Writable<string>;
    title?: Writable<string>;
    tag?: Writable<string>;
    userTags?: string[];
    // Pin-a-piece form binding ("addPiece" mode, CT-1755).
    pieceSpace?: Writable<string>;
    pieceId?: Writable<string>;
  }
>((event, state) => {
  const userTags = event.userTags ?? state.userTags ?? [];
  switch (state.mode) {
    case "remove": {
      const removeCell = event.cell ?? state.cell;
      if (removeCell === undefined) return;
      state.elements.set(
        state.elements.get().filter((element) =>
          !equals(element.cell, removeCell)
        ),
      );
      return;
    }
    case "addLink": {
      const url = (state.patternUrl?.get() ?? "").trim();
      if (url.length === 0) return;
      const title = (state.title?.get() ?? "").trim() || url;
      const tag = (state.tag?.get() ?? "").trim() || url;
      appendElement({
        cell: (UrlPatternReference({ title, url }) as any).for(tag),
        source: "url",
        title,
        tag,
        userTags,
      }, state.elements);
      state.patternUrl?.set("");
      state.title?.set("");
      state.tag?.set("");
      return;
    }
    case "addPiece": {
      // Prefer event fields (e.g. a "pin from the piece" flow that passes the
      // target directly); fall back to the bound form cells (the edit-mode
      // "Pin a piece" inputs).
      let space = (event.pieceSpace ?? state.pieceSpace?.get() ?? "").trim();
      let rawId = (event.pieceId ?? state.pieceId?.get() ?? "").trim();
      // Convenience: a full piece URL/path pasted into the space field is split
      // into space + id (the last two path segments). Only a DID-spaced URL
      // resolves cross-space — a space *name* can't be resolved to a DID from
      // pattern code, so paste the `did:key:…` form for another space.
      if (rawId.length === 0 && space.includes("/")) {
        const segments = space.replace(/^https?:\/\/[^/]+/, "").split("/")
          .filter((segment) => segment.length > 0);
        if (segments.length >= 2) {
          space = segments[segments.length - 2];
          rawId = segments[segments.length - 1];
        }
      }
      if (space.length === 0 || rawId.length === 0) return;
      const title = (event.title ?? state.title?.get() ?? "").trim() || rawId;
      // Tag by the piece id so the same piece can't be pinned twice (dedup in
      // appendElement is by `cell`; a stable tag keeps the row label sane).
      const tag = rawId;
      appendElement({
        cell: pieceReferenceLink(space, rawId),
        source: "piece",
        title,
        tag,
        userTags,
      }, state.elements);
      state.pieceSpace?.set("");
      state.pieceId?.set("");
      state.title?.set("");
      return;
    }
    case "addCard": {
      appendElement({
        cell: (ProfileCatalogCard({ title: "Profile card" }) as any).for(
          "profile-card",
        ),
        source: "catalog",
        title: "Profile card",
        tag: "#profileCard",
        userTags,
      }, state.elements);
      return;
    }
    case "add": {
      const source = event.patternUrl ? "url" : "catalog";
      const title = event.title ??
        (source === "url"
          ? event.patternUrl ?? "Profile pattern"
          : "Profile card");
      const tag = event.tag ?? event.catalogId ?? event.patternUrl ??
        "profile";
      const cell = source === "url"
        ? (UrlPatternReference({ title, url: event.patternUrl ?? "" }) as any)
          .for(tag)
        : (ProfileCatalogCard({ title }) as any).for(tag);
      appendElement({
        cell,
        tag,
        userTags,
        title,
        source,
      }, state.elements);
      return;
    }
  }
});

const setName = handler<SetProfileNameEvent, { name: Writable<string> }>(
  (event, state) => {
    if (event.key !== undefined && event.key !== "Enter") {
      return;
    }
    const name = (event.name ?? event.detail?.message ??
      event.target?.value ?? "").trim();
    // CT-1828: an empty (or whitespace-only) send is a no-op, not a clear.
    // The canonical name display falls back to the literal "Profile" once
    // empty, so blanking it here would erase it product-wide. Unlike bio,
    // clearing a name is never intentional through this handler.
    if (!name) {
      return;
    }
    state.name.set(name);
  },
);

const setAvatar = handler<SetProfileAvatarEvent, { avatar: Writable<string> }>(
  (event, state) => {
    if (event.key !== undefined && event.key !== "Enter") {
      return;
    }
    const avatar = (event.avatar ?? event.detail?.message ??
      event.target?.value ?? "").trim();
    // CT-1828: same empty-after-trim guard as setName — see comment above.
    if (!avatar) {
      return;
    }
    state.avatar.set(avatar);
  },
);

// THE authorized writer for the owner-protected `bio` field (CT-1648). Bio is
// multi-line free text, so — unlike setName — it is NOT Enter-gated and is
// driven by a Save button reading the bound (unprotected) draft cell: a direct
// `$value` two-way binding onto the protected `bio` cell would bypass this
// handler and be rejected by CFC. Falls back through event fields so a future
// "set bio" event path (or a test) can pass the value directly.
const setBio = handler<
  SetProfileBioEvent,
  { bio: Writable<string>; draft?: Writable<string> }
>(
  (event, state) => {
    const bio = (event.bio ?? event.detail?.message ??
      event.target?.value ?? state.draft?.get() ?? "").trim();
    state.bio.set(bio);
    // Clear the draft after a successful save (mirrors the form handlers
    // elsewhere in this file).
    state.draft?.set("");
  },
);

// The single authorized writer for the share inbox link. The link is stored
// as sent, and an event without one clears the pointer (the owner retired
// their inbox). No shape check here: the event's schema admits a cell link
// and nothing else, and the runtime refuses an event that is not one.
const setInbox = handler<
  SetProfileInboxEvent,
  { inbox: Writable<ProfileInbox> }
>((event, state) => {
  state.inbox.set(event.inbox === undefined ? {} : { piece: event.inbox });
});

// The single authorized writer for externally hosted profile links. Add and
// remove streams are instances of this handler so the owner-protected list has
// one stable write identity, like `elements` above.
const mutateExternalProfileLinks = handler<
  MutateExternalProfileLinksEvent,
  {
    externalLinks: Writable<ExternalProfileLink[]>;
    mode: "add" | "remove";
    label?: Writable<string>;
    url?: Writable<string>;
    removeUrl?: string;
  }
>((event, state) => {
  if (state.mode === "remove") {
    const url = (event.url ?? state.removeUrl ?? "").trim();
    if (!url) return;
    state.externalLinks.set(
      state.externalLinks.get().filter((link) => link.url !== url),
    );
    return;
  }

  const url = (event.url ?? state.url?.get() ?? "").trim();
  if (!isSafeExternalProfileUrl(url)) return;
  const label = (event.label ?? state.label?.get() ?? "").trim() || url;
  const current = state.externalLinks.get();
  if (current.some((link) => link.url === url)) return;
  state.externalLinks.set([...current, { label, url }]);
  state.label?.set("");
  state.url?.set("");
});

function normalizeVerifiedAt(value: string): string | undefined {
  // Date.parse normalizes impossible dates such as February 31. Validate the
  // RFC3339 calendar and clock components first, then let Date produce the
  // canonical UTC representation consumers compare by age.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
      .exec(
        value,
      );
  if (!match) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    zone,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offset = zone === "Z"
    ? undefined
    : zone.slice(1).split(":").map(Number);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    year < 1 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 ||
    second > 59 || (offset && (offset[0] > 23 || offset[1] > 59))
  ) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function isCanonicalVerifiedIdentity(
  identity: ExternalIdentityAssertion,
): boolean {
  const type = identity.type;
  const value = identity.value;
  const verifiedAt = identity.verifiedAt;
  return typeof type === "string" && type.length > 0 &&
    type === type.trim().toLowerCase() &&
    typeof value === "string" && value.length > 0 && value === value.trim() &&
    typeof verifiedAt === "string" &&
    normalizeVerifiedAt(verifiedAt) === verifiedAt;
}

// The profile is a collector, not the authority that creates these claims.
// CFC rejects an event before this handler runs unless every incoming cell
// already bears the required Loom integrity atom. The handler may inspect the
// value to reject malformed producer output, but stores/removes the exact cell
// reference so its integrity provenance is preserved end to end.
const publishVerifiedIdentities = handler<
  MutateVerifiedIdentitiesEvent,
  {
    verifiedIdentities: Writable<VerifiedExternalIdentityCell[]>;
    mode: "publish" | "revoke";
  }
>((event, state) => {
  const incoming = event.identities ?? [];
  if (incoming.length === 0) return;

  if (state.mode === "revoke") {
    incoming.forEach((identity) =>
      state.verifiedIdentities.removeAll(identity)
    );
    return;
  }

  incoming.forEach((identity) => {
    if (!isCanonicalVerifiedIdentity(identity.get())) return;
    state.verifiedIdentities.addUnique(identity);
  });
});

// View/edit toggle for the rendered profile view (CT-1748). Plain (un-protected)
// UI state: visiting a profile shows the read-only presentation; this flips to
// the edit form. The flag itself is not owner-protected — anyone can flip their
// own view — but CFC still gates the actual field writes behind the form.
const toggleProfileEditing = handler<void, { editing: Writable<boolean> }>(
  (_event, state) => {
    state.editing.set(!state.editing.get());
  },
);

const applyInitialName = lift<
  { initialName?: string; name: Writable<string> },
  string
>(({ initialName, name }) => {
  return name.get() || trimInitialName(initialName);
});

export default pattern<ProfileHomeInput, ProfileHomeOutput>(
  ({ initialName, [SELF]: self }) => {
    // A static initializer, so the cell keeps its identity across releases:
    // a default derived from an input is materialized under an id that moves
    // with the pattern, and a release would leave the saved name behind in
    // the cell it no longer links. The display falls back to `initialName`
    // (`applyInitialName`) until the person stores one through `setName`.
    const name = new Writable<
      OwnerProtectedProfileWrite<string, typeof setName>
    >("").for("name");
    const avatar = new Writable<
      OwnerProtectedProfileWrite<string, typeof setAvatar>
    >("").for("avatar");
    const bio = new Writable<
      OwnerProtectedProfileWrite<string, typeof setBio>
    >("").for("bio");
    const inbox = new Writable<
      OwnerProtectedProfileWrite<ProfileInbox, typeof setInbox>
    >({}).for("inbox");
    const externalLinks = new Writable<
      OwnerProtectedProfileWrite<
        ExternalProfileLink[],
        typeof mutateExternalProfileLinks
      >
    >([]).for("externalLinks");
    const verifiedIdentities = new Writable<
      VerifiedIdentityListWrite<typeof publishVerifiedIdentities>
    >([]).for("verifiedIdentities");
    // Unprotected draft backing the bio textarea; saved into the protected
    // `bio` cell through `setBio` (CT-1648).
    const bioDraft = new Writable("").for("bioDraft");
    // Unprotected drafts for the external-link form. The durable links are
    // written only through `mutateExternalProfileLinks` above.
    const externalLinkLabel = new Writable("").for("externalLinkLabel");
    const externalLinkUrl = new Writable("").for("externalLinkUrl");
    const elements = new Writable<
      OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>
    >([]).for("elements");
    const patternUrl = new Writable("").for("patternUrl");
    const elementTitle = new Writable("").for("elementTitle");
    const elementTag = new Writable("").for("elementTag");
    const userTagsText = new Writable("").for("userTagsText");
    // "Pin a piece" form (CT-1755): a link to an existing deployed piece by
    // its space DID + piece id.
    const pieceSpaceForm = new Writable("").for("pieceSpaceForm");
    const pieceIdForm = new Writable("").for("pieceIdForm");
    const pieceTitleForm = new Writable("").for("pieceTitleForm");
    // Rendered profile view (CT-1748): the cell view shows a read-only
    // presentation by default; the owner flips this to reveal the edit form.
    const editing = new Writable<boolean>(false).for("editing");
    // Is the current viewer the profile owner? `wish("#profile")` resolves the
    // VIEWER's default profile as `.result`, but `.candidates` contains every
    // profile linked from that viewer's home. Compare `SELF` against the whole
    // candidate list: an owner must be able to edit ANY of their profiles, not
    // just the one currently selected as default. A visitor's candidates are
    // all different cells, so this remains a safe UX gate; CFC independently
    // protects the field writes.
    // This lookup only needs the candidate cells' identities. Keeping its
    // value schema minimal prevents the ownership UX computation from
    // propagating the full CFC-protected profile result through its branches.
    const viewerProfile = wish<{ name?: string }>({ query: "#profile" });
    const isOwner = computed(() => {
      return viewerProfile.candidates?.some((profile) =>
        equals(self, profile) === true
      ) === true;
    });
    // `isEditing` is the raw view-toggle state (the user's intent), kept
    // independent of ownership so it stays a clean, testable signal. The edit
    // FORM is gated separately on `showEditForm` below; a visitor never sees the
    // toggle button, so for them `editing` stays false in practice anyway.
    const isEditing = computed(() => editing.get() === true);
    // The edit form is shown only to the owner who has toggled into edit mode;
    // visitors (and the owner before toggling) see the read-only presentation.
    // Ownership is re-derived inline rather than referencing `isOwner` so each
    // computed is self-contained (avoids nested-computed unwrap surprises).
    const showEditForm = computed(() => {
      const owner = viewerProfile.candidates?.some((profile) =>
        equals(self, profile) === true
      ) === true;
      return editing.get() === true && owner;
    });
    // Whether a non-empty bio has been authored — drives the presentation-mode
    // bio block (CT-1648).
    const hasBio = computed(() => (bio.get() ?? "").trim().length > 0);
    const hasExternalLinks = computed(() => externalLinks.get().length > 0);
    // Five-minute ticks are fine enough for a 48-hour freshness window.
    const now = wish<number>({ query: "#now/300" });
    const parsedUserTags = computed(() =>
      userTagsText.get().split(",").map((tag) => tag.trim()).filter((tag) =>
        tag.length > 0
      )
    );
    const initialNameApplied = applyInitialName({ initialName, name });
    // A profile's display name is the person's name (falls back to "Profile"
    // before one is set). This drives cf-cell-link labels in the picker and
    // anywhere a profile link is rendered.
    const displayName = computed(() => {
      const applied = initialNameApplied;
      return typeof applied === "string" && applied.trim().length > 0
        ? applied
        : "Profile";
    });

    return {
      [NAME]: displayName,
      name,
      avatar,
      bio,
      inbox,
      externalLinks,
      verifiedIdentities,
      elements,
      setName: setName({ name }),
      setAvatar: setAvatar({ avatar }),
      setBio: setBio({ bio, draft: bioDraft }),
      setInbox: setInbox({ inbox }),
      addExternalLink: mutateExternalProfileLinks({
        externalLinks,
        mode: "add",
        label: externalLinkLabel,
        url: externalLinkUrl,
      }),
      removeExternalLink: mutateExternalProfileLinks({
        externalLinks,
        mode: "remove",
      }),
      publishVerifiedIdentities: publishVerifiedIdentities({
        verifiedIdentities,
        mode: "publish",
      }),
      revokeVerifiedIdentities: publishVerifiedIdentities({
        verifiedIdentities,
        mode: "revoke",
      }),
      // Both exported streams are instances of the one authorized writer,
      // pinned to their declared purpose via the bound mode.
      addElement: mutateElements({ elements, mode: "add" }),
      removeElement: mutateElements({ elements, mode: "remove" }),
      // Pin an existing deployed piece as a followable card (CT-1755). Reads
      // the bound form cells; an event may also pass { pieceSpace, pieceId,
      // title } directly (e.g. a future "pin from the piece" flow).
      addPiece: mutateElements({
        elements,
        mode: "addPiece",
        pieceSpace: pieceSpaceForm,
        pieceId: pieceIdForm,
        title: pieceTitleForm,
      }),
      toggleEditing: toggleProfileEditing({ editing }),
      isEditing,
      initialNameApplied,
      [UI]: (
        <cf-screen
          data-ui-pattern={TRUSTED_PROFILE_HOME_SURFACE}
          data-ui-event-integrity={TRUSTED_PROFILE_HOME_SURFACE}
          style={{
            fontFamily:
              "var(--cf-theme-font-family, var(--cf-font-family-sans, system-ui, sans-serif))",
          }}
        >
          <cf-toolbar slot="header" sticky>
            <div slot="start">
              <cf-heading level={2}>Profile</cf-heading>
            </div>
          </cf-toolbar>

          <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "720px" }}>
            {
              /* CT-1748: read-only presentation — what you see when you visit a
                profile cell. The edit form is gated behind the toggle below. */
            }
            {ifElse(
              showEditForm,
              null,
              <cf-vstack gap="4" data-ui-region="profile-presentation">
                {
                  /* Hero identity (CT-1761): bound to the profile's OWN root
                    cell (`self`), not a derived projection — so the badge reads
                    the runtime-attested represents-principal label and draws the
                    real verified seal. `noNavigate` keeps it non-clickable on
                    the profile's own page. */
                }
                <cf-profile-badge
                  id="profile-badge"
                  variant="hero"
                  $profile={self}
                  size="xl"
                  noNavigate
                />

                {ifElse(
                  hasBio,
                  <cf-text
                    block
                    variant="body"
                    tone="muted"
                    data-ui-region="profile-bio"
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {bio}
                  </cf-text>,
                  null,
                )}

                {ifElse(
                  hasExternalLinks,
                  <cf-hstack gap="2" wrap>
                    {externalLinks.map((link) =>
                      isSafeExternalProfileUrl(link.url)
                        ? (
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.label}
                          </a>
                        )
                        : <span>{link.label}</span>
                    )}
                  </cf-hstack>,
                  null,
                )}

                <VerifiedIdentitiesSection
                  identities={verifiedIdentities}
                  nowMs={now.result}
                />

                {
                  /* Pinned patterns render as tile variants (clickable,
                    navigate to the piece); the user's title/tags annotate the
                    footer. The old bespoke card + cf-cell-link "Open" is gone. */
                }
                <cf-grid columns="2" gap="3">
                  {elements.map((element) => (
                    <div
                      style={{
                        border:
                          "0.5px solid var(--cf-theme-color-border, #e5e5e7)",
                        borderRadius: "12px",
                        overflow: "hidden",
                      }}
                    >
                      <div style={{ width: "100%", height: "160px" }}>
                        <cf-render variant="tile" $cell={element.cell} />
                      </div>
                      <div style={{ padding: "10px 14px" }}>
                        <strong>{element.title ?? element.tag}</strong>
                        <div
                          style={{
                            color: "var(--cf-theme-color-text-secondary)",
                            fontSize: "13px",
                          }}
                        >
                          {element.userTags.map((tag) => `#${tag}`).join(" ")}
                        </div>
                      </div>
                    </div>
                  ))}
                </cf-grid>

                {
                  /* Only the owner gets the edit affordance; a visitor sees a
                  read-only profile (and CFC would reject their writes anyway). */
                }
                {ifElse(
                  isOwner,
                  <cf-hstack>
                    <cf-button
                      id="profile-edit-toggle"
                      variant="ghost"
                      size="sm"
                      onClick={toggleProfileEditing({ editing })}
                    >
                      Edit profile
                    </cf-button>
                  </cf-hstack>,
                  null,
                )}
              </cf-vstack>,
            )}

            {/* The existing edit form, revealed only to the owner in edit mode. */}
            {ifElse(
              showEditForm,
              <cf-vstack gap="4" data-ui-region="profile-edit">
                <cf-vstack gap="2">
                  <label>Name</label>
                  <strong>{name}</strong>
                  <cf-message-input
                    data-ui-action={TRUSTED_PROFILE_EDIT_ACTION}
                    placeholder="Your name"
                    appearance="rounded"
                    oncf-send={setName({ name })}
                  />
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>Avatar</label>
                  <span>{avatar}</span>
                  <cf-message-input
                    data-ui-action={TRUSTED_PROFILE_EDIT_ACTION}
                    placeholder="Avatar URL or text"
                    appearance="rounded"
                    oncf-send={setAvatar({ avatar })}
                  />
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>Bio</label>
                  <span style={{ whiteSpace: "pre-wrap" }}>{bio}</span>
                  <cf-textarea
                    data-ui-action={TRUSTED_PROFILE_EDIT_ACTION}
                    $value={bioDraft}
                    placeholder="A short bio…"
                    style="width: 100%;"
                  />
                  <cf-button onClick={setBio({ bio, draft: bioDraft })}>
                    Save bio
                  </cf-button>
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>External profile links</label>
                  <cf-input
                    $value={externalLinkLabel}
                    placeholder="GitHub, LinkedIn, personal site…"
                  />
                  <cf-input
                    $value={externalLinkUrl}
                    placeholder="https://…"
                  />
                  <cf-button
                    onClick={mutateExternalProfileLinks({
                      externalLinks,
                      mode: "add",
                      label: externalLinkLabel,
                      url: externalLinkUrl,
                    })}
                  >
                    Add external link
                  </cf-button>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    Add public http(s) links to profiles you maintain elsewhere.
                  </span>
                  {ifElse(
                    hasExternalLinks,
                    <cf-vstack
                      gap="1"
                      data-ui-region="profile-external-links"
                    >
                      <cf-text variant="body-compact">Current links</cf-text>
                      <cf-vstack gap="1">
                        {externalLinks.map((link) => (
                          <cf-hstack gap="2" align="center">
                            {isSafeExternalProfileUrl(link.url)
                              ? (
                                <a
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {link.label}
                                </a>
                              )
                              : <span>{link.label}</span>}
                            <span
                              style={{
                                color: "var(--cf-theme-color-text-secondary)",
                              }}
                            >
                              {link.url}
                            </span>
                            <cf-button
                              size="sm"
                              variant="ghost"
                              onClick={mutateExternalProfileLinks({
                                externalLinks,
                                mode: "remove",
                                removeUrl: link.url,
                              })}
                            >
                              Remove
                            </cf-button>
                          </cf-hstack>
                        ))}
                      </cf-vstack>
                    </cf-vstack>,
                    null,
                  )}
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>Tags</label>
                  <cf-input $value={userTagsText} placeholder="person, work" />
                </cf-vstack>

                <cf-hstack gap="2">
                  <cf-button
                    onClick={mutateElements({
                      elements,
                      mode: "addCard",
                      userTags: parsedUserTags,
                    })}
                  >
                    Add profile card
                  </cf-button>
                </cf-hstack>

                <cf-vstack gap="2">
                  <label>Link URL</label>
                  <cf-input
                    $value={patternUrl}
                    placeholder="/api/patterns/..."
                  />
                  <cf-input $value={elementTitle} placeholder="Title" />
                  <cf-input $value={elementTag} placeholder="Tag" />
                  <cf-button
                    onClick={mutateElements({
                      elements,
                      mode: "addLink",
                      patternUrl,
                      title: elementTitle,
                      tag: elementTag,
                      userTags: parsedUserTags,
                    })}
                  >
                    Add link
                  </cf-button>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    Links are saved as reference cards. They are not deployed or
                    run.
                  </span>
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>Pin a piece</label>
                  <cf-input
                    $value={pieceSpaceForm}
                    placeholder="Space DID (or paste a /space/piece URL)"
                  />
                  <cf-input
                    $value={pieceIdForm}
                    placeholder="Piece id (fid1:…)"
                  />
                  <cf-input
                    $value={pieceTitleForm}
                    placeholder="Card title (optional)"
                  />
                  <cf-button
                    onClick={mutateElements({
                      elements,
                      mode: "addPiece",
                      pieceSpace: pieceSpaceForm,
                      pieceId: pieceIdForm,
                      title: pieceTitleForm,
                      userTags: parsedUserTags,
                    })}
                  >
                    Pin piece
                  </cf-button>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    Pins a link to an existing deployed piece. Click the card to
                    open the live piece.
                  </span>
                </cf-vstack>

                <cf-vstack gap="2">
                  {elements.map((element) => (
                    <cf-hstack gap="2" align="center">
                      <cf-cell-link $cell={element.cell}>
                        {element.title ?? element.tag}
                      </cf-cell-link>
                      <span
                        style={{
                          color: "var(--cf-theme-color-text-secondary)",
                        }}
                      >
                        {element.userTags.map((tag) => `#${tag}`).join(" ")}
                      </span>
                      <cf-button
                        size="sm"
                        variant="ghost"
                        onClick={mutateElements({
                          elements,
                          mode: "remove",
                          cell: element.cell,
                        })}
                      >
                        Remove
                      </cf-button>
                    </cf-hstack>
                  ))}
                </cf-vstack>

                <cf-hstack>
                  <cf-button
                    variant="ghost"
                    size="sm"
                    onClick={toggleProfileEditing({ editing })}
                  >
                    Done
                  </cf-button>
                </cf-hstack>
              </cf-vstack>,
              null,
            )}
          </cf-vstack>
        </cf-screen>
      ),
    };
  },
);
