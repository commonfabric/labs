import {
  __cf_data,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PatternFactory,
  Stream,
  toSchema,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import AgentQueue, {
  type AgentQueueOutput,
  withAgentQueueRunLinkSchema,
} from "./agent-queue.tsx";
import FabriChatManager, {
  type FabriChatManagerOutput,
} from "../fabrichat/manager.tsx";
import FavoritesManager from "./favorites-manager.tsx";
import Self from "../self.tsx";
import {
  type CreateProfileEvent,
  seedProfileName,
  submitProfileCreation,
  type TrustedDefaultProfile,
  type TrustedProfileList,
  type TrustedProfileMru,
} from "./profile-create.tsx";
import ProfilePicker from "./profile-picker.tsx";
import type { BackwardsCompatibleProfile } from "./profile-home.tsx";
import {
  ensurePrivateInbox,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
} from "./private-inbox.tsx";

// Types from favorites-manager.tsx
type Favorite = {
  cell: { [NAME]?: string };
  // Discovery tags snapshotted from the piece's schema when favorited.
  tags: string[];
  userTags: string[];
  spaceName?: string;
  // Stable key the favorite entity is addressed by (the piece's identity).
  id?: string;
};

type JournalEntry = {
  timestamp?: number;
  eventType?: string;
  subject?: Writable<unknown>;
  snapshot?: { name?: string; schemaTag?: string; valueExcerpt?: string };
  narrative?: string;
  narrativePending?: boolean;
  tags?: string[];
  space?: string;
};

// An entry of the space list. An entry with a `did` opens that space, and its
// `name` is only what the entry is called: two entries may share one, and
// renaming one changes nothing else. An entry written before spaces had random
// identities has only a `name`, which resolves as a legacy space name until the
// runtime adopts the entry (`adoptSpace`) under the DID the name resolves to.
type SpaceEntry = {
  name: string;
  did?: string;
};

export type HomeOutput = {
  [NAME]: string;
  [UI]: VNode;
  // These defaults are part of Home's published result contract. Pattern setup
  // generates the output fields, so a newly added result does not need a
  // migration default; once a default has shipped, however, removing it changes
  // the contract's materialization semantics.
  favorites: Writable<Favorite[] | Default<[]>>;
  journal: Writable<JournalEntry[] | Default<[]>>;
  spaces: Writable<SpaceEntry[] | Default<[]>>;
  defaultAppUrl: Writable<string | Default<"">>;
  // The profile list/mru are CFC-wrapped (WriteAuthorizedBy), so their existing
  // default goes OUTSIDE the wrapper — `Default<Cfc<…>, []>`, exactly as
  // profile-home spells externalLinks/verifiedIdentities. An empty default
  // carries no elements and therefore asserts no writer claims; the contract
  // governs every real element appended through the trusted create surface.
  // `defaultProfile` is the slot holding the selected profile's link under
  // `profile`, and no `profile` while none is selected (`DefaultProfileSlot`).
  // It is optional, decided by the `?` marker, because a home can hold none.
  // `legacyDefaultProfile` is a default held as a link at the root of the
  // `defaultProfile` cell, the shape a home holds one in when it was chosen
  // before the slot. It is the default while the slot holds none.
  profiles: Default<TrustedProfileList, []>;
  defaultProfile?: TrustedDefaultProfile;
  legacyDefaultProfile?: BackwardsCompatibleProfile;
  mru: Default<TrustedProfileMru, []>;
  // The user's agent queue: the index of their agent runs and their
  // registered runner. `wish({ query: "#agent_queue" })` resolves to it, and
  // the `agent` builtin appends to its `entries`.
  agentQueue: AgentQueueOutput;
  // The user's chat manager: the index of the FabriChat rooms they belong to.
  // `wish({ query: "#chatManager" })` resolves to it.
  chatManager: FabriChatManagerOutput;
  // The user's private inbox, where others deliver offers to them, and which
  // each of their profiles points at. Absent until `ensurePrivateInbox` runs.
  privateInbox: Writable<PrivateInboxHolder>;
  createProfile: Stream<CreateProfileEvent>;
  // Creates the private inbox if there is none, and points every profile that
  // points at no inbox at it. The host sends it once per sign-in.
  ensurePrivateInbox: Stream<void>;
  addFavorite: Stream<{
    piece: Writable<{ [NAME]?: string }>;
    tags?: string[];
    spaceName?: string;
    id?: string;
  }>;
  removeFavorite: Stream<{ piece?: Writable<unknown>; id?: string }>;
  addJournalEntry: Stream<{ entry: JournalEntry }>;
  addSpace: Stream<
    { did?: string; name?: string; detail?: { message: string } }
  >;
  removeSpace: Stream<{ did?: string; name?: string }>;
  adoptSpace: Stream<{ name: string; did: string }>;
  renameSpace: Stream<{ did: string; name: string }>;
};

// Handler to add a favorite
const addFavorite = handler<
  {
    piece: Writable<{ [NAME]?: string }>;
    tags?: string[];
    spaceName?: string;
    id?: string;
  },
  { favorites: Writable<Favorite[]> }
>(({ piece, tags, spaceName, id }, { favorites }) => {
  // The favorite is addressed by the piece's identity (the client-supplied id),
  // so favoriting the same piece from two sessions resolves to one membership
  // entry and favorites of distinct pieces merge, without reading the whole
  // list.
  if (!id) return;
  const entry = favorites.elementById(id);
  // Only seed the entity on a fresh favorite; a re-favorite keeps the existing
  // userTags. Discovery tags are derived by the client (which can see the
  // piece's schema) and passed in; the handler just stores them.
  if (!entry.get()) {
    entry.set({
      cell: piece,
      tags: tags ?? [],
      userTags: [],
      spaceName,
      id,
    });
  }
  favorites.addUnique(entry);
});

// Handler to remove a favorite
const removeFavorite = handler<
  { piece?: Writable<unknown>; id?: string },
  { favorites: Writable<Favorite[]> }
>(({ piece, id }, { favorites }) => {
  // A favorite added through the keyed path has an entity at elementById(id).
  // Drop its membership by identity (concurrent unfavorites of distinct pieces
  // merge) and clear the entity, since it outlives its link — a later
  // re-favorite reads it back to decide whether to seed fresh.
  if (id) {
    const entry: Writable<Favorite | undefined> = favorites.elementById(id);
    if (entry.get()) {
      favorites.removeByValue(favorites.elementById(id));
      entry.set(undefined);
      return;
    }
  }
  // A favorite added before keyed addressing has no such entity; remove it by
  // matching its piece cell. This rewrites the whole list, but keyed entries
  // keep their addressing.
  if (!piece) return;
  favorites.set(favorites.get().filter((f) => f && !equals(f.cell, piece)));
});

// Handler to add a journal entry (kept for schema compatibility)
const addJournalEntry = handler<
  { entry: JournalEntry },
  { journal: Writable<JournalEntry[]> }
>(({ entry }, { journal }) => {
  journal.push(entry);
});

// Handler to add a space to the managed list. The space already exists: the
// runtime creates it and sends its DID here. The entry is addressed by the DID,
// so two sessions adding one space resolve to one entry, and adds of distinct
// spaces merge, without reading the whole list. An event with no label, or an
// empty one, keeps the label an existing entry has. An event carrying only a
// typed name (`detail.message`) records a name-only entry, which opens the
// legacy space the name resolves to and which the runtime later adopts under
// that DID.
const addSpaceHandler = handler<
  { did?: string; name?: string; detail?: { message: string } },
  { spaces: Writable<SpaceEntry[]> }
>(({ did, name, detail }, { spaces }) => {
  if (did) {
    const entry = spaces.elementById(did);
    entry.set({ name: name || entry.get()?.name || "", did });
    spaces.addUnique(entry);
    return;
  }
  const legacyName = detail?.message?.trim();
  if (!legacyName) return;
  const entry = spaces.elementById(legacyName);
  entry.set({ name: legacyName });
  spaces.addUnique(entry);
});

// Handler to remove a space from the managed list. The per-row button binds the
// entry's DID, or a legacy entry's name, as state; the exported `removeSpace`
// stream passes one in the event. Removing an entry changes nothing about the
// space it named.
const removeSpaceHandler = handler<
  { did?: string; name?: string },
  { did?: string; name?: string; spaces: Writable<SpaceEntry[]> }
>((event, state) => {
  // removeByValue matches by the deterministic link, so concurrent removes of
  // distinct spaces merge instead of clobbering through a whole-list set.
  const key = event.did ?? event.name ?? state.did ?? state.name;
  if (!key) return;
  state.spaces.removeByValue(state.spaces.elementById(key));
});

// Handler that replaces a legacy entry, addressed by its name, with an entry
// addressed by the DID the name resolves to and called by the same name.
const adoptSpaceHandler = handler<
  { name: string; did: string },
  { spaces: Writable<SpaceEntry[]> }
>(({ name, did }, { spaces }) => {
  if (!name || !did) return;
  const entry = spaces.elementById(did);
  entry.set({ name, did });
  spaces.addUnique(entry);
  spaces.removeByValue(spaces.elementById(name));
});

// Handler that changes what an entry is called, and nothing else.
const renameSpaceHandler = handler<
  { did: string; name: string },
  { spaces: Writable<SpaceEntry[]> }
>(({ did, name }, { spaces }) => {
  if (!did) return;
  const entry = spaces.elementById(did);
  entry.set({ name: name ?? "", did });
  spaces.addUnique(entry);
});

const homeArgumentSchema = toSchema<Record<string, never>>();
const homeResultSchema = __cf_data(
  withAgentQueueRunLinkSchema(toSchema<HomeOutput>()),
);

const Home = pattern(
  (_: Record<string, never>): HomeOutput => {
    // OWN the data cells (.for for id stability)
    const favorites = new Writable<Favorite[]>([]).for("favorites");
    const journal = new Writable<JournalEntry[]>([]).for("journal");
    const spaces = new Writable<SpaceEntry[]>([]).for("spaces");
    const defaultAppUrl = new Writable("").for("defaultAppUrl");
    // NOTE(CT-1628): the `as any` casts around the profile cells below are
    // required because the CFC wrapper types (TrustedProfile*) don't yet compose
    // with Writable/the pattern factory output type. Tracked for a proper type
    // fix.
    //
    // Multi-profile model: a user has many profiles, each in its own `inSpace`
    // space. `profiles` is the durable list (appended on create).
    // `defaultProfile` holds, under `profile`, the one `#profile` resolves to
    // in headless mode and orders first in the picker; `mru` is the
    // recency-ordered list driving the rest of the ordering. The default's cell
    // carries its trusted type, so its write contract labels the document
    // `setDefaultProfile` writes.
    const profiles = new Writable<BackwardsCompatibleProfile[]>([]).for(
      "profiles",
    );
    const defaultProfile = new Writable<TrustedDefaultProfile>({}).for(
      "defaultProfileSlot",
    );
    // A default chosen before the slot: a link at the root of this cell. It
    // stays the default until one is chosen in the slot, and nothing writes
    // it, since a handle to a cell whose root holds a link denotes the linked
    // profile rather than the cell.
    const legacyDefaultProfile = new Writable<
      BackwardsCompatibleProfile | undefined
    >(undefined).for("defaultProfile");
    const mru = new Writable<BackwardsCompatibleProfile[]>([]).for("mru");
    // Untrusted-write regression surface: this stream is exported so tests can
    // verify that sending it from outside the trusted create surface does NOT
    // create a profile. The actual create UI lives in the profile picker below.
    const createProfileStream = submitProfileCreation({
      profiles: profiles as any,
      seedName: seedProfileName({ profiles: profiles as any }),
    });
    // The home Profile tab IS the profile picker: it lists profiles natively,
    // sets the default, stamps MRU on selection, and creates more inline.
    const profilePicker = ProfilePicker({
      profiles: profiles as any,
      defaultProfile: defaultProfile as any,
      legacyDefaultProfile: legacyDefaultProfile as any,
      offersSetDefault: true,
      mru: mru as any,
    });

    // Child components
    const favoritesComponent = FavoritesManager({});
    const agentQueue = AgentQueue({});
    const chatManager = FabriChatManager({});
    const privateInbox = new Writable<PrivateInboxHolder>({}).for(
      "privateInbox",
    );
    const ensurePrivateInboxStream = ensurePrivateInbox({
      privateInbox,
      pointProfiles: pointProfilesAtPrivateInbox({
        privateInbox,
        profiles: profiles as any,
      }),
    });
    // Private self-model — the "real you" tier (values, neurotype, meaning Q&A),
    // home-local and never shared. Distinct from the outward profile/personas in
    // the Profile tab. Owns its own durable cell (seeded via Default<>).
    const selfComponent = Self({});
    const activeTab = new Writable("spaces").for("activeTab");

    return {
      [NAME]: `Home`,
      [UI]: (
        <cf-screen>
          <h1>
            home<strong>space</strong>
          </h1>

          <cf-tabs $value={activeTab}>
            <cf-tab-list>
              <cf-tab value="spaces">Spaces</cf-tab>
              <cf-tab value="favorites">Favorites</cf-tab>
              <cf-tab value="profile">Profile</cf-tab>
              <cf-tab value="self">Self</cf-tab>
              <cf-tab value="agent-runs">Agent runs</cf-tab>
            </cf-tab-list>
            <cf-tab-panel value="agent-runs" id="home-agent-runs">
              {agentQueue}
            </cf-tab-panel>
            <cf-tab-panel value="favorites">{favoritesComponent}</cf-tab-panel>
            <cf-tab-panel value="self">{selfComponent}</cf-tab-panel>
            <cf-tab-panel value="profile">
              <cf-vstack gap="4" style={{ padding: "1rem" }}>
                <h2 style={{ margin: 0, fontSize: "16px" }}>Profile</h2>

                <div id="home-profile-summary">{profilePicker}</div>
              </cf-vstack>
            </cf-tab-panel>
            <cf-tab-panel value="spaces">
              <cf-vstack gap="4" style={{ padding: "1rem" }}>
                <h2 style={{ margin: 0, fontSize: "16px" }}>My Spaces</h2>

                <cf-vstack gap="2">
                  {spaces.map((space) => (
                    <cf-hstack gap="2" align="center">
                      <div style={{ flex: "1" }}>
                        <cf-space-link
                          spaceName={space.name}
                          spaceDid={space.did}
                        />
                      </div>
                      <cf-button
                        size="sm"
                        variant="ghost"
                        onClick={removeSpaceHandler({
                          did: space.did,
                          name: space.name,
                          spaces,
                        })}
                      >
                        ✕
                      </cf-button>
                    </cf-hstack>
                  ))}
                  {computed(() =>
                    spaces.get().length === 0
                      ? (
                        <p
                          style={{
                            color: "#888",
                            fontStyle: "italic",
                            textAlign: "center",
                          }}
                        >
                          No spaces yet. Create one below.
                        </p>
                      )
                      : null
                  )}
                </cf-vstack>

                <hr
                  style={{ border: "none", borderTop: "1px solid #e5e5e7" }}
                />

                <cf-vstack gap="1">
                  <h3 style={{ margin: 0, fontSize: "14px" }}>
                    Create Space
                  </h3>
                  <cf-space-create placeholder="Space label..." />
                  <span style={{ fontSize: "11px", color: "#888" }}>
                    Type a label and press enter to create a new space. Click
                    the link to open it.
                  </span>
                </cf-vstack>

                <hr
                  style={{
                    border: "none",
                    borderTop: "1px solid #e5e5e7",
                    margin: "8px 0",
                  }}
                />

                <cf-vstack gap="1">
                  <h3 style={{ margin: 0, fontSize: "14px" }}>Settings</h3>
                  <label style={{ fontSize: "13px", color: "#666" }}>
                    Default App Pattern URL
                  </label>
                  <cf-input
                    $value={defaultAppUrl}
                    placeholder="/api/patterns/system/default-app.tsx"
                    style={{
                      width: "100%",
                      fontFamily: "monospace",
                      fontSize: "12px",
                    }}
                  />
                  <span style={{ fontSize: "11px", color: "#888" }}>
                    Pattern URL for new spaces. Leave empty for system default.
                  </span>
                </cf-vstack>
              </cf-vstack>
            </cf-tab-panel>
          </cf-tabs>
        </cf-screen>
      ) as VNode,

      // Exported data
      favorites,
      journal,
      spaces,
      defaultAppUrl,
      profiles: profiles as any,
      defaultProfile: defaultProfile as any,
      legacyDefaultProfile: legacyDefaultProfile as any,
      mru: mru as any,
      agentQueue,
      chatManager,
      privateInbox,

      // Exported handlers
      addFavorite: addFavorite({ favorites }),
      removeFavorite: removeFavorite({ favorites }),
      addJournalEntry: addJournalEntry({ journal }),
      addSpace: addSpaceHandler({ spaces }),
      removeSpace: removeSpaceHandler({ spaces }),
      adoptSpace: adoptSpaceHandler({ spaces }),
      renameSpace: renameSpaceHandler({ spaces }),
      createProfile: createProfileStream,
      ensurePrivateInbox: ensurePrivateInboxStream,
    };
  },
  homeArgumentSchema,
  homeResultSchema,
) as PatternFactory<Record<string, never>, HomeOutput>;

export default Home;
