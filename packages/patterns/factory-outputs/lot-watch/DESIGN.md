# Lot Watch — Design Doc

**Status:** Draft / planning **Branch:** `parking-watch-design` **Author:**
drafted with Claude **Related pattern:**
`packages/patterns/factory-outputs/parking-coordinator/main.tsx`

---

## 1. Background & Problem

We have **4 parking spots** in the building's lot: **1, 5, 12, and 13**. They
are ours, but in practice other people park in them regularly:

- **Customers** of neighboring businesses (e.g. Local Butcher Shop) — annoying.
- **Employees** of those businesses parking in our spots — **egregious**,
  because they should know better and they do it repeatedly.

We want a lightweight way for **our employees** to document offenders from their
phone, build a record over time, and surface **repeat offenders** and **how
often each spot is taken**. The key intelligence is matching a sighting's
license plate against:

- **Our own employees** (totally fine — they belong here),
- **Our guests** (totally fine — invited),
- **Known employees of neighboring businesses** like Local Butcher Shop (**not
  fine**).

## 2. Goals

1. **Dead-simple mobile capture.** Open pattern on phone → tap to photograph the
   car → pick the spot → done. The LLM does the transcription work.
2. **Automatic extraction.** An LLM reads the photo and returns a structured
   `{ description, plateNumber, plateState }` (e.g. "black Subaru Outback",
   `7ABC123`, `CA`).
3. **Persistent record.** Keep both the original image _and_ the extraction, so
   a human can audit/correct the LLM.
4. **Classification against known plates.** Each sighting is auto-tagged `ours`
   / `guest` / `offender` / `unknown` by matching against registries.
5. **Dedup / relate.** Group sightings of the same plate (and fuzzily, same
   description) so we see "this car has been here 6 times."
6. **Reporting.** A clean report of spot-occupancy frequency and a
   repeat-offenders leaderboard.
7. **Reuse, don't duplicate.** Absorb employee vehicle/plate info from
   `parking-coordinator` rather than re-entering it.
8. **Fully idiomatic.** Use `pattern<Input, Output>`, scoped `Writable` cells
   (`PerSpace`/`PerUser`/`PerSession`), the **CFC admin** module for who may
   edit the watchlists, `generateObject` for extraction, and `cf-*` components
   for a clean responsive UI — mirroring the conventions already established in
   `parking-coordinator`.

### Non-goals

- No legal/enforcement workflow (towing, citations). We're documenting, not
  adjudicating.
- No real-time alerts/notifications in v1 (could be a later phase).
- Not a general ALPR system — accuracy depends on the LLM + photo quality, and a
  human can always correct it.

## 3. Relationship to `parking-coordinator`

`parking-coordinator` already owns the canonical model of **our spots** and
**our people**, and it already uses the **CFC admin** registry to gate edits. We
want Lot Watch to be a sibling pattern in the same space that _shares_ data via
`PerSpace` cell wiring, exactly the way `parking-coordinator` accepts
`spots`/`people`/`adminRegistry` as `PerSpace<...>` inputs.

```ts
// parking-coordinator/main.tsx (today)
export interface ParkingCoordinatorInput {
  spots?: PerSpace<SpotsCell>;
  people?: PerSpace<PeopleCell>;
  requests?: PerSpace<RequestsCell>;
  adminRegistry?: PerSpace<ParkingAdminRegistryCell>;
}
```

### 3a. Sharing spots

Lot Watch should reuse the **same `spots` cell** so spot numbers (1/5/12/13)
stay in sync. We take `spots?: PerSpace<SpotsCell>` as an input and, when
present, use it to drive the spot picker. When absent, Lot Watch seeds its own
`["1","5","12","13"]` default.

### 3b. Sharing employee vehicles — **requires a small upstream change**

> **Dependency / decision needed.** `parking-coordinator`'s `Person` type today
> has `name, email, commuteMode, spotPreferences, defaultSpot, priorityRank` —
> **no vehicle or plate fields** (verified in `main.tsx:38-45`). So there is
> nothing to "absorb" yet.

Two options:

