// PATTERN TIER: legacy — superseded or non-idiomatic; kept for what
// depends on it. Do not copy from this file. Tiers: packages/patterns/index.md
import {
  action,
  type AddIntegrity,
  computed,
  Default,
  generateObject,
  handler,
  hasError,
  hasSchemaMismatch,
  ImageData,
  isPending,
  isSyncing,
  NAME,
  pattern,
  type PerSpace,
  type RequiresIntegrity,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  adminRegistryEntries,
  type EmptyAdminRegistryValue,
} from "../../cfc/admin/mod.ts";
import { normalizePlateId, US_STATES } from "../../vehicles.ts";

// ============================================================
// Domain Types (DESIGN §4)
// ============================================================

export type Classification = "ours" | "guest" | "offender" | "unknown";

// Phase 3b: known-vehicle registry entry (DESIGN §8). category "ours" is
// derived from people[].vehicles — only guest/offender live here.
export interface KnownVehicle {
  plateNumber: string; // normalized uppercase alphanumerics
  plateState: string; // uppercase 2-letter
  description: string; // human note, e.g. "white delivery van"
  category: "guest" | "offender";
  name?: string; // optional display name for guests (e.g. "Mary Friend")
  org: string; // e.g. "Local Butcher Shop"
  label: string; // e.g. "delivery van, Tue mornings"
}

// Phase 2: structured result of LLM plate/vehicle extraction from a photo.
export interface PlateExtraction {
  description: string; // color + make + model in plain words; "" if unclear
  plateNumber: string; // characters only; "" if not legible
  plateState: string; // 2-letter US state; "" if not visible
  confidence: "high" | "medium" | "low";
}

// Lightweight persisted image reference. We deliberately store only the blob
// `url` (+ filename), NOT the full `ImageData` — its required `data` field is a
// ~700KB inline base64 string, and inlining that into the perSpace `sightings`
// array destabilizes the cell's sync. The blob bytes live out-of-band at `url`.
export interface SightingImage {
  url: string;
  name: string;
}

export interface Sighting {
  id: string;
  spotNumber: string;
  capturedAt: number;
  reportedBy: string;
  image: SightingImage;
  description: string;
  plateNumber: string; // normalized uppercase alphanumerics
  plateState: string; // uppercase 2-letter
  extractionPending: boolean; // Phase 2: true while LLM call is in flight
  extractionError: string; // Phase 2: non-empty if extraction failed
  humanCorrected: boolean; // Phase 2: true once a person edited the extracted fields
  classification: Classification;
  notes: string;
}

// ============================================================
// Cell Types (DESIGN §5)
// ============================================================

// Spots cell — reuse parking-coordinator's shape (spotNumber + label)
export interface ParkingSpot {
  spotNumber: string;
  label: string;
  notes?: string;
  active?: boolean;
}

type SpotsCell = Writable<
  | ParkingSpot[]
  | Default<[
    { spotNumber: "1"; label: "Near entrance" },
    { spotNumber: "5"; label: "" },
    { spotNumber: "12"; label: "Compact only" },
    { spotNumber: "13"; label: "" },
  ]>
>;

type SightingsCell = Writable<Sighting[] | Default<[]>>;

// Phase 3b: known-vehicle registry cell
type KnownVehiclesCell = Writable<KnownVehicle[] | Default<[]>>;

// Phase 3b: loose person shape — we read only vehicles from it.
// The full parking-coordinator Person has more fields; this covers what we need.
// Phase 3c: vehicle element type includes the full coordinator shape so writes
// from assignToPerson are compatible with the coordinator's UI.
interface PersonWithVehicles {
  name: string;
  vehicles?: {
    plateId: string;
    plateState: string;
    color?: string;
    make?: string;
    model?: string;
  }[];
}

type PeopleCell = Writable<PersonWithVehicles[] | Default<[]>>;

// ============================================================
// Admin Types (DESIGN §6) — mirror parking-coordinator
// ============================================================

export const LOT_WATCH_ADMIN_INTEGRITY = "lot-watch-admin" as const;

export interface LotWatchAdminSubject {
  personName: string;
}

export interface LotWatchAdminRoleAssignment {
  subject: LotWatchAdminSubject;
  displayName: string;
}

export type LotWatchAdminRole = AddIntegrity<
  LotWatchAdminRoleAssignment,
  readonly [typeof LOT_WATCH_ADMIN_INTEGRITY]
>;

/**
 * The roster of lot-watch admin roles. One atom, `lot-watch-admin`, runs
 * through the roles, the roster and the floor, so a floored roster write may
 * consume the roster read it needs to decide the change. The list carries
 * three contracts:
 *
 * - `RequiresIntegrity` is the floor: a value landing at this path has to
 *   carry the endorsement, and every labeled value read on the way to writing
 *   here has to carry it too;
 * - `AddIntegrity` on the list mints that endorsement, so a write through
 *   this schema meets the floor. The endorsement each entry carries through
 *   `LotWatchAdminRole` labels the entries, and does not reach the list path
 *   the roster is written at;
 * - `WriteAuthorizedBy`, so `commitLotWatchAdminChange` is the only handler
 *   that may write the roster, whichever pattern holds a link to the registry
 *   cell. That binding is what decides where a write may come from; the mint
 *   only says the written value carries what the floor asks for.
 */
export type LotWatchAdminList = RequiresIntegrity<
  WriteAuthorizedBy<
    AddIntegrity<
      LotWatchAdminRole[],
      readonly [typeof LOT_WATCH_ADMIN_INTEGRITY]
    >,
    typeof commitLotWatchAdminChange
  >,
  readonly [typeof LOT_WATCH_ADMIN_INTEGRITY]
>;

export interface LotWatchAdminRegistryStoredValue {
  admins?: LotWatchAdminList;
}

export type LotWatchAdminRegistryValue =
  | LotWatchAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
export type LotWatchAdminRegistryCell = Writable<LotWatchAdminRegistryValue>;

/**
 * Per-user switch that reveals the admin-management controls, and the only
 * check the roster's commit handler makes on the acting user. Any viewer can
 * turn it on for themselves, so it carries no integrity: a self-granted value
 * that claimed one would endorse every protected write that consulted it. The
 * roster's `writeAuthorizedBy` binding decides which code may write the
 * roster. Nothing here decides which person may.
 */
export type LotWatchAdminManagerModeCell = Writable<boolean>;

// ============================================================
// Pattern I/O (DESIGN §12, trimmed to Phase 1)
// ============================================================

export interface LotWatchInput {
  spots?: PerSpace<SpotsCell>;
  sightings?: PerSpace<SightingsCell>;
  // Phase 3b: read employee vehicles → "ours" classification
  people?: PerSpace<PeopleCell>;
  // Phase 3b: guest/offender registries
  knownVehicles?: PerSpace<KnownVehiclesCell>;
  // Phase 3c: admin gating (DESIGN §6)
  adminRegistry?: PerSpace<LotWatchAdminRegistryCell>;
}

export interface LotWatchOutput {
  [NAME]: string;
  [UI]: VNode;
  sightings: Sighting[];
  knownVehicles: KnownVehicle[];
  people: PersonWithVehicles[];
  captureSighting: Stream<{
    spotNumber: string;
    image: ImageData;
    description: string;
    plateNumber: string;
    plateState: string;
    notes: string;
  }>;
  deleteSighting: Stream<{ id: string }>;
  selectTab: Stream<{ tab: "capture" | "sightings" | "report" }>;
  setReporterName: Stream<{ name: string }>;
  markVehicle: Stream<{
    plateNumber: string;
    plateState: string;
    category: "guest" | "offender";
    org: string;
    label?: string;
    name?: string;
  }>;
  removeKnownVehicle: Stream<{ plateNumber: string; plateState: string }>;
  openAssign: Stream<{ id: string }>;
  cancelAssign: Stream<void>;
  assignToPerson: Stream<void>;
  openGuest: Stream<{ id: string }>;
  cancelGuest: Stream<void>;
  saveGuest: Stream<void>;
  enableAdminManager: Stream<void>;
  togglePersonAdmin: Stream<{ name: string }>;
  becomeCurator: Stream<void>;
  stepDownCurator: Stream<void>;
  toggleAdminMode: Stream<void>;
}

// ============================================================
// Utilities
// ============================================================

