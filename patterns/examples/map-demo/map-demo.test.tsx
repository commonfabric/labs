/**
 * Test: adding an area of interest derives its title and colour from the same
 * snapshot it is appended to.
 *
 * The handler picks a colour by the list's length and titles the area from that
 * same length, so title, colour and position have to agree with the slot the
 * area actually lands in. The demo binds the handler to a button rather than
 * exporting it, so the test walks the rendered tree to the button and sends an
 * event to the stream bound to its onClick.
 *
 * Run: deno task cf test patterns/examples/map-demo/map-demo.test.tsx --root patterns --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import MapDemo from "./map-demo.tsx";

// The colour cycle the handler indexes with the list's length.
const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6"];

export default pattern(() => {
  // Start from an empty map: no stops, no areas and no tracked centre, so the
  // first add exercises the handler's own centre fallback.
  const subject = MapDemo({
    tripName: "Test Trip",
    stops: [],
    areasOfInterest: [],
    showRoute: true,
    center: null,
    zoom: 9,
    selectedStopIndex: null,
    fitBoundsTrigger: 0,
    initialized: false,
  });

  const action_add_area = action(() => {
    const button = findElementByText(subject[UI], "cf-button", "+ Add Area");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  // "Fit to All Stops" holds its body in an inline arrow rather than a bound
  // handler. It reaches the same way: the prop carries a stream either way.
  const action_fit_bounds = action(() => {
    const button = findElementByText(
      subject[UI],
      "cf-button",
      "Fit to All Stops",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_no_areas_initially = assert(() =>
    [...subject.areasOfInterest].length === 0
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

  // With no centre tracked yet the handler falls back to its own default rather
  // than leaving the area without a position.
  const assert_first_area_uses_default_center = assert(() => {
    const areas = [...subject.areasOfInterest];
    return areas.length === 1 &&
      areas[0].center.lat === 37.6 &&
      areas[0].center.lng === -122.2;
  });

  // The second add reads a one-entry list, so it titles itself "Area 2" and
  // takes the next colour. Both have to match the slot it appends into.
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
    [...subject.areasOfInterest].length === 3
  );

  // The map component watches this counter rather than taking a call, so the
  // button's only job is to move it.
  const assert_fit_bounds_not_triggered = assert(() =>
    subject.fitBoundsTrigger === 0
  );
  const assert_fit_bounds_triggered = assert(() =>
    subject.fitBoundsTrigger === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_no_areas_initially },
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
    ],
    subject,
  };
});
