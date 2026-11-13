/**
 * Test Pattern: Store Mapper, driven through its view: the whole pattern and
 * its map tab
 *
 * Reads the whole store mapper once, for what only it renders: the header
 * counts and the outline. Reading a view reads every node under it, and the
 * whole store mapper is large enough that a test reading it after every step
 * would not finish in time, so each tab is worked as its own instance with a
 * small fixture, here and in `store-mapper-aisles.test.tsx` and
 * `store-mapper-departments.test.tsx`.
 *
 * The map tab is worked the way a person does, through its controls:
 * switching tabs with the shortcuts, and marking and removing entrances, with
 * each read back from the cells it writes and from the walls of the map.
 *
 * Run: deno task cf test --root patterns patterns/apps/store-mapper/store-mapper-view.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  buttonInRow,
  clickButton,
  clickInRow,
  findElement,
  findElementByText,
  findNode,
  findNodeByProp,
  fireClick,
  hasText,
  inOrder,
  isElement,
  propValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import StoreMapper, { MapTab } from "./store-mapper.tsx";

type WallPosition =
  | "front-left"
  | "front-center"
  | "front-right"
  | "back-left"
  | "back-center"
  | "back-right"
  | "left-front"
  | "left-center"
  | "left-back"
  | "right-front"
  | "right-center"
  | "right-back"
  | "unassigned"
  | "not-in-store"
  | "in-center-aisle";

type Section = "map" | "aisles" | "departments" | "corrections" | "outline";

interface Department {
  name: string;
  icon: string;
  location: WallPosition;
  description: string;
}

/** The wall of the visual map whose class names `wall`. */
const mapWall = (ui: unknown, wall: string): unknown =>
  findNode(ui, (node) => {
    const className = propValue(node, "className");
    return typeof className === "string" &&
      className.includes(`store-map-wall-${wall}`);
  });

/** The card that marks entrances. */
const entranceCard = (ui: unknown): unknown =>
  findElementByText(ui, "cf-card", "Mark Store Entrances");

/** The tab panel showing `value`. */
const panel = (ui: unknown, value: string): unknown =>
  findNode(
    ui,
    (node) =>
      isElement(node, "cf-tab-panel") && propValue(node, "value") === value,
  );

const ENTRANCE_BUTTONS: [string, string][] = [
  ["Front:", "Left"],
  ["Front:", "Center"],
  ["Front:", "Right"],
  ["Back:", "Left"],
  ["Back:", "Center"],
  ["Back:", "Right"],
  ["Left:", "Front"],
  ["Left:", "Center"],
  ["Left:", "Back"],
  ["Right:", "Front"],
  ["Right:", "Center"],
  ["Right:", "Back"],
];