1. **(Recommended) Extend `Person` upstream** with an optional `vehicles` array,
   and have Lot Watch read employee plates from the shared `people` cell:

   ```ts
   // Canonical shape, owned by parking-coordinator (see vehicles.ts):
   export interface Vehicle {
     plateId: string; // REQUIRED — raw plate characters
     plateState: string; // optional, default "CA"
     color: string; // optional, from VEHICLE_COLORS
     make: string; // optional, from VEHICLE_MAKES
     model: string; // optional, from MODELS_BY_MAKE[make]
   }
   // Person gains:
   //   vehicles?: Vehicle[];
   ```

   Lot Watch normalizes `plateId`+`plateState` for matching, and derives a human
   description from `color`/`make`/`model` (e.g. "black Subaru Outback"). Lot
   Watch then treats every plate in `people[].vehicles` as **`ours`**. This is
   the cleanest "single source of truth" approach and lets the coordinator's
   admin UI manage employee plates too. It's a small additive change (optional
   field).

2. **Keep them separate** — Lot Watch maintains its own `knownVehicles` registry
   and we manually mark some as employees. Less duplication risk if we _also_
   pull from `people`, but two places to edit.

**Decided:** do (1) — add `vehicles?: Vehicle[]` to coordinator's `Person`
(single source of truth, managed in the coordinator's admin UI), and have Lot
Watch consume `people` **read-only** for the "ours" set, while keeping its own
registries for guests and known-offenders (data the coordinator has no concept
of).

## 4. Domain Model

```ts
// A single documented sighting of a car in one of our spots.
export interface Sighting {
  id: string; // genId()
  spotNumber: string; // "1" | "5" | "12" | "13" (validated against spots)
  capturedAt: number; // Date.now() in the capture handler (one-second resolution)
  reportedBy: string; // employee name (current actor)
  image: ImageData; // original photo (kept for audit) — has .data/.url/.name

  // LLM extraction (editable by a human after the fact):
  description: string; // "black Subaru Outback"
  plateNumber: string; // normalized uppercase, e.g. "7ABC123"
  plateState: string; // "CA" (may be "" if not visible)
  extractionPending: boolean; // true while the LLM call is in flight
  extractionError: string; // non-empty if extraction failed
  humanCorrected: boolean; // true once a person edited the extracted fields

  // Derived/cached classification (recomputed; stored for report stability):
  classification: Classification;
  notes: string; // freeform ("blocked the dumpster", etc.)
}

export type Classification = "ours" | "guest" | "offender" | "unknown";

// Plates we recognize. `ours` is sourced from parking-coordinator people;
// guests and offenders are Lot-Watch-owned registries.
export interface KnownVehicle {
  plateNumber: string;
  plateState: string;
  description: string;
  category: "guest" | "offender";
  org: string; // e.g. "Local Butcher Shop" (for offenders)
  label: string; // human note, e.g. "delivery van, Tue mornings"
}
```

### LLM extraction target

`generateObject<T>` infers/accepts a schema. The extraction shape:

```ts
export interface PlateExtraction {
  description: string; // make/model/color in plain words; "" if unclear
  plateNumber: string; // characters only; "" if not legible
  plateState: string; // 2-letter US state; "" if not visible
  confidence: "high" | "medium" | "low";
}
```

## 5. Cell Scopes

Following `parking-coordinator`'s discipline (it uses all three scopes):

| Cell                                                              | Scope            | Why                                                 |
| ----------------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| `sightings: Sighting[]`                                           | **`PerSpace`**   | shared team record — everyone sees the same log     |
| `knownVehicles: KnownVehicle[]`                                   | **`PerSpace`**   | shared guest + offender registries                  |
| `spots` (input)                                                   | **`PerSpace`**   | shared with `parking-coordinator`                   |
| `people` (input)                                                  | **`PerSpace`**   | read employee `vehicles` (the "ours" set)           |
| `adminRegistry`                                                   | **`PerSpace`**   | Lot Watch's own CFC registry (who edits watchlists) |
| `adminManagerMode`                                                | **`PerUser`**    | reveals the admin controls; gates roster changes    |
| capture draft fields (`draftSpot`, in-flight image, `draftNotes`) | **`PerSession`** | transient UI state per device/tab                   |
| `selectedTab` / report filters / confirm-dialog targets           | **`PerSession`** | ephemeral UI state                                  |
| `reporterName` (current actor)                                    | **`PerUser`**    | who's doing the documenting                         |

These map directly onto the constructors already in use:
`Writable.perSpace.of(...)`, `new Writable.perUser(...)`,
`new Writable.perSession(...)`.

## 6. Authorization (CFC Admin)

We reuse `packages/patterns/cfc/admin/mod.ts`, and follow the first four of the
five rules for flooring an admin registry in `packages/patterns/cfc/README.md`.
The integrity-tagged role model:

- `adminRegistryEntries<Role>(registry)` — read the admin list.
- `AddIntegrity<...>` / `RequiresIntegrity<...>` — endorse the roles and the
  roster with one atom, and floor the roster on that same atom, so a roster
  write carries the endorsement its own floor asks for and the roster read that
  write consumes carries the witness the floor's read-side gate asks for.
- `WriteAuthorizedBy<...>` — name `commitLotWatchAdminChange` as the one handler
  that may write the roster, so a write from another action here or from another
  pattern holding the registry cell under this schema is refused. That binding
  is what decides where a roster write may come from. Pattern setup and seed
  materialization install a value at the roster without passing through it, and
  a holder that declares the same cell under a schema of its own carries no
  contract for the runtime to check.

```ts
export const LOT_WATCH_ADMIN_INTEGRITY = "lot-watch-admin" as const;
```

The per-user switch that reveals the admin controls is a plain boolean with no
integrity. Any viewer turns it on for themselves, so a value claiming an atom
would endorse every protected write that consulted it. That switch is also the
only check `commitLotWatchAdminChange` makes on the acting user, which is where
this design departs from the remaining rules: authority does not come from the
role registry, and a role is granted to whatever `reporterName` the viewer typed
rather than to a subject drawn from `people`. So any viewer can grant themselves
the role. That is the demo identity model described above, and it wants a stable
user identity before this gate means anything; the roster never gates its own
editing, so no grant can lock the pattern out of repairing it.

**What admin gates:** editing the **guest** and **offender** registries,
deleting sightings, and bulk-merging duplicates. **Any employee can capture a
sighting** — documentation must be frictionless; only curation is privileged.

**Decided:** Lot Watch keeps **its own `adminRegistry` cell**, tagging its role
with a distinct `lot-watch-admin` integrity. The two patterns cannot share one
registry cell. Each declares a `requiredIntegrity` floor at `/admins`, and the
two floors name different atoms, so a roster written to satisfy one is refused
by the other. Each also names its own commit handler in the list's
`writeAuthorizedBy` contract, which refuses a write from any other code — the
other pattern's included. Sharing would mean agreeing on one atom and one
writer, which is a larger decision than sharing a cell.

## 7. Capture Flow (mobile-first)

The marquee interaction. Built on `<cf-image-input capture="environment">`,
which opens the **rear camera** directly on mobile (confirmed in
`packages/ui/src/v2/components/cf-image-input/cf-image-input.ts:79,165`).

```tsx
<cf-image-input
  capture="environment" // rear camera on phones
  includeData // gives us img.data (base64 data URL) to persist + send to LLM
  showPreview
  previewSize="lg"
  buttonText="📸 Photograph the car"
  oncf-change={onPhotoCaptured({ draftImage })}
/>;
```

Handler mirrors `image-analysis.tsx:40-47`:

```ts
const onPhotoCaptured = handler<
  ImageUploadEvent,
  { draftImage: Writable<ImageData | null> }
>(
  ({ detail }, { draftImage }) => {
    const img = (detail?.allImages ?? detail?.images ?? [])[0] ?? null;
    draftImage.set(img);
  },
);
```

### Extraction

Reuse the `store-mapper.tsx:326-370` idiom — a `generateObject` call whose
`prompt` is a content-parts array mixing image + text, with an explicit JSON
`schema`:

```ts
const extractionRequest = generateObject<PlateExtraction>({
  system:
    "You are reading a photo of a parked car. Extract the vehicle description " +
    "(color + make + model in plain words), the license plate characters, and " +
    "the 2-letter US state if visible. If a field is not legible, return an " +
    "empty string. Do not guess.",
  prompt: computed(() => {
    const img = draftImage.get();
    const image = img?.data || img?.url;
    if (!image) return [];
    return [
      { type: "image" as const, image },
      {
        type: "text" as const,
        text:
          "Extract description, plateNumber (characters only, no spaces/dashes), " +
          "plateState (2-letter), and your confidence.",
      },
    ];
  }),
  schema: {/* PlateExtraction JSON schema, like store-mapper */},
  model: "anthropic:claude-sonnet-4-5",
});
const extraction = resultOf(extractionRequest);

// Render or branch on the request when this screen wants explicit status:
// isPending(extractionRequest)
// hasError(extractionRequest) && extractionRequest.error.message
// Otherwise `extraction` waits reactively for the usable PlateExtraction.
```

### Confirm & save

The capture screen shows the photo, the **editable** extracted fields (so a
human can fix a misread plate before saving), the spot picker, and a Save
button:

1. Tap **📸 Photograph the car** → camera → preview.
2. LLM auto-fills description / plate / state (shows "Reading plate…" while
   `pending`). Fields remain editable.
3. Pick the spot (segmented control of 1 / 5 / 12 / 13, sourced from `spots`).
4. Optional note.
5. **Save** → appends a `Sighting` to the `PerSpace` `sightings` cell with the
   image, the (possibly human-corrected) extraction, and a computed
   classification.
6. Form resets for the next car.

Normalization on save: `plateNumber → uppercase, strip non-alphanumerics`;
`plateState → uppercase 2-letter`. This makes matching reliable.

## 8. Classification

On save (and reactively in reports), each sighting is classified by matching its
normalized `(plateNumber, plateState)` against the registries, in priority
order:

1. **`ours`** — plate is in any `people[].vehicles` (from parking-coordinator).
2. **`guest`** — plate is in `knownVehicles` with `category === "guest"`.
3. **`offender`** — plate is in `knownVehicles` with `category === "offender"`.
4. **`unknown`** — no match (the interesting bucket — candidates to promote into
   a registry).

`unknown` sightings get a one-tap **"Mark as guest"** / **"Mark as offender
(org…)"** action (admin-gated) that adds the plate to `knownVehicles` and
retro-classifies all sightings with that plate. This is the curation loop that
turns raw sightings into intelligence.

## 9. Dedup / Relating Sightings

Two cars are "the same" primarily by **normalized plate**
(`plateNumber+plateState`). Secondary, fuzzy signal when a plate is
missing/illegible: **description similarity** (lowercased token overlap — same
color + make).

A `computed` groups sightings:

```ts
const groups = computed(() => {
  // key = plate if present, else `desc:${normalizedDescription}`
  // → [{ key, plate, classification, count, firstSeen, lastSeen, spots:Set, sightings:[] }]
});
```

UI surfaces groups with count badges; tapping a group shows its timeline of
photos. A duplicate that the system _didn't_ auto-group (plate misread
differently across two photos) can be **manually merged** by an admin, which
rewrites the minority sightings' plate to the canonical one.

