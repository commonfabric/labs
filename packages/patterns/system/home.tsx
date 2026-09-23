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
  // `defaultProfile` is semantically optional: a home may have no selected
  // profile. Requiredness is decided by the `?` marker, not by including
  // `undefined` in the value type.
  profiles: Default<TrustedProfileList, []>;
  defaultProfile?: TrustedDefaultProfile;
  mru: Default<TrustedProfileMru, []>;
  // The user's agent queue: the index of their agent runs and their
  // registered runner. `wish({ query: "#agent_queue" })` resolves to it, and
  // the `agent` builtin appends to its `entries`.
  agentQueue: AgentQueueOutput;
  createProfile: Stream<CreateProfileEvent>;
  addFavorite: Stream<{
    piece: Writable<{ [NAME]?: string }>;
    tags?: string[];
    spaceName?: string;
    id?: string;
  }>;
  removeFavorite: Stream<{ piece?: Writable<unknown>; id?: string }>;
  addJournalEntry: Stream<{ entry: JournalEntry }>;
  addSpace: Stream<{ detail: { message: string } }>;
  removeSpace: Stream<{ name?: string }>;
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

// Handler to add a space to the managed list
const addSpaceHandler = handler<
  { detail: { message: string } },
  { spaces: Writable<SpaceEntry[]> }
>(({ detail }, { spaces }) => {
  const name = detail?.message?.trim();
  if (!name) return;
  // Address the space entity by its name. Setting the entity and add-uniquing
  // it means two sessions adding the same name resolve to one membership entry,
  // and adds of distinct names merge, without reading the whole list.
  const entry = spaces.elementById(name);
  entry.set({ name });
  spaces.addUnique(entry);
});

// Handler to remove a space from the managed list. The per-row button binds the
// name as state; the exported `removeSpace` stream passes it in the event.
const removeSpaceHandler = handler<
  { name?: string },
  { name?: string; spaces: Writable<SpaceEntry[]> }
>(({ name: eventName }, { name: stateName, spaces }) => {
  const name = eventName ?? stateName;
  if (!name) return;
  // Remove the membership entry addressed by name. removeByValue matches by the
  // deterministic link, so concurrent removes of distinct spaces merge instead
  // of clobbering through a whole-list set.
  spaces.removeByValue(spaces.elementById(name));
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
    // space. `profiles` is the durable list (appended on create). `defaultProfile`
    // is the one `#profile` resolves to in headless mode and orders first in the
    // picker; `mru` is the recency-ordered list driving the rest of the ordering.
    const profiles = new Writable<BackwardsCompatibleProfile[]>([]).for(
      "profiles",
    );
    const defaultProfile = new Writable<BackwardsCompatibleProfile | undefined>(
      undefined,
    )
      .for("defaultProfile");
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
      mru: mru as any,
    });

    // Child components
    const favoritesComponent = FavoritesManager({});
    const agentQueue = AgentQueue({});
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
                          No spaces yet. Add one below.
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
                    Add or Create Space
                  </h3>
                  <cf-message-input
                    placeholder="Space name..."
                    appearance="rounded"
                    oncf-send={addSpaceHandler({ spaces })}
                  />
                  <span style={{ fontSize: "11px", color: "#888" }}>
                    Type a name and press enter. Click the link to navigate.
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
      mru: mru as any,
      agentQueue,

      // Exported handlers
      addFavorite: addFavorite({ favorites }),
      removeFavorite: removeFavorite({ favorites }),
      addJournalEntry: addJournalEntry({ journal }),
      addSpace: addSpaceHandler({ spaces }),
      removeSpace: removeSpaceHandler({ spaces }),
      createProfile: createProfileStream,
    };
  },
  homeArgumentSchema,
  homeResultSchema,
) as PatternFactory<Record<string, never>, HomeOutput>;

export default Home;