export default pattern(() => {
  // ==========================================================================
  // The whole store mapper, read once
  // ==========================================================================

  const store = StoreMapper({
    storeName: "Corner Market",
    aisles: [
      { name: "5B", description: "" },
      { name: "5A", description: "" },
      { name: "2", description: "Bread" },
    ],
    departments: [
      { name: "Bakery", icon: "🥖", location: "back-left", description: "" },
      { name: "Deli", icon: "🥪", location: "not-in-store", description: "" },
    ],
    entrances: [{ position: "front-center" }],
    itemLocations: [{
      itemName: "Coffee",
      correctAisle: "Aisle 2",
      incorrectAisle: "",
      timestamp: 0,
    }],
  });

  // ==========================================================================
  // Map tab
  // ==========================================================================

  const mapDepartments = new Writable<Department[]>([
    { name: "Bakery", icon: "🥖", location: "back-left", description: "" },
    { name: "Deli", icon: "🥪", location: "in-center-aisle", description: "" },
  ]);
  const entrances = new Writable<{ position: WallPosition }[]>([]);
  const section = new Writable<Section>("map");
  const map = MapTab({
    departments: mapDepartments,
    entrances,
    aisleCount: 3,
    currentSection: section,
  });
  const action_open_departments = action(() =>
    clickButton(map[UI], "+ Add Departments")
  );
  const action_open_aisles = action(() => clickButton(map[UI], "+ Add Aisles"));
  const action_mark_every_entrance = action(() => {
    for (const [wall, label] of ENTRANCE_BUTTONS) {
      clickInRow(entranceCard(map[UI]), wall, label);
    }
  });
  // The Front Left button is disabled once that entrance exists; firing its
  // handler anyway checks the handler's own guard against a duplicate.
  const action_add_duplicate_front_left_entrance = action(() =>
    fireClick(buttonInRow(entranceCard(map[UI]), "Front:", "Left"))
  );
  const action_remove_front_left = action(() =>
    clickInRow(entranceCard(map[UI]), "🚪 front-left", "×")
  );

  return {
    [TESTS]: [
      // === The whole store mapper: header counts and outline ===
      {
        assertion: assert(() =>
          inOrder(store.outline, [
            "# Aisle 2 (Known items: Coffee)\nBread",
            "# Aisle 5A\n(no description)",
            "# Aisle 5B\n(no description)",
            "# Bakery (back left)\n(no description)",
          ]) && !store.outline.includes("# Deli")
        ),
      },
      {
        assertion: assert(() =>
          hasText(
            findNodeByProp(store[UI], "slot", "header"),
            "3 aisles • 2 departments • 1 entrances",
          ) &&
          hasText(
            findElement(panel(store[UI], "outline"), "pre"),
            "# Aisle 2 (Known items: Coffee)",
          )
        ),
      },

      // === Map tab: shortcuts switch tabs ===
      {
        assertion: assert(() =>
          textContent(
            findNodeByProp(map[UI], "className", "store-map-center"),
          ) ===
            "Aisles3"
        ),
      },
      { action: action_open_departments },
      { assertion: assert(() => section.get() === "departments") },
      { action: action_open_aisles },
      { assertion: assert(() => section.get() === "aisles") },

      // === Map tab: departments and entrances on the walls ===
      {
        assertion: assert(() =>
          textContent(
              findNodeByProp(mapWall(map[UI], "back"), "title", "Bakery"),
            ) === "🥖" &&
          findNodeByProp(map[UI], "title", "Deli") === undefined &&
          !hasText(entranceCard(map[UI]), "Added (")
        ),
      },
      { action: action_mark_every_entrance },
      {
        assertion: assert(() =>
          entrances.get().map((e) => e.position).sort().join(",") ===
            "back-center,back-left,back-right,front-center,front-left," +
              "front-right,left-back,left-center,left-front,right-back," +
              "right-center,right-front"
        ),
      },
      {
        assertion: assert(() =>
          hasText(entranceCard(map[UI]), "Added (12):") &&
          propValue(
              buttonInRow(entranceCard(map[UI]), "Front:", "Left"),
              "disabled",
            ) === true &&
          propValue(
              buttonInRow(entranceCard(map[UI]), "Right:", "Back"),
              "disabled",
            ) === true
        ),
      },
      {
        assertion: assert(() =>
          textContent(mapWall(map[UI], "back")) === "🚪🥖🚪🚪" &&
          textContent(mapWall(map[UI], "left")) === "🚪🚪🚪" &&
          textContent(mapWall(map[UI], "right")) === "🚪🚪🚪" &&
          textContent(mapWall(map[UI], "front")) === "🚪🚪🚪" &&
          findNodeByProp(
              mapWall(map[UI], "back"),
              "className",
              "store-map-slot store-map-entrance-slot",
            ) !== undefined
        ),
      },
      { action: action_add_duplicate_front_left_entrance },
      {
        assertion: assert(() =>
          entrances.get().filter((e) => e.position === "front-left")
              .length === 1 &&
          entrances.get().length === 12 &&
          propValue(
              buttonInRow(entranceCard(map[UI]), "Front:", "Left"),
              "disabled",
            ) === true
        ),
      },
      { action: action_remove_front_left },
      {
        assertion: assert(() =>
          entrances.get().length === 11 &&
          !entrances.get().some((e) => e.position === "front-left")
        ),
      },
      {
        assertion: assert(() =>
          propValue(
              buttonInRow(entranceCard(map[UI]), "Front:", "Left"),
              "disabled",
            ) === false &&
          ENTRANCE_BUTTONS.slice(1).every(([wall, label]) =>
            propValue(
              buttonInRow(entranceCard(map[UI]), wall, label),
              "disabled",
            ) === true
          ) &&
          !hasText(entranceCard(map[UI]), "🚪 front-left") &&
          textContent(mapWall(map[UI], "front")) === "🚪🚪"
        ),
      },
    ],
  };
});