## 10. Reports

A dedicated tab (`PerSession` `selectedTab`), all driven by `computed` over the
`PerSpace` `sightings`:

1. **Spot occupancy frequency** — per spot (1/5/12/13): total sightings, # by
   non-ours cars, and a sparkline/bar of last 30 days. Answers "how often is
   each spot known to be taken?"
2. **Repeat offenders leaderboard** — groups with
   `classification === "offender"` (and frequent `unknown`s), ranked by count,
   showing org, plate, last seen, and which spots. Answers "who are the repeat
   offenders?"
3. **Recent activity feed** — reverse-chronological sightings with thumbnail,
   classification chip, spot, reporter.
4. **Filters** — by spot, by classification, by date range (`PerSession`).

Classification chips reuse the color language: `ours` green, `guest` blue,
`offender` red, `unknown` gray — consistent with `parking-coordinator`'s inline
style palette.

## 11. Mobile UX / Layout

Same shell as `parking-coordinator`: `<cf-screen>` with a `slot="header"`, a
`<cf-vscroll flex>` body, `<cf-vstack>`/`<cf-hstack>` for structure, `<cf-card>`
sections, `<cf-button>`, `<cf-chip>`, `<cf-select>`, `<cf-input>`.

Top-level is a **3-tab** layout optimized so the primary action is one tap from
open:

