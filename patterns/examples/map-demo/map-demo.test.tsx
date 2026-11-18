/**
 * Test Pattern: Map Demo (trip planner)
 *
 * Drives the planner through its rendered view: the map's click, drag, and
 * marker-click events, every button, and the route toggle, reading back the
 * list rows, the value handed to the map, and the returned outputs.
 *
 * Adding an area derives its title and color from the same snapshot it is
 * appended to: the handler picks a color by the list's length and titles the
 * area from that same length, so title, color and position have to agree with
 * the slot the area actually lands in.
 *
 * Run: deno task cf test patterns/examples/map-demo/map-demo.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElement,
  findNode,
  fireEvent,
  hasText,
  innermostNode,
  isButton,
  propValue,
  styleOf,
  viewShows,
} from "../../tools/test-support/vnode-helpers.ts";
import MapDemo from "./map-demo.tsx";

// The color cycle the handler indexes with the list's length.
const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6"];

// The coordinates each demo stop's row shows.
const SAN_FRANCISCO = "37.7749, -122.4194";
const BERKELEY = "37.8716, -122.2727";

interface MapValue {
  markers: { title: string; draggable: boolean }[];
  circles: { title: string; color: string }[];
  polylines: { points: unknown[] }[];
}

const isMapValue = (value: unknown): value is MapValue =>
  typeof value === "object" && value !== null && "markers" in value &&
  "circles" in value && "polylines" in value;

// The value the planner hands the map component.
const mapValue = (root: unknown): MapValue | undefined => {
  const value = propValue(findElement(root, "cf-map"), "$value");
  return isMapValue(value) ? value : undefined;
};

const fireMap = (root: unknown, prop: string, detail: unknown): void =>
  fireEvent(findElement(root, "cf-map"), prop, { type: prop, detail }, "map");

// The background of the stop row showing `coords`.
const rowBackground = (root: unknown, coords: string): unknown =>
  styleOf(
    innermostNode(
      root,
      (node) =>
        hasText(node, coords) && findNode(node, isButton("Go")) !== undefined,
    ),
    "backgroundColor",
  );

export default pattern(() => {
  // Start from an empty map: no stops, no areas and no tracked center, so the
  // first add exercises the handler's own center fallback.
  const showRoute = Writable.of(true);
  const subject = MapDemo({
    tripName: "Test Trip",
    stops: [],
    areasOfInterest: [],
    showRoute,
    center: null,
    zoom: 9,
    selectedStopIndex: null,
    fitBoundsTrigger: 0,
    initialized: false,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_add_area = action(() => clickButton(subject[UI], "+ Add Area"));
  const action_fit_bounds = action(() =>
    clickButton(subject[UI], "Fit to All Stops")
  );
  const action_load_demo = action(() =>
    clickButton(subject[UI], "Load Demo Data")
  );
  const action_click_map = action(() =>
    fireMap(subject[UI], "oncf-click", { lat: 37.1, lng: -121.9 })
  );
  const action_drag_first_marker = action(() =>
    fireMap(subject[UI], "oncf-marker-drag-end", {
      index: 0,
      position: { lat: 37.7, lng: -122.5 },
    })
  );
  // A drag reported for a marker the list no longer has changes nothing.
  const action_drag_missing_marker = action(() =>
    fireMap(subject[UI], "oncf-marker-drag-end", {
      index: 99,
      position: { lat: 0, lng: 0 },
    })
  );
  const action_click_berkeley_marker = action(() =>
    fireMap(subject[UI], "oncf-marker-click", { index: 1 })
  );
  const action_go_berkeley = action(() =>
    clickInRow(subject[UI], BERKELEY, "Go")
  );
  const action_reset_view = action(() =>
    clickButton(subject[UI], "Reset View")
  );
  const action_remove_berkeley = action(() =>
    clickInRow(subject[UI], BERKELEY, "x")
  );
  const action_go_stanford = action(() =>
    clickInRow(subject[UI], "Radius: 5000m", "Go")
  );
  const action_remove_golden_gate = action(() =>
    clickInRow(subject[UI], "Radius: 3000m", "x")
  );
  const action_hide_route = action(() => showRoute.set(false));
  const action_clear_all = action(() => clickButton(subject[UI], "Clear All"));
  const action_reset_demo = action(() =>
    clickButton(subject[UI], "Reset Demo")
  );

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_empty_planner = assert(() =>
    subject[NAME] === "Trip Planner: Test Trip" &&
    subject.areasOfInterest.length === 0 && subject.initialized === false &&
    subject.center.lat === 37.6 && subject.center.lng === -122.2 &&
    subject.zoom === 9 && subject.selectedStopIndex === null &&
    viewShows(subject[UI], [
      "Welcome to Trip Planner!",
      "0 stops | 0 areas",
      "Click on the map to add your first stop!",
      "No areas defined.",
      "Center: 37.6000, -122.2000",
      "Zoom: 9.0",
    ]) &&
    mapValue(subject[UI])?.markers.length === 0
  );

  // The map component watches this counter rather than taking a call, so the
  // button's only job is to move it.
  const assert_fit_bounds_not_triggered = assert(() =>
    subject.fitBoundsTrigger === 0
  );
  const assert_fit_bounds_triggered = assert(() =>
    subject.fitBoundsTrigger === 1
  );

  const assert_first_area = assert(() => {
    const areas = [...subject.areasOfInterest];
    if (areas.length !== 1) return false;
    const area = areas[0];
    return area.title === "Area 1" &&
      area.color === COLORS[0] &&
      area.radius === 2000 &&
      area.description === "New area of interest";
  });

  // With no center tracked yet the handler falls back to its own default rather
  // than leaving the area without a position.
  const assert_first_area_uses_default_center = assert(() => {
    const areas = [...subject.areasOfInterest];
    return areas.length === 1 &&
      areas[0].center.lat === 37.6 &&
      areas[0].center.lng === -122.2;
  });

  // The second add reads a one-entry list, so it titles itself "Area 2" and
  // takes the next color. Both have to match the slot it appends into.
  const assert_second_area = assert(() => {
    const areas = [...subject.areasOfInterest];
    if (areas.length !== 2) return false;
    return areas[1].title === "Area 2" && areas[1].color === COLORS[1];
  });

  // The first area is untouched by the second add.
  const assert_first_area_unchanged = assert(() => {
    const areas = [...subject.areasOfInterest];
    return areas.length === 2 &&
      areas[0].title === "Area 1" &&
      areas[0].color === COLORS[0];
  });

  const assert_third_area = assert(() => {
    const areas = [...subject.areasOfInterest];
    if (areas.length !== 3) return false;
    return areas[2].title === "Area 3" && areas[2].color === COLORS[2];
  });

  // Every area's title numbers the slot it sits in, which is what the append
  // has to preserve.
  const assert_titles_match_positions = assert(() => {
    const areas = [...subject.areasOfInterest];
    return areas.every((area, index) => area.title === `Area ${index + 1}`);
  });

  const assert_area_count_tracks_list = assert(() =>
    [...subject.areasOfInterest].length === 3 &&
    hasText(subject[UI], "0 stops | 3 areas")
  );

  // Loading the demo replaces the areas with its own and lays out a route
  // through its four stops, both on the map and in the overview.
  const assert_demo_loaded = assert(() =>
    subject.initialized === true && subject.stops.length === 4 &&
    subject.areasOfInterest.length === 2 &&
    subject.areasOfInterest[0]?.title === "Golden Gate Area" &&
    viewShows(subject[UI], [
      "4 stops | 2 areas",
      SAN_FRANCISCO,
      "San Francisco -> Berkeley -> Fremont -> San Jose",
      "4 stops connected by dashed route line",
    ], ["Welcome to Trip Planner!", "San Jose -> "]) &&
    mapValue(subject[UI])?.markers.length === 4 &&
    mapValue(subject[UI])?.circles[1]?.title === "Stanford Area" &&
    mapValue(subject[UI])?.polylines[0]?.points.length === 4
  );

  const assert_map_click_added_stop = assert(() =>
    subject.stops.length === 5 && subject.stops[4]?.title === "Stop 5" &&
    subject.stops[4]?.position.lat === 37.1 &&
    hasText(subject[UI], "37.1000, -121.9000") &&
    mapValue(subject[UI])?.markers[4]?.draggable === true
  );

  const assert_first_marker_moved = assert(() =>
    subject.stops.length === 5 &&
    subject.stops[0]?.position.lat === 37.7 &&
    subject.stops[0]?.position.lng === -122.5 &&
    subject.stops[0]?.title === "San Francisco" &&
    viewShows(subject[UI], ["37.7000, -122.5000"], [SAN_FRANCISCO])
  );

  const assert_berkeley_selected = assert(() =>
    subject.selectedStopIndex === 1 &&
    rowBackground(subject[UI], BERKELEY) === "var(--cf-colors-blue-100)" &&
    rowBackground(subject[UI], "37.5485, -122.0590") ===
      "var(--cf-colors-gray-50)"
  );

  // An area added after the demo set the center takes a copy of it, so moving
  // the center leaves the area where it was.
  const assert_area_added_at_center = assert(() =>
    subject.areasOfInterest.length === 3 &&
    subject.areasOfInterest[2]?.title === "Area 3" &&
    subject.areasOfInterest[2]?.center.lat === 37.6
  );

  const assert_centered_on_berkeley = assert(() =>
    subject.center.lat === 37.8716 && subject.center.lng === -122.2727 &&
    subject.zoom === 14 && hasText(subject[UI], "Zoom: 14.0") &&
    subject.areasOfInterest[2]?.center.lat === 37.6
  );

  // Moving the center away again leaves the stop it was centered on in
  // place.
  const assert_view_reset = assert(() =>
    subject.center.lat === 37.6 && subject.center.lng === -122.2 &&
    subject.zoom === 9 && subject.stops[1]?.position.lat === 37.8716 &&
    hasText(subject[UI], BERKELEY)
  );

  const assert_berkeley_removed = assert(() =>
    subject.stops.length === 4 && !hasText(subject[UI], BERKELEY) &&
    subject.stops[1]?.title === "Fremont"
  );

  const assert_centered_on_stanford = assert(() =>
    subject.center.lat === 37.4419 && subject.zoom === 13
  );
  const assert_stanford_stays = assert(() =>
    subject.center.lat === 37.6 &&
    subject.areasOfInterest[1]?.center.lat === 37.4419
  );

  const assert_golden_gate_removed = assert(() =>
    subject.areasOfInterest.length === 2 &&
    subject.areasOfInterest[0]?.title === "Stanford Area" &&
    subject.areasOfInterest[1]?.title === "Area 3" &&
    !hasText(subject[UI], "Radius: 3000m")
  );

  const assert_route_hidden = assert(() =>
    mapValue(subject[UI])?.polylines.length === 0 &&
    !hasText(subject[UI], "Route Overview")
  );

  const assert_cleared = assert(() =>
    subject.stops.length === 0 && subject.areasOfInterest.length === 0 &&
    subject.selectedStopIndex === null &&
    viewShows(subject[UI], ["Click on the map to add your first stop!"], [
      "Welcome to Trip Planner!",
    ])
  );

  const assert_demo_reset = assert(() =>
    subject.stops.length === 4 && subject.areasOfInterest.length === 2 &&
    subject.stops[1]?.title === "Berkeley" &&
    subject.center.lat === 37.6 && subject.zoom === 9
  );

  return {
    [TESTS]: [
      { assertion: assert_empty_planner },
      { assertion: assert_fit_bounds_not_triggered },

      { action: action_fit_bounds },
      { assertion: assert_fit_bounds_triggered },

      { action: action_add_area },
      { assertion: assert_first_area },
      { assertion: assert_first_area_uses_default_center },

      { action: action_add_area },
      { assertion: assert_second_area },
      { assertion: assert_first_area_unchanged },

      { action: action_add_area },
      { assertion: assert_third_area },
      { assertion: assert_titles_match_positions },
      { assertion: assert_area_count_tracks_list },

      { action: action_load_demo },
      { assertion: assert_demo_loaded },
      { action: action_click_map },
      { assertion: assert_map_click_added_stop },
      { action: action_add_area },
      { assertion: assert_area_added_at_center },
      { action: action_drag_first_marker },
      { action: action_drag_missing_marker },
      { assertion: assert_first_marker_moved },
      { action: action_click_berkeley_marker },
      { assertion: assert_berkeley_selected },
      { action: action_go_berkeley },
      { assertion: assert_centered_on_berkeley },
      { action: action_reset_view },
      { assertion: assert_view_reset },
      { action: action_remove_berkeley },
      { assertion: assert_berkeley_removed },
      { action: action_go_stanford },
      { assertion: assert_centered_on_stanford },
      { action: action_reset_view },
      { assertion: assert_stanford_stays },
      { action: action_remove_golden_gate },
      { assertion: assert_golden_gate_removed },
      { action: action_hide_route },
      { assertion: assert_route_hidden },
      { action: action_clear_all },
      { assertion: assert_cleared },
      { action: action_reset_demo },
      { assertion: assert_demo_reset },
    ],
    subject,
  };
});
