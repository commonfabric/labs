/**
 * Test Pattern: Store Mapper departments and corrections tabs
 *
 * Works both tabs the way a person does, through the controls they render:
 * placing departments with their location buttons, and saving, replacing and
 * removing item corrections through the correction form.
 *
 * Run: deno task cf test --root patterns patterns/apps/store-mapper/store-mapper-departments.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  buttonInRow,
  clickButton,
  clickInRow,
  findNodeByProp,
  hasText,
  inOrder,
  propValue,
  rowWith,
  textContent,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import { CorrectionsTab, DepartmentsTab } from "./store-mapper.tsx";

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

interface Department {
  name: string;
  icon: string;
  location: WallPosition;
  description: string;
}

interface ItemLocation {
  itemName: string;
  correctAisle: string;
  incorrectAisle: string;
  timestamp: number;
}

/** The card for one department: the node holding its name and its buttons. */
const deptCard = (ui: unknown, dept: string): unknown =>
  rowWith(ui, dept, "N/A");

const ITEM_PLACEHOLDER = "Item name (e.g., coffee)";
const LOCATION_PLACEHOLDER = "Correct location (e.g., Aisle 9 or Bakery)";

/** Types an item and its location into the correction inputs. */
const fillCorrection = (ui: unknown, item: string, location: string): void => {
  typeInto(ui, ITEM_PLACEHOLDER, item);
  typeInto(ui, LOCATION_PLACEHOLDER, location);
};

/** What the input with `placeholder` holds. */
const inputValue = (ui: unknown, placeholder: string): unknown =>
  propValue(findNodeByProp(ui, "placeholder", placeholder), "$value");

export default pattern(() => {
  // ==========================================================================
  // Departments tab
  // ==========================================================================

  const departments = new Writable<Department[]>([
    { name: "Bakery", icon: "🥖", location: "unassigned", description: "" },
    { name: "Deli", icon: "🥪", location: "unassigned", description: "" },
    { name: "Dairy", icon: "🥛", location: "unassigned", description: "" },
    { name: "Produce", icon: "🥬", location: "unassigned", description: "" },
  ]);
  const departmentsTab = DepartmentsTab({ departments });
  const action_place_departments = action(() => {
    clickInRow(deptCard(departmentsTab[UI], "Bakery"), "Back:", "Left");
    clickButton(deptCard(departmentsTab[UI], "Deli"), "Normal Aisle");
    clickButton(deptCard(departmentsTab[UI], "Dairy"), "N/A");
  });
  const action_describe_bakery = action(() =>
    typeInto(
      deptCard(departmentsTab[UI], "Bakery"),
      "Description (optional)",
      "Fresh bread",
    )
  );

  // ==========================================================================
  // Corrections tab
  // ==========================================================================

  const itemLocations = new Writable<ItemLocation[]>([]);
  const correctionsTab = CorrectionsTab({
    itemLocations,
    newCorrectionItem: new Writable(""),
    newCorrectionAisle: new Writable(""),
  });
  const action_fill_coffee = action(() =>
    fillCorrection(correctionsTab[UI], "Coffee", " Aisle 3 ")
  );
  const action_fill_bread = action(() =>
    fillCorrection(correctionsTab[UI], "Bread", "Bakery")
  );
  const action_fill_coffee_again = action(() =>
    fillCorrection(correctionsTab[UI], "coffee", "Aisle 1")
  );
  const action_fill_tea_without_location = action(() =>
    fillCorrection(correctionsTab[UI], "Tea", "  ")
  );
  const action_save_correction = action(() =>
    clickButton(correctionsTab[UI], "Save Correction")
  );
  const action_remove_bread = action(() =>
    clickInRow(correctionsTab[UI], "Bread", "×")
  );

  return {
    [TESTS]: [
      // === Departments tab ===
      {
        assertion: assert(() =>
          hasText(deptCard(departmentsTab[UI], "Bakery"), "unassigned") &&
          propValue(
              buttonInRow(
                deptCard(departmentsTab[UI], "Bakery"),
                "Back:",
                "Left",
              ),
              "variant",
            ) === "outline"
        ),
      },
      { action: action_place_departments },
      {
        assertion: assert(() =>
          departments.get().map((d) => `${d.name}:${d.location}`).join(",") ===
            "Bakery:back-left,Deli:in-center-aisle,Dairy:not-in-store," +
              "Produce:unassigned"
        ),
      },
      {
        assertion: assert(() =>
          inOrder(textContent(departmentsTab[UI]), ["Produce", "Bakery"])
        ),
      },
      {
        assertion: assert(() =>
          hasText(deptCard(departmentsTab[UI], "Bakery"), "back-left") &&
          propValue(
              buttonInRow(
                deptCard(departmentsTab[UI], "Bakery"),
                "Back:",
                "Left",
              ),
              "variant",
            ) === "primary" &&
          propValue(
              buttonInRow(
                deptCard(departmentsTab[UI], "Deli"),
                "Other:",
                "Normal Aisle",
              ),
              "variant",
            ) === "primary"
        ),
      },

      { action: action_describe_bakery },
      {
        assertion: assert(() =>
          departments.get()[0]?.description === "Fresh bread"
        ),
      },

      // === Corrections tab ===
      {
        assertion: assert(() =>
          hasText(correctionsTab[UI], "No corrections saved yet.")
        ),
      },
      { action: action_fill_coffee },
      { action: action_save_correction },
      {
        assertion: assert(() =>
          itemLocations.get().map((l) => `${l.itemName}>${l.correctAisle}`)
            .join(",") === "Coffee>Aisle 3"
        ),
      },
      {
        assertion: assert(() =>
          inputValue(correctionsTab[UI], ITEM_PLACEHOLDER) === "" &&
          inputValue(correctionsTab[UI], LOCATION_PLACEHOLDER) === "" &&
          hasText(correctionsTab[UI], "Coffee → Aisle 3")
        ),
      },
      { action: action_fill_bread },
      { action: action_save_correction },
      { action: action_fill_coffee_again },
      { action: action_save_correction },
      {
        assertion: assert(() =>
          itemLocations.get().map((l) => `${l.itemName}>${l.correctAisle}`)
            .join(",") === "Bread>Bakery,coffee>Aisle 1"
        ),
      },
      // A correction with no location is not saved, and the inputs keep it.
      { action: action_fill_tea_without_location },
      { action: action_save_correction },
      {
        assertion: assert(() =>
          itemLocations.get().length === 2 &&
          inputValue(correctionsTab[UI], ITEM_PLACEHOLDER) === "Tea"
        ),
      },
      { action: action_remove_bread },
      {
        assertion: assert(() =>
          itemLocations.get().map((l) => l.itemName).join(",") === "coffee" &&
          !hasText(correctionsTab[UI], "Bread")
        ),
      },
    ],
  };
});