- **📸 Capture** (default tab) — the capture flow (§7). Big camera button,
  thumb-reachable.
- **🚗 Sightings** — grouped/deduped list (§9), filterable.
- **📊 Report** — occupancy + offenders (§10).

Capture-first ordering and large tap targets keep it usable one-handed in a
parking lot. Image previews use `previewSize="lg"`; the spot picker is a
segmented row of big buttons, not a tiny dropdown.

## 12. Pattern I/O Sketch

```ts
export interface LotWatchInput {
  // Shared with parking-coordinator (all optional → standalone-capable):
  spots?: PerSpace<SpotsCell>; // reuse spot numbers
  people?: PerSpace<PeopleCell>; // read employee vehicles → "ours"
  adminRegistry?: PerSpace<LotWatchAdminRegistryCell>;
  // Lot-Watch-owned:
  sightings?: PerSpace<SightingsCell>;
  knownVehicles?: PerSpace<KnownVehiclesCell>;
}

export interface LotWatchOutput {
  [NAME]: string;
  [UI]: VNode;
  sightings: Sighting[];
  knownVehicles: KnownVehicle[];
  // capture:
  captureSighting: Stream<
    {
      spotNumber: string;
      description: string;
      plateNumber: string;
      plateState: string;
      notes: string;
    }
  >;
  correctExtraction: Stream<
    { id: string; description: string; plateNumber: string; plateState: string }
  >;
  deleteSighting: Stream<{ id: string }>; // admin
  // curation:
  markVehicle: Stream<
    {
      plateNumber: string;
      plateState: string;
      category: "guest" | "offender";
      org: string;
      label: string;
    }
  >;
  removeKnownVehicle: Stream<{ plateNumber: string; plateState: string }>;
  mergeSightings: Stream<{ canonicalPlate: string; fromPlate: string }>; // admin
  // admin (CFC), mirroring parking-coordinator:
  enableAdminManager: Stream<void>;
  togglePersonAdmin: Stream<{ name: string }>;
  // UI nav:
  selectTab: Stream<{ tab: "capture" | "sightings" | "report" }>;
}
```