const genId = (): string =>
  `sighting-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type ImageUploadEvent = {
  detail?: {
    images?: ImageData[];
    allImages?: ImageData[];
    files?: ImageData[];
    allFiles?: ImageData[];
  };
};

// ============================================================
// Module-scope handlers (MUST be at module scope — not inside pattern())
// ============================================================

const onPhotoCaptured = handler<
  ImageUploadEvent,
  {
    draftImage: Writable<ImageData | null>;
    captureStep: Writable<"photo" | "spot" | "review" | "saved">;
  }
>(({ detail }, { draftImage, captureStep }) => {
  const img = (detail?.allImages ?? detail?.images ?? [])[0] ?? null;
  draftImage.set(img);
  // Auto-advance the wizard — once we have a photo, jump to spot picker.
  if (img) captureStep.set("spot");
});

// ============================================================
// Classification display helpers (module scope — not inside pattern())
// ============================================================

const classificationColor = (c: Classification): string => {
  if (c === "ours") return "#166534";
  if (c === "guest") return "#1e40af";
  if (c === "offender") return "#991b1b";
  return "#374151"; // unknown
};

const classificationBg = (c: Classification): string => {
  if (c === "ours") return "#dcfce7";
  if (c === "guest") return "#dbeafe";
  if (c === "offender") return "#fee2e2";
  return "#f3f4f6"; // unknown
};

// ============================================================
// Phase 3b: Classification helper (DESIGN §8) — module-scope pure function
// so it can be called from inside computed() without capturing cells.
// Priority: ours > offender > guest > unknown.
// ============================================================

export const classifyPlate = (
  plateNumber: string,
  plateState: string,
  ours: readonly { plateId: string; plateState: string }[],
  known: readonly KnownVehicle[],
): Classification => {
  if (!plateNumber) return "unknown";
  const normPlate = normalizePlateId(plateNumber);
  const normState = plateState.toUpperCase().trim();
  // 1. ours — from people[].vehicles
  for (const v of ours) {
    if (
      normalizePlateId(v.plateId) === normPlate &&
      v.plateState.toUpperCase().trim() === normState
    ) {
      return "ours";
    }
  }
  // 2. offender takes priority over guest
  for (const kv of known) {
    if (
      normalizePlateId(kv.plateNumber) === normPlate &&
      kv.plateState.toUpperCase().trim() === normState &&
      kv.category === "offender"
    ) {
      return "offender";
    }
  }
  // 3. guest
  for (const kv of known) {
    if (
      normalizePlateId(kv.plateNumber) === normPlate &&
      kv.plateState.toUpperCase().trim() === normState &&
      kv.category === "guest"
    ) {
      return "guest";
    }
  }
  return "unknown";
};

// Phase 3: group sightings by normalized plate (plateNumber|plateState).
// Module-scope pure helper so both the sightings list and the repeat-offender
// summary derive from it without one computed reading another. Sightings with
// no readable plate are skipped (can't be matched/deduped).
export const plateKey = (plateNumber: string, plateState: string): string =>
  `${plateNumber}|${plateState}`;

export interface PlateGroup {
  plate: string;
  state: string;
  description: string;
  count: number;
  spots: string[];
  firstSeen: number;
  lastSeen: number;
  isRepeat: boolean; // seen 2+ times => repeat offender
}

const groupSightingsByPlate = (all: readonly Sighting[]): PlateGroup[] => {
  const map = new Map<string, PlateGroup>();
  for (const s of all) {
    if (!s.plateNumber) continue;
    const key = plateKey(s.plateNumber, s.plateState);
    const ts = Number(s.capturedAt); // coerce proxy → plain number
    const g = map.get(key);
    if (g) {
      g.count += 1;
      if (!g.spots.includes(s.spotNumber)) g.spots.push(s.spotNumber);
      g.firstSeen = Math.min(g.firstSeen, ts);
      g.lastSeen = Math.max(g.lastSeen, ts);
      if (!g.description && s.description) g.description = s.description;
    } else {
      map.set(key, {
        plate: s.plateNumber,
        state: s.plateState,
        description: s.description,
        count: 1,
        spots: [s.spotNumber],
        firstSeen: ts,
        lastSeen: ts,
        isRepeat: false,
      });
    }
  }
  const groups: PlateGroup[] = [];
  for (const g of map.values()) {
    g.isRepeat = g.count >= 2;
    groups.push(g);
  }
  return groups;
};

const fmtWhen = (ts: number): string => {
  const d = new Date(ts);
  return `${
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  } ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

// ============================================================
// Admin helpers (DESIGN §6) — module-scope pure functions, mirror coordinator
// ============================================================

// Demo-only identity model: the admin SUBJECT keys on the actor's free-text
// `reporterName` (a perUser cell set by the user themselves on the capture
// tab), exactly like parking-coordinator's `personName` subject. That means
// any user can become an admin by typing an existing admin's name into the
// reporter field — fine for a single-tenant lot demo, NOT acceptable for
// production. Replace `reporterName` with a stable identity (user DID /
// profile cell) before relying on this gate for real authorization.
const lotWatchAdminSubject = (personName: string): LotWatchAdminSubject => ({
  personName,
});

const lotWatchAdminRolesValue = (
  registry: LotWatchAdminRegistryCell,
): LotWatchAdminRole[] => adminRegistryEntries<LotWatchAdminRole>(registry);

const personIsLotWatchAdmin = (
  registry: LotWatchAdminRegistryCell,
  personName: string | undefined,
): boolean => {
  const trimmed = (personName ?? "").trim();
  if (!trimmed) return false;
  return lotWatchAdminRolesValue(registry).some(
    (role) => role.subject.personName === trimmed,
  );
};

const prepareLotWatchAdminToggle = (
  managerMode: boolean,
  registry: LotWatchAdminRegistryCell,
  rawName: string,
): LotWatchAdminRole[] | null => {
  const personName = rawName.trim();
  if (managerMode !== true || personName === "") {
    return null;
  }
  const adminRoles = lotWatchAdminRolesValue(registry);
  const nextRoles = adminRoles.filter(
    (role) => role.subject.personName !== personName,
  );
  if (nextRoles.length !== adminRoles.length) {
    return nextRoles;
  }
  return [
    ...nextRoles,
    {
      subject: lotWatchAdminSubject(personName),
      displayName: personName,
    } as LotWatchAdminRole,
  ];
};

type LotWatchAdminChangeKind = "toggle" | "grant" | "revoke";

interface LotWatchAdminChangeState {
  kind: LotWatchAdminChangeKind;
  adminRegistry: LotWatchAdminRegistryCell;
  adminManagerMode: LotWatchAdminManagerModeCell;
}

/**
 * The one place the admin roster is written. `LotWatchAdminList` names this
 * handler in its `writeAuthorizedBy` contract, so a write from anywhere else
 * — another action in this pattern, or another pattern that holds the
 * registry cell under this schema — is rejected by the runtime rather than
 * by a convention. Two writes reach the roster without passing through it:
 * pattern setup and seed materialization install a value at a bound path,
 * and a holder that declares the same cell under a schema of its own brings
 * no contract for the runtime to check.
 *
 * It stays private to this module. Its checks read the cells it is bound to,
 * so a module that could import it could bind it to a registry it wants to
 * change and to a manager flag of its own that says the change is allowed.
 * Private, the only bindings are the three below, against this pattern's own
 * cells.
 *
 * `grant` and `revoke` are the one-directional forms the curator buttons
 * need: each is a no-op when the person is already on the side it would move
 * them to, so a second click cannot step the actor back the other way.
 *
 * What none of this reaches is who the acting person is: that is the
 * free-text `reporterName`, per the demo identity model above, and the
 * manager flag it checks is one the actor turns on for themselves. Real
 * authority here needs a stable user identity first.
 */
const commitLotWatchAdminChange = handler<
  { name: string },
  LotWatchAdminChangeState
>((event, { kind, adminRegistry, adminManagerMode }) => {
  const personName = (event?.name ?? "").trim();
  if (personName === "") return;
  if (kind !== "toggle") {
    const isAdmin = personIsLotWatchAdmin(adminRegistry, personName);
    if (kind === "grant" ? isAdmin : !isAdmin) return;
  }
  const nextAdmins = prepareLotWatchAdminToggle(
    adminManagerMode.get(),
    adminRegistry,
    personName,
  );
  if (nextAdmins === null) return;
  adminRegistry.key("admins").set(nextAdmins as LotWatchAdminList);
});

// ============================================================
// Pattern
// ============================================================

