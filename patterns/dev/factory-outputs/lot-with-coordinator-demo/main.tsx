// PATTERN TIER: legacy — superseded or non-idiomatic; kept for what
// depends on it. Do not copy from this file. Tiers: patterns/index.md
/**
 * Composed demo: Parking Coordinator + Lot Watch sharing a `people` cell.
 *
 * Demonstrates the cross-pattern UX: when a lot operator marks an unknown plate
 * as "Oh actually, that's Gideon's car" inside Lot Watch, Gideon (and the
 * plate) appears in Parking Coordinator's people list — because both inner
 * patterns are wired to the same `Writable.perSpace<Person[]>` cell.
 *
 * Both patterns also share `spots` per Lot Watch DESIGN §3a so the operator
 * doesn't need to maintain two spot lists.
 */
import { action, computed, NAME, pattern, UI, Writable } from "commonfabric";

import ParkingCoordinator, {
  DEFAULT_SPOTS,
} from "../parking-coordinator/main.tsx";
import type { ParkingSpot, Person } from "../parking-coordinator/main.tsx";

import LotWatch from "../lot-watch/main.tsx";

export interface Out {
  // Re-expose the shared cells so the host can inspect/debug.
  people: readonly Person[];
  spots: readonly ParkingSpot[];
}

// Seed the shared people cell so the demo is interesting on first load.
// Mary's vehicle exists so a sighting of `MARY01` classifies as "ours";
// Alex starts with no vehicles so it's obvious when assignToPerson writes one
// from Lot Watch (and equally obvious when "Gideon" — a NEW person typed into
// the picker — shows up here in Parking Coordinator's people list).
const DEFAULT_PEOPLE: Person[] = [
  {
    name: "Alex",
    email: "",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
    vehicles: [],
  },
  {
    name: "Mary",
    email: "",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 2,
    vehicles: [
      {
        plateId: "MARY01",
        plateState: "CA",
        color: "silver",
        make: "Honda",
        model: "Civic",
      },
    ],
  },
];

export default pattern<Record<string, never>, Out>(() => {
  // ---- Shared cells (the whole point of the demo) ----
  const sharedPeople = Writable.perSpace.of<Person[]>(DEFAULT_PEOPLE);
  const sharedSpots = Writable.perSpace.of<ParkingSpot[]>(DEFAULT_SPOTS);

  // ---- Instantiate the two inner patterns wired to the shared cells ----
  // Casts: each pattern's input type uses its own private PeopleCell/SpotsCell
  // type alias. The runtime cells are interchangeable (same shape); we only
  // need `as never` to satisfy the structural type mismatch.
  const coord = ParkingCoordinator({
    spots: sharedSpots as never,
    people: sharedPeople as never,
  });
  const lw = LotWatch({
    spots: sharedSpots as never,
    people: sharedPeople as never,
  });

  // ---- View toggle (perSession) ----
  const activeView = new Writable.perSession<"lot-watch" | "coordinator">(
    "lot-watch",
  );
  const setActiveView = action<{ view: "lot-watch" | "coordinator" }>(
    ({ view }) => {
      activeView.set(view);
    },
  );
  // Default fallback because a perSession `.get()` returns undefined until its
  // first write — without this guard the whole body renders blank on cold load.
  const isLotWatchView = computed(() =>
    (activeView.get() ?? "lot-watch") === "lot-watch"
  );
  const isCoordView = computed(() => activeView.get() === "coordinator");

  return {
    [NAME]: "Lot Watch + Coordinator (shared people)",
    people: sharedPeople,
    spots: sharedSpots,
    [UI]: (
      <cf-vstack gap="0" style="height: 100%;">
        {/* Header — explains what's happening and lets you switch */}
        <cf-hstack
          justify="between"
          align="center"
          gap="2"
          wrap
          style="padding: 0.5rem 0.75rem; border-bottom: 2px solid #6366f1; background: #eef2ff;"
        >
          <cf-vstack gap="0" style="flex: 1; min-width: 200px;">
            <span style="font-size: 0.875rem; font-weight: 600;">
              🔗 Composed demo
            </span>
            <span style="font-size: 0.7rem; color: var(--cf-colors-gray-600);">
              These two patterns share the same `people` cell. Tag a plate as
              "Gideon's car" in Lot Watch and Gideon appears in Parking
              Coordinator's people list.
            </span>
          </cf-vstack>
          <cf-hstack gap="1">
            <cf-button
              variant={isLotWatchView ? "primary" : "secondary"}
              size="sm"
              onClick={() => setActiveView.send({ view: "lot-watch" })}
            >
              🚗 Lot Watch
            </cf-button>
            <cf-button
              variant={isCoordView ? "primary" : "secondary"}
              size="sm"
              onClick={() => setActiveView.send({ view: "coordinator" })}
            >
              🅿️ Parking Coordinator
            </cf-button>
          </cf-hstack>
        </cf-hstack>

        {/* Active child UI */}
        <div style="flex: 1; overflow: hidden;">
          {isLotWatchView ? lw[UI] : null}
          {isCoordView ? coord[UI] : null}
        </div>
      </cf-vstack>
    ),
  };
});