## 13. File Layout

```
packages/patterns/factory-outputs/lot-watch/
  main.tsx        # the pattern
  main.test.tsx   # tests (pattern test harness, like parking-coordinator)
  DESIGN.md       # this doc
```

Plus: add a one-line entry to `packages/patterns/index.md` (catalog index), and
the small additive `vehicles?: Vehicle[]` change to
`parking-coordinator/main.tsx`'s `Person` (§3b).

## 14. Implementation Phases

1. **Skeleton + capture (no LLM).** Pattern scaffold, scopes, `cf-image-input`
   capture → store a `Sighting` with a manually typed plate/description. Spot
   picker from `spots`. Verify save/list round-trips.
2. **LLM extraction.** Wire `generateObject` for image→`PlateExtraction`,
   auto-fill editable fields, handle `pending`/`error`. Normalize on save.
3. **Registries + classification.** `knownVehicles` cell, "ours" from `people`,
   classification computed + chips, curation actions (mark guest/offender),
   retro-classification.
4. **Dedup/grouping + manual merge.**
5. **Reports tab** — occupancy frequency + repeat offenders.
6. **CFC admin gating** on curation/delete/merge; admin UI section.
7. **Upstream:** add `vehicles?: Vehicle[]` to coordinator `Person` + its admin
   UI.
8. **Polish:** mobile layout pass, empty states, confirm dialogs (reuse
   coordinator's `*ConfirmTarget` PerSession idiom).

## 15. Testing

Mirror `parking-coordinator/main.test.tsx` (pattern test harness): drive
`Stream` actions, assert on output cells / `computed` values.

- `captureSighting` appends with normalized plate.
- Classification: a plate in `people[].vehicles` → `ours`; in offender registry
  → `offender`; unmatched → `unknown`.
- `markVehicle` retro-classifies existing sightings.
- Dedup grouping counts repeats by plate; description fallback when plate empty.
- Report computeds: occupancy counts per spot; offender ranking order.
- Admin gating: curation actions are no-ops without an active manager
  credential.
- LLM extraction is mocked at the boundary (don't hit a live model in tests);
  assert the content-parts array shape and that `result` flows into editable
  fields.

## 16. Resolved Decisions

- **Admin role** — a separate `adminRegistry` cell with a distinct
  `lot-watch-admin` integrity tag; the two registries' floors and write bindings
  disagree, so one cell cannot serve both. (§6)
- **Employee plate source** — extend coordinator's `Person` with
  `vehicles?:
  Vehicle[]`; Lot Watch reads it read-only as "ours". (§3b)
- **Retention** — v1 keeps everything (no auto-purge). Plates + photos are
  sensitive, so this is a known, deliberate gap to revisit (a `#now`-driven
  purge action can be added later without schema change).

## 17. Remaining Open Questions

1. **Multi-photo per sighting** — sometimes you want the plate _and_ a wide
   shot. v1 = one photo; could later extend `Sighting.image` to
   `images: ImageData[]`.
2. **Model choice / cost** — `claude-sonnet-4-5` for vision accuracy vs. a
   cheaper model. Per-item caching (`generateObject` over a `.map`) keeps
   re-renders cheap.