export default pattern<LotWatchInput, LotWatchOutput>(
  ({ spots, sightings, people, knownVehicles, adminRegistry }) => {
    // ---- Cells (DESIGN §5) ----
    //
    // Each optional cell input materializes seeded from its type's `Default<>`
    // when the caller wires nothing; a parent that owns the cells (e.g.
    // lot-with-coordinator-demo) shares them by passing them in.

    // DESIGN §6: admin manager mode (mirror coordinator)
    const adminManagerMode = new Writable.perUser(false);

    // PerUser: who is reporting. Set from the viewer's shared profile (the
    // `#profile` wish's built-in UI covers profile create/pick); tests and
    // headless callers set it via the `setReporterName` stream.
    const reporterName = new Writable.perUser("");

    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    const resolvedProfileName = hasError(profileNameWish.result) ||
        isPending(profileNameWish.result) ||
        isSyncing(profileNameWish.result) ||
        hasSchemaMismatch(profileNameWish.result)
      ? ""
      : resultOf(profileNameWish.result);
    const resolvedProfileAvatar = hasError(profileAvatarWish.result) ||
        isPending(profileAvatarWish.result) ||
        isSyncing(profileAvatarWish.result) ||
        hasSchemaMismatch(profileAvatarWish.result)
      ? ""
      : resultOf(profileAvatarWish.result);
    const profileName = computed(() => resolvedProfileName.trim());
    const profileAvatar = computed(() => resolvedProfileAvatar.trim());
    const hasProfile = computed(() => resolvedProfileName.trim() !== "");
    const reporterLabel = computed(() => (reporterName.get() || "").trim());
    const hasReporter = computed(() => reporterLabel !== "");
    // Show the profile avatar only while the reporter IS the profile (an
    // explicit setReporterName override keeps initials-only rendering).
    const reporterAvatar = computed(() =>
      reporterLabel !== "" && reporterLabel === profileName ? profileAvatar : ""
    );

    // PerSession: tab navigation
    const selectedTab = new Writable.perSession<
      "capture" | "sightings" | "report"
    >("capture");

    // PerSession: admin mode toggle (only active admins can enable)
    const adminMode = new Writable.perSession(false);

    // PerSession: report tab filters
    const reportFilterSpot = new Writable.perSession<string>("");
    const reportFilterClassification = new Writable.perSession<string>("");

    // PerSession: capture draft fields
    const draftSpot = new Writable.perSession("");
    const draftImage = new Writable.perSession<ImageData | null>(null);
    const draftDescription = new Writable.perSession("");
    const draftPlateNumber = new Writable.perSession("");
    const draftPlateState = new Writable.perSession("CA");
    const draftNotes = new Writable.perSession("");

    // Wizard step for the capture flow — one decision per screen so the UI
    // isn't an overwhelming wall of fields. Photo → Spot → Review → Saved.
    type CaptureStep = "photo" | "spot" | "review" | "saved";
    const captureStep = new Writable.perSession<CaptureStep>("photo");

    // PerSession: delete confirm dialog target
    const deleteConfirmTarget = new Writable.perSession<string | null>(null);

    // Phase 3c: assign-to-person dialog state
    // assignTarget: sighting id whose person-picker is open, or null
    const assignTarget = new Writable.perSession<string | null>(null);
    // assignPersonName: name of the person selected in the picker
    const assignPersonName = new Writable.perSession<string>("");

    // Guest name flow: inline form to optionally name a guest vehicle.
    // guestTarget: sighting id whose guest-name form is open, or null
    const guestTarget = new Writable.perSession<string | null>(null);
    // guestName: free-text name typed in the guest form
    const guestName = new Writable.perSession<string>("");

    // ---- Phase 2: LLM extraction from the draft photo ----
    // Runs reactively when a photo is captured. Uses the draft's inline `data`
    // (that's why `includeData` stays on the capture input) — transient, the
    // saved Sighting keeps only the blob url.
    const extractionRequest = generateObject<PlateExtraction>({
      system:
        "You are reading a photo of a parked car to log a parking violation. " +
        "Extract the vehicle description (color + make + model in plain words), " +
        "the license plate characters, and the 2-letter US state if visible. " +
        "The photo may be rotated. If a field is not legible, return an empty " +
        "string — do not guess.",
      prompt: computed(() => {
        const img = draftImage.get();
        const image = img?.data ?? img?.url;
        if (!image) return [];
        return [
          { type: "image" as const, image },
          {
            type: "text" as const,
            text:
              "Extract description, plateNumber (characters only, no spaces or " +
              "dashes), plateState (2-letter), and your confidence.",
          },
        ];
      }),
      schema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "Color + make + model in plain words, e.g. 'white Toyota Corolla'",
          },
          plateNumber: {
            type: "string",
            description:
              "Plate characters only, uppercase, no spaces/dashes; '' if illegible",
          },
          plateState: {
            type: "string",
            description: "2-letter US state code if visible, else ''",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
      },
    });
    const extraction = resultOf(extractionRequest);

    // ---- Actions ----

    const selectTab = action<{ tab: "capture" | "sightings" | "report" }>(
      ({ tab }) => {
        selectedTab.set(tab);
      },
    );

    // DESIGN §6: admin actions
    const enableAdminManager = action(() => {
      adminManagerMode.set(true);
    });

    // Every roster write goes through the one handler the roster's
    // `writeAuthorizedBy` contract names.
    const adminChangeState = { adminRegistry, adminManagerMode };
    const togglePersonAdmin = commitLotWatchAdminChange({
      kind: "toggle",
      ...adminChangeState,
    });
    const grantPersonAdmin = commitLotWatchAdminChange({
      kind: "grant",
      ...adminChangeState,
    });
    const revokePersonAdmin = commitLotWatchAdminChange({
      kind: "revoke",
      ...adminChangeState,
    });

    const toggleAdminMode = action(() => {
      const isAdmin = personIsLotWatchAdmin(
        adminRegistry,
        reporterName.get() || "",
      );
      if (!isAdmin) {
        adminMode.set(false);
        return;
      }
      adminMode.set(!adminMode.get());
    });

    // One-shot curator promotion — the lot demo has no separate "admin
    // manager" persona, so the full CFC ceremony (enable manager → toggle
    // role → flip view) collapses to a single button. Turns the manager
    // switch on, sends the grant that promotes the current `reporterName`
    // to lot-watch admin, and turns admin view on. The grant reaches the
    // roster in its own transaction, so a refused grant leaves the switch
    // and the view set without a role. `personIsLotWatchAdmin` then
    // gates curation actions exactly as before — only the UX collapses,
    // not the underlying integrity model.
    const becomeCurator = action(() => {
      const name = (reporterName.get() || "").trim();
      if (!name) return; // need a reporter identity to bind the role to
      adminManagerMode.set(true);
      grantPersonAdmin.send({ name });
      adminMode.set(true);
    });

    // Symmetric one-click step-down: drop view + drop the role for the
    // current reporter, so "Become curator" is again a single click later.
    const stepDownCurator = action(() => {
      adminMode.set(false);
      const name = (reporterName.get() || "").trim();
      if (!name) return;
      revokePersonAdmin.send({ name });
    });

    // Quick-pick: set the assignPersonName cell to a known name. Used by
    // the chips in the "It's a known person's car" picker.
    const setAssignPersonName = action<{ name: string }>(({ name }) => {
      assignPersonName.set(name);
    });

    // Spot selection — cell mutations must go through an action(), not a bare
    // `.set()` in an inline onClick. Also auto-prefills the editable fields
    // from the LLM extraction (if it has resolved) so the user lands on
    // pre-filled values they can review/correct in the next step, and advances
    // the wizard.
    const setDraftSpot = action<{ spot: string }>(({ spot }) => {
      draftSpot.set(spot);
      if (!isPending(extractionRequest) && !hasError(extractionRequest)) {
        if (extraction.description && !draftDescription.get()) {
          draftDescription.set(extraction.description);
        }
        if (extraction.plateNumber && !draftPlateNumber.get()) {
          draftPlateNumber.set(extraction.plateNumber);
        }
        if (extraction.plateState && !draftPlateState.get()) {
          draftPlateState.set(extraction.plateState);
        }
      }
      captureStep.set("review");
    });

    // Programmatic setter for the perUser `reporterName`. The capture tab's
    // "Report as <profile>" button adopts the resolved profile name; tests
    // (and any non-UI caller) use this Stream seam to set an explicit name.
    const setReporterName = action<{ name: string }>(({ name }) => {
      reporterName.set(name);
    });

    // Adopt the viewer's resolved shared-profile name as the reporter name.
    const adoptProfileName = action(() => {
      const name = resolvedProfileName.trim();
      if (!name) return;
      reporterName.set(name);
    });

    // Phase 2: copy the success-only LLM result into the editable draft fields.
    // The guards keep this action callable while the request is unavailable.
    const applyExtraction = action(() => {
      if (isPending(extractionRequest) || hasError(extractionRequest)) return;
      if (extraction.description) draftDescription.set(extraction.description);
      if (extraction.plateNumber) draftPlateNumber.set(extraction.plateNumber);
      if (extraction.plateState) draftPlateState.set(extraction.plateState);
    });

    const captureSighting = action<{
      spotNumber: string;
      image: ImageData;
      description: string;
      plateNumber: string;
      plateState: string;
      notes: string;
    }>(({ spotNumber, image, description, plateNumber, plateState, notes }) => {
      const normalizedPlate = normalizePlateId(plateNumber);
      const normalizedState = plateState.toUpperCase().trim().slice(0, 2);

      // Persist ONLY the lightweight blob reference (`url` + `name`), never the
      // inline base64 `data` — a ~700KB data-URL inline in this perSpace array
      // destabilizes the cell's sync. The draft kept `data` for transient use
      // (Phase 2 LLM); the stored record stays light. (Idiom: group-chat-room.tsx.)
      const lightImage = { url: image?.url ?? "", name: image?.name ?? "" };

      const sighting: Sighting = {
        id: genId(),
        spotNumber,
        capturedAt: Date.now(),
        reportedBy: reporterName.get() || "Unknown",
        image: lightImage,
        description: description.trim(),
        plateNumber: normalizedPlate,
        plateState: normalizedState,
        extractionPending: false, // Phase 2: set true, then resolve via LLM
        extractionError: "",
        humanCorrected: false,
        classification: "unknown", // Phase 2: classify against registries
        notes: notes.trim(),
      };

      sightings.set([...(sightings.get() ?? []), sighting]);

      // Reset draft
      draftSpot.set("");
      draftImage.set(null);
      draftDescription.set("");
      draftPlateNumber.set("");
      draftPlateState.set("CA");
      draftNotes.set("");
      // Advance the wizard to the "saved" confirmation step — the user stays
      // on the Capture tab and can immediately capture another car.
      captureStep.set("saved");
    });

    // Wizard navigation helpers
    const goBackToPhoto = action(() => captureStep.set("photo"));
    const goBackToSpot = action(() => captureStep.set("spot"));
    const captureAnother = action(() => {
      // captureSighting already cleared the drafts; just rewind the step.
      captureStep.set("photo");
    });
    // "Discard" from the spot/review steps when the user picked the wrong
    // photo and wants to start over.
    const discardDraft = action(() => {
      draftSpot.set("");
      draftImage.set(null);
      draftDescription.set("");
      draftPlateNumber.set("");
      draftPlateState.set("CA");
      draftNotes.set("");
      captureStep.set("photo");
    });

    const submitCapture = action(() => {
      const img = draftImage.get();
      const spot = draftSpot.get();
      if (!img || !spot) return;
      // perSession reads can be undefined before first write — fall back.
      captureSighting.send({
        spotNumber: spot,
        image: img,
        description: draftDescription.get() ?? "",
        plateNumber: draftPlateNumber.get() ?? "",
        plateState: draftPlateState.get() ?? "CA",
        notes: draftNotes.get() ?? "",
      });
    });

    const deleteSighting = action<{ id: string }>(({ id }) => {
      // Admin-gated: only active admins may delete sightings
      if (!personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")) {
        return;
      }
      sightings.set((sightings.get() ?? []).filter((s) => s.id !== id));
      deleteConfirmTarget.set(null);
    });

    const initiateDelete = action<{ id: string }>(({ id }) => {
      // Admin-gated: only show confirm dialog to active admins
      if (!personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")) {
        return;
      }
      deleteConfirmTarget.set(id);
    });

    const cancelDelete = action(() => {
      deleteConfirmTarget.set(null);
    });

    // Phase 3c: assign-to-person actions — write the plate into the shared
    // parking-coordinator people cell so sightings classify as "ours".
    const openAssign = action<{ id: string }>(({ id }) => {
      assignTarget.set(id);
      // Default to the first person's name so the picker has a sensible value.
      const first = (people.get() ?? [])[0];
      assignPersonName.set(first?.name ?? "");
    });

    const cancelAssign = action(() => {
      assignTarget.set(null);
    });

    // Reads assignTarget + assignPersonName from cells (safe inside action).
    // Writes a coordinator-shaped Vehicle into that person's vehicles array.
    // Admin-gated: only active admins may assign vehicles to people.
    const assignToPerson = action(() => {
      if (!personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")) {
        return;
      }
      const targetId = assignTarget.get();
      const personName = assignPersonName.get() ?? "";
      if (!targetId || !personName) return;

      // Find the sighting by id.
      const all = sightings.get() ?? [];
      let sightingPlate = "";
      let sightingState = "";
      for (const s of all) {
        if (s.id === targetId) {
          sightingPlate = s.plateNumber;
          sightingState = s.plateState;
          break;
        }
      }
      if (!sightingPlate) return; // no readable plate — nothing to write

      const normPlate = normalizePlateId(sightingPlate);
      const normState = sightingState.toUpperCase().trim();

      // Build a coordinator-compatible Vehicle object (extra fields fine).
      const newVehicle = {
        plateId: normPlate,
        plateState: normState,
        color: "",
        make: "",
        model: "",
      };

      // Update the people list. Two paths:
      //   (a) Named person exists → append the vehicle to their list (dedupe by
      //       plateId|state).
      //   (b) Name doesn't match anyone → CREATE a new person with this
      //       vehicle. This is the "oh, actually that's Gideon's car" path:
      //       the lot operator types a name that isn't in parking-coordinator
      //       yet, and we add Gideon + the plate in one shot instead of
      //       silently dropping the write.
      const currentPeople = people.get() ?? [];
      const trimmedName = personName.trim();
      const matchIdx = currentPeople.findIndex((p) =>
        p.name.trim().toLowerCase() === trimmedName.toLowerCase()
      );
      let updatedPeople: PersonWithVehicles[];
      if (matchIdx >= 0) {
        updatedPeople = currentPeople.map((p, i) => {
          if (i !== matchIdx) return p;
          const existing = p.vehicles ?? [];
          for (const v of existing) {
            if (
              normalizePlateId(v.plateId) === normPlate &&
              v.plateState.toUpperCase().trim() === normState
            ) {
              return p; // already there
            }
          }
          return { ...p, vehicles: [...existing, newVehicle] };
        });
      } else {
        updatedPeople = [
          ...currentPeople,
          { name: trimmedName, vehicles: [newVehicle] },
        ];
      }
      people.set(updatedPeople);
      assignTarget.set(null);
    });

    // Guest name flow actions.
    const openGuest = action<{ id: string }>(({ id }) => {
      guestTarget.set(id);
      guestName.set("");
    });

    const cancelGuest = action(() => {
      guestTarget.set(null);
    });

    // Reads guestTarget (sighting id) + guestName from cells; writes to registry.
    const saveGuest = action(() => {
      // Admin-gated: only active admins may curate guests
      if (!personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")) {
        return;
      }
      const targetId = guestTarget.get();
      if (!targetId) return;

      // Find the sighting to get its plate/state.
      const all = sightings.get() ?? [];
      let sightingPlate = "";
      let sightingState = "";
      for (const s of all) {
        if (s.id === targetId) {
          sightingPlate = s.plateNumber;
          sightingState = s.plateState;
          break;
        }
      }
      if (!sightingPlate) return; // no readable plate

      const normPlate = normalizePlateId(sightingPlate);
      const normState = sightingState.toUpperCase().trim().slice(0, 2);
      const guestNameVal = guestName.get() ?? "";

      // Write directly to registry (same logic as markVehicle).
      const entry: KnownVehicle = {
        plateNumber: normPlate,
        plateState: normState,
        description: "",
        category: "guest",
        name: guestNameVal,
        org: "",
        label: "",
      };
      const current = knownVehicles.get() ?? [];
      let found = false;
      const updated: KnownVehicle[] = [];
      for (const kv of current) {
        if (
          normalizePlateId(kv.plateNumber) === normPlate &&
          kv.plateState.toUpperCase().trim() === normState
        ) {
          updated.push({ ...kv, category: "guest", name: guestNameVal });
          found = true;
        } else {
          updated.push(kv);
        }
      }
      if (!found) updated.push(entry);
      knownVehicles.set(updated);
      guestTarget.set(null);
    });

    // Phase 3b: curation actions — add/update a plate in the known registry.
    // Admin-gated: only active admins may curate the registry.
    const markVehicle = action<{
      plateNumber: string;
      plateState: string;
      category: "guest" | "offender";
      org: string;
      label?: string;
      name?: string;
    }>(({ plateNumber, plateState, category, org, label, name }) => {
      if (!personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")) {
        return;
      }
      const normPlate = normalizePlateId(plateNumber);
      const normState = plateState.toUpperCase().trim().slice(0, 2);
      const entry: KnownVehicle = {
        plateNumber: normPlate,
        plateState: normState,
        description: "",
        category,
        name: name ?? "",
        org: org ?? "",
        label: label ?? "",
      };
      const current = knownVehicles.get() ?? [];
      // Dedupe: if plate|state already exists, update category/org/label/name.
      let found = false;
      const updated: KnownVehicle[] = [];
      for (const kv of current) {
        if (
          normalizePlateId(kv.plateNumber) === normPlate &&
          kv.plateState.toUpperCase().trim() === normState
        ) {
          updated.push({
            ...kv,
            category,
            name: name ?? kv.name,
            org: org ?? kv.org,
            label: label ?? kv.label,
          });
          found = true;
        } else {
          updated.push(kv);
        }
      }
      if (!found) updated.push(entry);
      knownVehicles.set(updated);
    });

    const removeKnownVehicle = action<{
      plateNumber: string;
      plateState: string;
    }>(({ plateNumber, plateState }) => {
      if (!personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")) {
        return;
      }
      const normPlate = normalizePlateId(plateNumber);
      const normState = plateState.toUpperCase().trim();
      knownVehicles.set(
        (knownVehicles.get() ?? []).filter(
          (kv) =>
            !(normalizePlateId(kv.plateNumber) === normPlate &&
              kv.plateState.toUpperCase().trim() === normState),
        ),
      );
    });

    // ---- Pre-computed display data (avoid OpaqueCell closures in .map()) ----

    // Active spots for the spot picker. We read the perSession `draftSpot`
    // HERE (top-level computed) and emit `selected` per spot — reading it in a
    // `computed()` nested inside the `.map()` below silently returns undefined
    // (a narrower perSession cell can't be followed from this space-scoped
    // render context), so the selected highlight would never update.
    const activeSpots = computed(() => {
      const chosen = draftSpot.get();
      return (spots.get() ?? []).filter((s) => {
        // active field may be undefined on spots from coordinator — treat as active
        const isActive = (s as ParkingSpot).active;
        return isActive === undefined || isActive === true;
      }).map((s) => ({
        spotNumber: s.spotNumber,
        label: s.label,
        selected: chosen === s.spotNumber,
      }));
    });

    // Sightings in reverse-chronological order with display-ready data.
    // Phase 3b: classification is derived LIVE from registries here — not from
    // s.classification — so promoting a plate instantly reclassifies all rows.
    const sightingRows = computed(() => {
      // Use .map() directly on the cell array (spread `[...cell.get()]` throws
      // "not iterable" inside a computed), then reverse the resulting plain
      // array for newest-first order.
      const all = sightings.get() ?? [];

      // Phase 3b: read registries ONCE at the top of this computed.
      const ourVehicles = (people.get() ?? []).flatMap(
        (p) => p.vehicles ?? [],
      );
      const knownList = knownVehicles.get() ?? [];

      // GOTCHA §1: read adminMode + reporterName HERE at the top of this
      // computed and bake plain booleans per row. Do NOT read perSession cells
      // in a computed() nested inside the .map() below — it silently never
      // re-renders.
      const isAdminValue = adminMode.get() &&
        personIsLotWatchAdmin(adminRegistry, reporterName.get() || "");

      // Per-row inline-open state. We read the perSession "which row's form is
      // open" cells HERE, at the top of this computed, and emit a plain boolean
      // per row. Defining a `computed()` *inside* the `.map()` below that reads
      // these perSession cells does NOT reliably re-render when they change;
      // deriving the flags in this single top-level computed does.
      const confirmId = deleteConfirmTarget.get();
      const guestId = guestTarget.get();
      const assignId = assignTarget.get();

      const repeatKeys = new Set(
        groupSightingsByPlate(all)
          .filter((g) => g.isRepeat)
          .map((g) => plateKey(g.plate, g.state)),
      );
      return all.map((s) => {
        const date = new Date(s.capturedAt); // capturedAt is a plain number stored in perSpace
        const dateStr = date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const timeStr = date.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        const plateDisplay = s.plateNumber
          ? `${s.plateNumber}${s.plateState ? " (" + s.plateState + ")" : ""}`
          : "";
        const imgSrc = s.image?.url ?? "";
        // Phase 3b: live classification from registries (not stored field)
        const cls = classifyPlate(
          s.plateNumber,
          s.plateState,
          ourVehicles,
          knownList,
        );
        // Phase 3b: show curation buttons only for unknown plates with a
        // readable plate number. Pre-compute plate/state as plain strings so
        // the onClick arrow can read them without touching any cell.
        const canMark = cls === "unknown" && !!s.plateNumber;
        // Phase 3c: "assign to person" button — show when plate is readable
        // and currently unknown (same gate as canMark, kept separate for clarity).
        const canAssign = !!s.plateNumber && cls === "unknown";
        // knownTag: supplemental label shown next to the classification chip.
        // For guests: the optional name. For offenders: the org name.
        let knownTag = "";
        if (cls === "guest" || cls === "offender") {
          const normPlate = normalizePlateId(s.plateNumber);
          const normState = s.plateState.toUpperCase().trim();
          for (const kv of knownList) {
            if (
              normalizePlateId(kv.plateNumber) === normPlate &&
              kv.plateState.toUpperCase().trim() === normState
            ) {
              knownTag = cls === "guest" ? (kv.name ?? "") : (kv.org ?? "");
              break;
            }
          }
        }
        return {
          id: s.id,
          spotNumber: s.spotNumber,
          description: s.description,
          plateDisplay,
          plateNumber: s.plateNumber,
          plateState: s.plateState,
          reportedBy: s.reportedBy,
          dateStr,
          timeStr,
          imgSrc,
          notes: s.notes,
          classificationLabel: cls,
          classificationColor: classificationColor(cls),
          classificationBg: classificationBg(cls),
          isRepeat: s.plateNumber
            ? repeatKeys.has(plateKey(s.plateNumber, s.plateState))
            : false,
          canMark,
          canAssign,
          canCurate: isAdminValue, // baked boolean — GOTCHA §1
          knownTag,
          isConfirmOpen: confirmId === s.id,
          isGuestOpen: guestId === s.id,
          isAssignOpen: assignId === s.id,
        };
      }).reverse();
    });

    // Phase 3: repeat offenders — plates seen 2+ times, newest activity first.
    const repeatOffenders = computed(() =>
      groupSightingsByPlate(sightings.get() ?? [])
        .filter((g) => g.isRepeat)
        .map((g) => ({
          plate: g.plate,
          state: g.state,
          description: g.description,
          count: g.count,
          spotsLabel: g.spots.map((n) => "#" + n).join(", "),
          firstSeen: fmtWhen(g.firstSeen),
          lastSeen: fmtWhen(g.lastSeen),
        }))
        .sort((a, b) => b.count - a.count)
    );
    const hasRepeatOffenders = computed(() =>
      groupSightingsByPlate(sightings.get() ?? []).some((g) => g.isRepeat)
    );

    // Save is disabled until an image is captured AND a spot is chosen.
    // (Read writables with .get() and return a real boolean — referencing a
    // computed inside JSX props and negating it would coerce the cell object,
    // not its value.)
    // Reverse-chron count for the Sightings header / empty-state.
    const sightingCount = computed(() => (sightings.get() ?? []).length);
    const noSightings = computed(() => (sightings.get() ?? []).length === 0);

    // Tab visibility — used as ternary conditions directly in JSX. NOTE:
    // perSession `.get()` returns `undefined` until first written (the
    // constructor default is NOT returned by `.get()`), so fall back to
    // "capture" — otherwise the whole body renders blank on first load.
    const isCaptureTab = computed(() =>
      (selectedTab.get() ?? "capture") === "capture"
    );
    const isSightingsTab = computed(() => selectedTab.get() === "sightings");
    const isReportTab = computed(() => selectedTab.get() === "report");

    // Wizard step gates — same `?? "photo"` fallback pattern as `isCaptureTab`
    // (perSession defaults aren't returned by `.get()` on first read).
    const isPhotoStep = computed(() =>
      (captureStep.get() ?? "photo") === "photo"
    );
    const isSpotStep = computed(() => captureStep.get() === "spot");
    const isReviewStep = computed(() => captureStep.get() === "review");
    const isSavedStep = computed(() => captureStep.get() === "saved");

    // Source for the in-flight draft photo — prefer the transient `data` URL
    // (set by `includeData`) so the user sees their photo immediately even
    // before the blob has been served back. Falls back to the blob `url`.
    const draftImageSrc = computed(() => {
      const img = draftImage.get();
      return img?.data ?? img?.url ?? "";
    });
    // "Spot #X — label" for the review step header.
    const draftSpotLabel = computed(() => {
      const num = draftSpot.get();
      if (!num) return "";
      const found = (spots.get() ?? []).find((s) => s.spotNumber === num);
      const lbl = found?.label;
      return lbl ? `Spot #${num} — ${lbl}` : `Spot #${num}`;
    });

    // DESIGN §6: only `adminModeEnabled` survives the single-button curator
    // collapse — the multi-admin computeds (currentPersonIsAdmin /
    // currentUserCanManageAdmins / adminAccessRows / reporterAdminInfo) were
    // removed along with the old Admin Panel UI they fed; the gating itself
    // still keys on personIsLotWatchAdmin(reporterName) per action.
    const adminModeEnabled = computed(() =>
      adminMode.get() &&
      personIsLotWatchAdmin(adminRegistry, reporterName.get() || "")
    );

    // DESIGN §10: Report tab computeds — all over PerSpace sightings (guard ?? [])
    // Spot occupancy frequency — derived from the `spots` cell (NOT a hardcoded
    // ["1","5","12","13"] list) so the report stays correct when spots are
    // added/removed/relabeled in parking-coordinator.
    const spotOccupancy = computed(() => {
      const all = sightings.get() ?? [];
      const ourVehicles = (people.get() ?? []).flatMap((p) => p.vehicles ?? []);
      const knownList = knownVehicles.get() ?? [];
      const allSpots = (spots.get() ?? []).filter((s) => {
        const isActive = (s as ParkingSpot).active;
        return isActive === undefined || isActive === true;
      });
      return allSpots.map((spot) => {
        const spotNum = spot.spotNumber;
        const forSpot = all.filter((s) => s.spotNumber === spotNum);
        const nonOurs = forSpot.filter((s) => {
          const cls = classifyPlate(
            s.plateNumber,
            s.plateState,
            ourVehicles,
            knownList,
          );
          return cls !== "ours";
        });
        return {
          spotNum,
          total: forSpot.length,
          nonOursCount: nonOurs.length,
        };
      });
    });

    // Repeat-offender leaderboard: offender-classified plates ranked by count,
    // plus frequent unknowns (seen 3+ times)
    const offenderLeaderboard = computed(() => {
      const all = sightings.get() ?? [];
      const ourVehicles = (people.get() ?? []).flatMap((p) => p.vehicles ?? []);
      const knownList = knownVehicles.get() ?? [];
      const groups = groupSightingsByPlate(all);
      return groups
        .filter((g) => {
          // Find the classification of this plate group
          if (!g.plate) return false;
          const cls = classifyPlate(g.plate, g.state, ourVehicles, knownList);
          // Include offenders + frequent unknowns (3+ sightings)
          return cls === "offender" || (cls === "unknown" && g.count >= 3);
        })
        .map((g) => {
          const cls = classifyPlate(g.plate, g.state, ourVehicles, knownList);
          // Find org/name from registry for offenders
          let org = "";
          if (cls === "offender") {
            const normP = normalizePlateId(g.plate);
            const normS = g.state.toUpperCase().trim();
            for (const kv of knownList) {
              if (
                normalizePlateId(kv.plateNumber) === normP &&
                kv.plateState.toUpperCase().trim() === normS
              ) {
                org = kv.org ?? "";
                break;
              }
            }
          }
          return {
            plate: g.plate,
            state: g.state,
            description: g.description,
            count: g.count,
            spotsLabel: g.spots.map((n) => "#" + n).join(", "),
            lastSeen: fmtWhen(g.lastSeen),
            cls,
            org,
          };
        })
        .sort((a, b) => b.count - a.count);
    });

    // Recent activity feed — reverse-chron with filters applied
    const recentActivity = computed(() => {
      const all = sightings.get() ?? [];
      const ourVehicles = (people.get() ?? []).flatMap((p) => p.vehicles ?? []);
      const knownList = knownVehicles.get() ?? [];
      const filterSpot = reportFilterSpot.get() ?? "";
      const filterCls = reportFilterClassification.get() ?? "";

      return all
        .map((s) => {
          const cls = classifyPlate(
            s.plateNumber,
            s.plateState,
            ourVehicles,
            knownList,
          );
          const capturedAtMs = Number(s.capturedAt);
          return {
            id: s.id,
            spotNumber: s.spotNumber,
            imgSrc: s.image?.url ?? "",
            reportedBy: s.reportedBy,
            when: fmtWhen(capturedAtMs),
            capturedAt: capturedAtMs,
            cls,
            clsColor: classificationColor(cls),
            clsBg: classificationBg(cls),
            plateDisplay: s.plateNumber
              ? `${s.plateNumber}${
                s.plateState ? " (" + s.plateState + ")" : ""
              }`
              : "",
            description: s.description,
          };
        })
        .filter((r) => {
          if (filterSpot && r.spotNumber !== filterSpot) return false;
          if (filterCls && r.cls !== filterCls) return false;
          return true;
        })
        .sort((a, b) => b.capturedAt - a.capturedAt);
    });

    // Boolean gates for report tab empty states
    const noRecentActivity = computed(() => {
      const all = sightings.get() ?? [];
      const filterSpot = reportFilterSpot.get() ?? "";
      const filterCls = reportFilterClassification.get() ?? "";
      const ourVehicles = (people.get() ?? []).flatMap((p) => p.vehicles ?? []);
      const knownList = knownVehicles.get() ?? [];
      if (all.length === 0) return true;
      for (const s of all) {
        if (filterSpot && s.spotNumber !== filterSpot) continue;
        if (filterCls) {
          const cls = classifyPlate(
            s.plateNumber,
            s.plateState,
            ourVehicles,
            knownList,
          );
          if (cls !== filterCls) continue;
        }
        return false; // found at least one match
      }
      return true;
    });

    // Filter options for report tab
    const reportSpotOptions = computed(() => {
      const all = sightings.get() ?? [];
      const usedSpots = [...new Set(all.map((s) => s.spotNumber))].sort();
      return [
        { label: "All spots", value: "" },
        ...usedSpots.map((s) => ({ label: `Spot #${s}`, value: s })),
      ];
    });
    const reportClsOptions = [
      { label: "All classifications", value: "" },
      { label: "Ours", value: "ours" },
      { label: "Guest", value: "guest" },
      { label: "Offender", value: "offender" },
      { label: "Unknown", value: "unknown" },
    ];

    // State select items
    const stateSelectItems = US_STATES.map((s) => ({ label: s, value: s }));

    // Phase 3c: gate the assign picker's chip list on whether any people
    // exist. The chips themselves map `people` directly (recipe A from
    // `gotchas/closure-capture-in-nested-map.md` — works post-CT-1626).
    const hasPeople = computed(() => (people.get() ?? []).length > 0);
    // Disable "Become curator" until a reporter identity exists; the admin
    // role keys on `reporterName`.
    const noReporterName = computed(() => !(reporterName.get() ?? "").trim());

    // ---- UI ----

    return {
      [NAME]: "Lot Watch",
      [UI]: (
        <cf-screen>
          {/* Header with tab navigation */}
          <div
            slot="header"
            style="padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; border-bottom: 1px solid var(--cf-colors-gray-200);"
          >
            <cf-hstack justify="between" align="center">
              <cf-heading level={4}>Lot Watch</cf-heading>
              <cf-hstack gap="1" align="center">
                {
                  /* One-click curator toggle — collapses the parking-coordinator
                    CFC ceremony (enable manager → toggle role → flip view) into
                    a single button per `becomeCurator` / `stepDownCurator`. */
                }
                {adminModeEnabled
                  ? (
                    <cf-button
                      variant="primary"
                      size="sm"
                      onClick={() => stepDownCurator.send()}
                    >
                      🔒 Step down
                    </cf-button>
                  )
                  : (
                    <cf-button
                      variant="secondary"
                      size="sm"
                      disabled={noReporterName}
                      onClick={() => becomeCurator.send()}
                    >
                      🔓 Curator mode
                    </cf-button>
                  )}
              </cf-hstack>
            </cf-hstack>
            <cf-hstack gap="2">
              <cf-button
                variant={computed(() =>
                  (selectedTab.get() ?? "capture") === "capture"
                    ? "primary"
                    : "secondary"
                )}
                size="sm"
                onClick={() => selectTab.send({ tab: "capture" })}
              >
                📸 Capture
              </cf-button>
              <cf-button
                variant={computed(() =>
                  selectedTab.get() === "sightings" ? "primary" : "secondary"
                )}
                size="sm"
                onClick={() => selectTab.send({ tab: "sightings" })}
              >
                🚗 Sightings
              </cf-button>
              <cf-button
                variant={computed(() =>
                  selectedTab.get() === "report" ? "primary" : "secondary"
                )}
                size="sm"
                onClick={() => selectTab.send({ tab: "report" })}
              >
                📊 Report
              </cf-button>
            </cf-hstack>
          </div>

          <cf-vscroll flex>
            <cf-vstack gap="3" style="padding: 1rem;">
              {/* ====== CAPTURE TAB ====== */}
              {isCaptureTab
                ? (
                  <cf-vstack gap="3">
                    {
                      /* Persistent reporter banner (always visible, small).
                        Identity comes from the viewer's shared profile: the
                        wish UI handles create/pick, then one click adopts the
                        resolved name as the reporter. */
                    }
                    <cf-card style="padding: 0.5rem 0.75rem;">
                      <cf-hstack
                        justify="between"
                        align="center"
                        gap="2"
                        wrap
                      >
                        <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); white-space: nowrap;">
                          Reporting as
                        </span>
                        {hasReporter
                          ? (
                            <cf-hstack gap="2" align="center">
                              <cf-avatar
                                src={reporterAvatar}
                                name={reporterLabel}
                                size="xs"
                              />
                              <span style="font-size: 0.875rem;">
                                {reporterLabel}
                              </span>
                            </cf-hstack>
                          )
                          : hasProfile
                          ? (
                            <cf-button
                              size="sm"
                              onClick={() => adoptProfileName.send()}
                            >
                              Report as {profileName}
                            </cf-button>
                          )
                          : (
                            <div style="flex: 1; min-width: 160px;">
                              {profileWish[UI]}
                            </div>
                          )}
                      </cf-hstack>
                    </cf-card>

                    {/* STEP 1 — Photo */}
                    {isPhotoStep
                      ? (
                        <cf-card>
                          <cf-vstack gap="3" align="center">
                            <cf-heading level={5}>
                              Step 1 of 3 — Take a photo
                            </cf-heading>
                            <span style="text-align: center; font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                              Photograph the car. We'll read the plate
                              automatically while you pick the spot.
                            </span>
                            {
                              /* `includeData` gives the draft both `url` (blob
                                store) and inline `data` for transient LLM use.
                                We persist only the `url` into the sighting; see
                                captureSighting. Idiom per group-chat-room.tsx. */
                            }
                            <cf-image-input
                              capture="environment"
                              includeData
                              showPreview={false}
                              buttonText="📸 Photograph the car"
                              oncf-change={onPhotoCaptured({
                                draftImage,
                                captureStep,
                              })}
                            />
                          </cf-vstack>
                        </cf-card>
                      )
                      : null}

                    {/* STEP 2 — Pick a spot (show the photo big) */}
                    {isSpotStep
                      ? (
                        <cf-vstack gap="2">
                          <cf-card>
                            <cf-vstack gap="2" align="center">
                              <cf-heading level={5}>
                                Step 2 of 3 — Which spot?
                              </cf-heading>
                              {computed(() => {
                                const src = draftImageSrc;
                                return src
                                  ? (
                                    <img
                                      src={src}
                                      alt="Captured car"
                                      style="max-width: 100%; max-height: 240px; object-fit: contain; border-radius: 6px;"
                                    />
                                  )
                                  : null;
                              })}
                            </cf-vstack>
                          </cf-card>
                          <cf-card>
                            <cf-vstack gap="2">
                              <cf-hstack gap="2" wrap justify="center">
                                {activeSpots.map((spot) => {
                                  const spotNum = spot.spotNumber;
                                  return (
                                    <cf-button
                                      variant={spot.selected
                                        ? "primary"
                                        : "secondary"}
                                      size="lg"
                                      onClick={() =>
                                        setDraftSpot.send({ spot: spotNum })}
                                    >
                                      #{spotNum}
                                      {spot.label
                                        ? (
                                          <span style="font-size: 0.75rem; margin-left: 4px; opacity: 0.8;">
                                            {spot.label}
                                          </span>
                                        )
                                        : null}
                                    </cf-button>
                                  );
                                })}
                              </cf-hstack>
                              <cf-hstack gap="2" justify="between">
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => goBackToPhoto.send()}
                                >
                                  ← Different photo
                                </cf-button>
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => discardDraft.send()}
                                >
                                  Discard
                                </cf-button>
                              </cf-hstack>
                            </cf-vstack>
                          </cf-card>
                        </cf-vstack>
                      )
                      : null}

                    {/* STEP 3 — Confirm (LLM extraction + editable fields) */}
                    {isReviewStep
                      ? (
                        <cf-vstack gap="2">
                          {/* Header: thumbnail + spot */}
                          <cf-card>
                            <cf-vstack gap="2">
                              <cf-heading level={5}>
                                Step 3 of 3 — Confirm
                              </cf-heading>
                              <cf-hstack gap="2" align="center">
                                {computed(() => {
                                  const src = draftImageSrc;
                                  return src
                                    ? (
                                      <img
                                        src={src}
                                        alt="Car"
                                        style="width: 120px; height: 90px; object-fit: cover; border-radius: 6px;"
                                      />
                                    )
                                    : null;
                                })}
                                <span style="font-weight: 600; font-size: 0.95rem;">
                                  {draftSpotLabel}
                                </span>
                              </cf-hstack>
                            </cf-vstack>
                          </cf-card>

                          {/* AI extraction panel */}
                          <cf-card style="border-left: 3px solid #6366f1;">
                            <cf-vstack gap="1">
                              <span style="font-weight: 600; font-size: 0.875rem;">
                                ✨ AI extracted
                              </span>
                              {isPending(extractionRequest)
                                ? (
                                  <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                                    Reading the plate…
                                  </span>
                                )
                                : hasError(extractionRequest)
                                ? (
                                  <span style="font-size: 0.875rem; color: #991b1b;">
                                    Couldn't read the plate — fill it in
                                    manually below.
                                  </span>
                                )
                                : (
                                  <cf-vstack gap="0">
                                    <span style="font-size: 0.875rem;">
                                      {extraction.description}
                                    </span>
                                    <span style="font-size: 0.875rem; font-family: monospace; font-weight: 500;">
                                      {extraction.plateNumber}{" "}
                                      {extraction.plateState}
                                    </span>
                                    <span style="font-size: 0.7rem; color: var(--cf-colors-gray-500);">
                                      confidence: {extraction.confidence}
                                    </span>
                                    <cf-button
                                      variant="secondary"
                                      size="sm"
                                      style="margin-top: 0.5rem; align-self: flex-start;"
                                      onClick={() => applyExtraction.send()}
                                    >
                                      ↻ Use AI's reading
                                    </cf-button>
                                  </cf-vstack>
                                )}
                            </cf-vstack>
                          </cf-card>

                          {/* Editable fields (pre-filled by setDraftSpot) */}
                          <cf-card>
                            <cf-vstack gap="2">
                              <cf-vstack gap="1">
                                <span style="font-size: 0.75rem; font-weight: 500;">
                                  Description
                                </span>
                                <cf-input
                                  $value={draftDescription}
                                  placeholder="e.g. black Subaru Outback"
                                  style="width: 100%;"
                                />
                              </cf-vstack>
                              <cf-hstack gap="2" wrap>
                                <cf-vstack
                                  gap="1"
                                  style="flex: 1; min-width: 120px;"
                                >
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Plate Number
                                  </span>
                                  <cf-input
                                    $value={draftPlateNumber}
                                    placeholder="e.g. 7ABC123"
                                    style="width: 100%; text-transform: uppercase;"
                                  />
                                </cf-vstack>
                                <cf-vstack gap="1" style="min-width: 100px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    State
                                  </span>
                                  <cf-select
                                    $value={draftPlateState}
                                    items={stateSelectItems}
                                  />
                                </cf-vstack>
                              </cf-hstack>
                              <cf-vstack gap="1">
                                <span style="font-size: 0.75rem; font-weight: 500;">
                                  Notes (optional)
                                </span>
                                <cf-input
                                  $value={draftNotes}
                                  placeholder="e.g. blocked the dumpster"
                                  style="width: 100%;"
                                />
                              </cf-vstack>
                            </cf-vstack>
                          </cf-card>

                          {/* Save + back */}
                          <cf-hstack gap="2" justify="between">
                            <cf-button
                              variant="ghost"
                              size="sm"
                              onClick={() => goBackToSpot.send()}
                            >
                              ← Change spot
                            </cf-button>
                            <cf-button
                              variant="primary"
                              size="lg"
                              onClick={() => submitCapture.send()}
                            >
                              ✓ Save sighting
                            </cf-button>
                          </cf-hstack>
                        </cf-vstack>
                      )
                      : null}

                    {/* STEP 4 — Saved confirmation */}
                    {isSavedStep
                      ? (
                        <cf-card>
                          <cf-vstack
                            gap="3"
                            align="center"
                            style="padding: 1rem;"
                          >
                            <span style="font-size: 3rem;">✅</span>
                            <cf-heading level={5}>Sighting saved!</cf-heading>
                            <cf-hstack gap="2" wrap justify="center">
                              <cf-button
                                variant="primary"
                                size="lg"
                                onClick={() => captureAnother.send()}
                              >
                                📸 Capture another
                              </cf-button>
                              <cf-button
                                variant="ghost"
                                onClick={() =>
                                  selectTab.send({ tab: "sightings" })}
                              >
                                🚗 View sightings
                              </cf-button>
                            </cf-hstack>
                          </cf-vstack>
                        </cf-card>
                      )
                      : null}
                  </cf-vstack>
                )
                : null}

              {/* ====== SIGHTINGS TAB ====== */}
              {isSightingsTab
                ? (
                  <cf-vstack gap="2">
                    <cf-heading level={6}>
                      Sightings ({sightingCount})
                    </cf-heading>

                    {noSightings
                      ? (
                        <cf-card>
                          <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                            No sightings yet. Use 📸 Capture to document a car
                            in one of your spots.
                          </span>
                        </cf-card>
                      )
                      : null}

                    {/* Phase 3: repeat offenders (plates seen 2+ times) */}
                    {hasRepeatOffenders
                      ? (
                        <cf-card style="background: #fef2f2; border: 1px solid #fecaca;">
                          <cf-vstack gap="2">
                            <cf-heading level={6}>
                              🔁 Repeat offenders
                            </cf-heading>
                            {repeatOffenders.map((g) => (
                              <cf-hstack
                                justify="between"
                                align="center"
                                gap="2"
                                wrap
                              >
                                <cf-vstack gap="0">
                                  <span style="font-weight: 600; font-family: monospace;">
                                    {g.plate} ({g.state})
                                  </span>
                                  <span style="font-size: 0.75rem; color: var(--cf-colors-gray-600);">
                                    {g.description} · spots {g.spotsLabel}
                                  </span>
                                  <span style="font-size: 0.7rem; color: var(--cf-colors-gray-500);">
                                    {g.firstSeen} → {g.lastSeen}
                                  </span>
                                </cf-vstack>
                                <span
                                  style={{
                                    padding: "2px 10px",
                                    borderRadius: "9999px",
                                    backgroundColor: "#991b1b",
                                    color: "white",
                                    fontSize: "0.75rem",
                                    fontWeight: "700",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {g.count}× seen
                                </span>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        </cf-card>
                      )
                      : null}

                    {sightingRows.map((row) => {
                      const rowId = row.id;
                      // Per-row open-state booleans are derived in the
                      // `sightingRows` computed (see note there) — reading the
                      // perSession target cells in a `computed()` nested in this
                      // `.map()` does not reliably re-render.
                      const isConfirmTarget = row.isConfirmOpen;
                      const isAssignTarget = row.isAssignOpen;
                      const isGuestTarget = row.isGuestOpen;
                      return (
                        <cf-card>
                          <cf-vstack gap="2">
                            {/* Thumbnail + spot header */}
                            <cf-hstack gap="2" align="start">
                              {row.imgSrc
                                ? (
                                  <img
                                    src={row.imgSrc}
                                    style="width: 80px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0;"
                                    alt="Sighting photo"
                                  />
                                )
                                : (
                                  <div style="width: 80px; height: 60px; background: var(--cf-colors-gray-100); border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 1.5rem;">
                                    🚗
                                  </div>
                                )}
                              <cf-vstack gap="1" style="flex: 1; min-width: 0;">
                                <cf-hstack
                                  justify="between"
                                  align="center"
                                  gap="1"
                                  wrap
                                >
                                  <span style="font-weight: 600; font-size: 0.875rem;">
                                    Spot #{row.spotNumber}
                                  </span>
                                  <cf-hstack gap="1" align="center">
                                    <span
                                      style={{
                                        display: "inline-block",
                                        padding: "2px 8px",
                                        borderRadius: "9999px",
                                        backgroundColor: row.classificationBg,
                                        color: row.classificationColor,
                                        fontSize: "0.7rem",
                                        fontWeight: "600",
                                        textTransform: "uppercase",
                                      }}
                                    >
                                      {row.classificationLabel}
                                    </span>
                                    {row.knownTag
                                      ? (
                                        <span
                                          style={{
                                            fontSize: "0.7rem",
                                            color: row.classificationColor,
                                          }}
                                        >
                                          {row.knownTag}
                                        </span>
                                      )
                                      : null}
                                  </cf-hstack>
                                  {row.isRepeat
                                    ? (
                                      <span
                                        style={{
                                          padding: "2px 8px",
                                          borderRadius: "9999px",
                                          backgroundColor: "#991b1b",
                                          color: "white",
                                          fontSize: "0.7rem",
                                          fontWeight: "700",
                                        }}
                                      >
                                        🔁 repeat
                                      </span>
                                    )
                                    : null}
                                </cf-hstack>
                                {row.description
                                  ? (
                                    <span style="font-size: 0.875rem;">
                                      {row.description}
                                    </span>
                                  )
                                  : null}
                                {row.plateDisplay
                                  ? (
                                    <span style="font-size: 0.875rem; font-family: monospace; font-weight: 500;">
                                      {row.plateDisplay}
                                    </span>
                                  )
                                  : null}
                              </cf-vstack>
                            </cf-hstack>

                            {/* Notes */}
                            {row.notes
                              ? (
                                <span style="font-size: 0.75rem; color: var(--cf-colors-gray-600); font-style: italic; padding: 0.375rem 0.5rem; background: var(--cf-colors-gray-50); border-radius: 4px;">
                                  {row.notes}
                                </span>
                              )
                              : null}

                            {/* Phase 3b: curation buttons — gated on canMark AND canCurate (admin) */}
                            {row.canMark && row.canCurate
                              ? (
                                <cf-vstack gap="1">
                                  {/* Guest flow: button → inline form */}
                                  {isGuestTarget
                                    ? (
                                      <cf-card style="border-left: 3px solid #1e40af; padding: 0.5rem;">
                                        <cf-vstack gap="2">
                                          <span style="font-size: 0.75rem; font-weight: 600;">
                                            Mark as guest
                                          </span>
                                          <cf-input
                                            $value={guestName}
                                            placeholder="Guest name (optional)"
                                            style="width: 100%;"
                                          />
                                          <cf-hstack gap="1">
                                            <cf-button
                                              variant="primary"
                                              size="sm"
                                              onClick={() => saveGuest.send()}
                                            >
                                              Save guest
                                            </cf-button>
                                            <cf-button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() => cancelGuest.send()}
                                            >
                                              Cancel
                                            </cf-button>
                                          </cf-hstack>
                                        </cf-vstack>
                                      </cf-card>
                                    )
                                    : (
                                      <cf-hstack gap="1" wrap>
                                        <cf-button
                                          variant="secondary"
                                          size="sm"
                                          onClick={() =>
                                            openGuest.send({ id: rowId })}
                                        >
                                          Mark guest
                                        </cf-button>
                                        <cf-button
                                          variant="secondary"
                                          size="sm"
                                          onClick={() =>
                                            markVehicle.send({
                                              plateNumber: row.plateNumber,
                                              plateState: row.plateState,
                                              category: "offender",
                                              org: "Local Butcher Shop",
                                            })}
                                        >
                                          Mark offender
                                        </cf-button>
                                        {/* Phase 3c: admin-gate */}
                                      </cf-hstack>
                                    )}
                                </cf-vstack>
                              )
                              : null}

                            {/* Phase 3c: "assign to known person" — gated on canAssign AND canCurate (admin) */}
                            {row.canAssign && row.canCurate
                              ? (
                                <cf-vstack gap="1">
                                  {isAssignTarget
                                    ? (
                                      <cf-card style="border-left: 3px solid #6366f1; padding: 0.5rem;">
                                        <cf-vstack gap="2">
                                          <span style="font-size: 0.75rem; font-weight: 600;">
                                            👤 Whose car is this?
                                          </span>
                                          <cf-input
                                            $value={assignPersonName}
                                            placeholder="e.g. Mary, or a new name like Gideon"
                                            style="width: 100%;"
                                          />
                                          {
                                            /* Quick-pick chips for existing
                                              people. A new name typed into the
                                              input also works — assignToPerson
                                              creates the person in the shared
                                              parking-coordinator `people` cell
                                              if no name matches. */
                                          }
                                          {hasPeople
                                            ? (
                                              <cf-hstack gap="1" wrap>
                                                {people.map((p) => (
                                                  <cf-button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                      setAssignPersonName.send(
                                                        { name: p.name },
                                                      )}
                                                  >
                                                    {p.name}
                                                  </cf-button>
                                                ))}
                                              </cf-hstack>
                                            )
                                            : null}
                                          <cf-hstack gap="1">
                                            <cf-button
                                              variant="primary"
                                              size="sm"
                                              onClick={() =>
                                                assignToPerson.send()}
                                            >
                                              Add to their vehicles
                                            </cf-button>
                                            <cf-button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() =>
                                                cancelAssign.send()}
                                            >
                                              Cancel
                                            </cf-button>
                                          </cf-hstack>
                                        </cf-vstack>
                                      </cf-card>
                                    )
                                    : (
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          openAssign.send({ id: rowId })}
                                      >
                                        👤 It's a known person's car
                                      </cf-button>
                                    )}
                                </cf-vstack>
                              )
                              : null}

                            {/* Footer: reporter + time + delete */}
                            <cf-hstack justify="between" align="center" wrap>
                              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                                {row.reportedBy} — {row.dateStr} {row.timeStr}
                              </span>

                              {/* Delete — only shown to admins (canCurate) */}
                              {row.canCurate
                                ? isConfirmTarget
                                  ? (
                                    <cf-hstack gap="1">
                                      <span style="font-size: 0.75rem; color: #991b1b;">
                                        Delete?
                                      </span>
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          deleteSighting.send({ id: rowId })}
                                      >
                                        Yes
                                      </cf-button>
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => cancelDelete.send()}
                                      >
                                        No
                                      </cf-button>
                                    </cf-hstack>
                                  )
                                  : (
                                    <cf-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        initiateDelete.send({ id: rowId })}
                                    >
                                      ×
                                    </cf-button>
                                  )
                                : null}
                            </cf-hstack>
                          </cf-vstack>
                        </cf-card>
                      );
                    })}
                  </cf-vstack>
                )
                : null}

              {/* ====== REPORT TAB ====== */}
              {isReportTab
                ? (
                  <cf-vstack gap="3">
                    <cf-heading level={6}>📊 Report</cf-heading>

                    {/* Filters */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Filters</cf-heading>
                        <cf-hstack gap="2" wrap>
                          <cf-vstack gap="1" style="flex: 1; min-width: 120px;">
                            <span style="font-size: 0.75rem; font-weight: 500;">
                              Spot
                            </span>
                            <cf-select
                              $value={reportFilterSpot}
                              items={reportSpotOptions}
                            />
                          </cf-vstack>
                          <cf-vstack gap="1" style="flex: 1; min-width: 140px;">
                            <span style="font-size: 0.75rem; font-weight: 500;">
                              Classification
                            </span>
                            <cf-select
                              $value={reportFilterClassification}
                              items={reportClsOptions}
                            />
                          </cf-vstack>
                        </cf-hstack>
                      </cf-vstack>
                    </cf-card>

                    {/* Spot occupancy frequency */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Spot Occupancy</cf-heading>
                        <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                          Total sightings per spot, and how many were non-ours.
                        </span>
                        {spotOccupancy.map((row) => (
                          <cf-hstack
                            justify="between"
                            align="center"
                            gap="2"
                            style="padding: 0.375rem 0.5rem; border: 1px solid var(--cf-colors-gray-200); border-radius: 0.5rem;"
                          >
                            <span style="font-weight: 600;">
                              Spot #{row.spotNum}
                            </span>
                            <cf-hstack gap="2" align="center">
                              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-600);">
                                {row.total} total
                              </span>
                              {row.nonOursCount > 0
                                ? (
                                  <span
                                    style={{
                                      padding: "2px 8px",
                                      borderRadius: "9999px",
                                      backgroundColor: "#fee2e2",
                                      color: "#991b1b",
                                      fontSize: "0.7rem",
                                      fontWeight: "600",
                                    }}
                                  >
                                    {row.nonOursCount} non-ours
                                  </span>
                                )
                                : (
                                  <span
                                    style={{
                                      padding: "2px 8px",
                                      borderRadius: "9999px",
                                      backgroundColor: "#dcfce7",
                                      color: "#166534",
                                      fontSize: "0.7rem",
                                      fontWeight: "600",
                                    }}
                                  >
                                    all ours
                                  </span>
                                )}
                            </cf-hstack>
                          </cf-hstack>
                        ))}
                      </cf-vstack>
                    </cf-card>

                    {/* Repeat-offender leaderboard */}
                    {computed(() =>
                        groupSightingsByPlate(sightings.get() ?? []).some(
                          (g) => {
                            const cls = classifyPlate(
                              g.plate,
                              g.state,
                              (people.get() ?? []).flatMap((p) =>
                                p.vehicles ?? []
                              ),
                              knownVehicles.get() ?? [],
                            );
                            return cls === "offender" ||
                              (cls === "unknown" && g.count >= 3);
                          },
                        )
                      )
                      ? (
                        <cf-card style="background: #fef2f2; border: 1px solid #fecaca;">
                          <cf-vstack gap="2">
                            <cf-heading level={6}>
                              🚨 Offender Leaderboard
                            </cf-heading>
                            {offenderLeaderboard.map((g) => (
                              <cf-hstack
                                justify="between"
                                align="center"
                                gap="2"
                                wrap
                                style="padding: 0.375rem 0.5rem; border: 1px solid #fecaca; border-radius: 0.5rem; background: white;"
                              >
                                <cf-vstack gap="0">
                                  <cf-hstack gap="1" align="center">
                                    <span style="font-weight: 600; font-family: monospace;">
                                      {g.plate}
                                    </span>
                                    <span style="font-size: 0.7rem; color: var(--cf-colors-gray-500);">
                                      ({g.state})
                                    </span>
                                    <span
                                      style={{
                                        padding: "1px 6px",
                                        borderRadius: "9999px",
                                        backgroundColor: g.cls === "offender"
                                          ? "#fee2e2"
                                          : "#f3f4f6",
                                        color: g.cls === "offender"
                                          ? "#991b1b"
                                          : "#374151",
                                        fontSize: "0.65rem",
                                        fontWeight: "600",
                                        textTransform: "uppercase",
                                      }}
                                    >
                                      {g.cls}
                                    </span>
                                  </cf-hstack>
                                  {g.org
                                    ? (
                                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-600);">
                                        {g.org}
                                      </span>
                                    )
                                    : null}
                                  <span style="font-size: 0.7rem; color: var(--cf-colors-gray-500);">
                                    {g.description
                                      ? g.description + " · "
                                      : ""}spots {g.spotsLabel} · last{" "}
                                    {g.lastSeen}
                                  </span>
                                </cf-vstack>
                                <span
                                  style={{
                                    padding: "2px 10px",
                                    borderRadius: "9999px",
                                    backgroundColor: "#991b1b",
                                    color: "white",
                                    fontSize: "0.75rem",
                                    fontWeight: "700",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {g.count}× seen
                                </span>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        </cf-card>
                      )
                      : null}

                    {/* Recent activity feed */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Recent Activity</cf-heading>
                        {noRecentActivity
                          ? (
                            <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                              No sightings match the current filters.
                            </span>
                          )
                          : null}
                        {recentActivity.map((r) => (
                          <cf-hstack
                            gap="2"
                            align="center"
                            style="padding: 0.375rem 0; border-bottom: 1px solid var(--cf-colors-gray-100);"
                          >
                            {r.imgSrc
                              ? (
                                <img
                                  src={r.imgSrc}
                                  style="width: 48px; height: 36px; object-fit: cover; border-radius: 4px; flex-shrink: 0;"
                                  alt="Sighting"
                                />
                              )
                              : (
                                <div style="width: 48px; height: 36px; background: var(--cf-colors-gray-100); border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 1rem;">
                                  🚗
                                </div>
                              )}
                            <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                              <cf-hstack gap="1" align="center">
                                <span style="font-size: 0.8rem; font-weight: 600;">
                                  Spot #{r.spotNumber}
                                </span>
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "1px 6px",
                                    borderRadius: "9999px",
                                    backgroundColor: r.clsBg,
                                    color: r.clsColor,
                                    fontSize: "0.65rem",
                                    fontWeight: "600",
                                    textTransform: "uppercase",
                                  }}
                                >
                                  {r.cls}
                                </span>
                              </cf-hstack>
                              {r.plateDisplay
                                ? (
                                  <span style="font-size: 0.75rem; font-family: monospace;">
                                    {r.plateDisplay}
                                  </span>
                                )
                                : null}
                              <span style="font-size: 0.7rem; color: var(--cf-colors-gray-500);">
                                {r.reportedBy} · {r.when}
                              </span>
                            </cf-vstack>
                          </cf-hstack>
                        ))}
                      </cf-vstack>
                    </cf-card>
                  </cf-vstack>
                )
                : null}

              {
                /* The full multi-admin management UI (per-person Make admin /
                  Remove admin rows) was removed in favor of the single-click
                  `🔓 Curator mode` toggle in the header — the lot demo has no
                  separate "admin manager" persona to model. The CFC
                  integrity-branded gating + the underlying Streams
                  (`enableAdminManager`, `togglePersonAdmin`, `toggleAdminMode`)
                  are unchanged; only the UX collapsed. Re-add an expandable
                  multi-admin panel here if a real production deployment needs
                  separate admin assignment. */
              }
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),

      sightings,
      knownVehicles,
      people,
      captureSighting,
      deleteSighting,
      selectTab,
      setReporterName,
      markVehicle,
      removeKnownVehicle,
      openAssign,
      cancelAssign,
      assignToPerson,
      openGuest,
      cancelGuest,
      saveGuest,
      enableAdminManager,
      togglePersonAdmin,
      becomeCurator,
      stepDownCurator,
      toggleAdminMode,
    };
  },
);
