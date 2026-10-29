/**
 * Test Pattern: Store Mapper
 *
 * Tests the store mapper functionality:
 * - Initial state
 * - Adding aisles
 * - Aisle descriptions
 * - Loading default departments
 * - Department location assignment
 * - Adding item corrections
 * - Outline generation
 * - AI photo import: addExtractedAisle with valid products
 * - AI photo import: addExtractedAisle with null products (graceful handling)
 * - AI photo import: addExtractedAisle duplicate prevention
 * - AI photo import: mergeExtractedAisle product merging
 * - held-reference survival (CT-1715): a reference stashed in a cell BEFORE
 *   setDepartmentLocation / mergeExtractedAisle must still `equals()`-match
 *   and still drive a subsequent operation AFTER the update. Updates write
 *   through the element's cells; replacing the array slot with a fresh
 *   object literal would re-mint the entity identity and orphan every held
 *   reference.
 *
 * The AI-import and location handlers are the REAL exported handlers from
 * store-mapper.tsx (not local mirrors), bound to the test-owned cells.
 *
 * Run: deno task cf test patterns/apps/store-mapper/store-mapper.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import StoreMapper, {
  addExtractedAisle,
  mergeExtractedAisle,
  removeAisle,
  setDepartmentLocation,
} from "./store-mapper.tsx";

interface Aisle {
  name: string;
  description: string;
}

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

// Handler to set aisles
const setAisles = handler<void, { aisles: Writable<Aisle[]>; data: Aisle[] }>(
  (_event, { aisles, data }) => {
    aisles.set([...data]);
  },
);

// Handler to set departments. Builds fresh literals (not copies of the
// state-bound data proxies) so each department becomes an entity doc with
// its own identity — the same shape the pattern's default-department init
// produces. Entity identity is what the held-reference tests below exercise.
const setDepts = handler<
  void,
  { departments: Writable<Department[]>; data: Department[] }
>(
  (_event, { departments, data }) => {
    departments.set(data.map((d) => ({
      name: d.name,
      icon: d.icon,
      location: d.location,
      description: d.description,
    })));
  },
);

// Handler to set item corrections
const setCorrections = handler<
  void,
  { itemLocations: Writable<ItemLocation[]>; data: ItemLocation[] }
>(
  (_event, { itemLocations, data }) => {
    itemLocations.set([...data]);
  },
);

// Handler to set store name
const setStoreName = handler<
  void,
  { storeName: Writable<string>; name: string }
>(
  (_event, { storeName, name }) => {
    storeName.set(name);
  },
);

export default pattern(() => {
  // Create writable cells that we control
  const storeNameCell = new Writable("Test Store");
  const aislesCell = new Writable<Aisle[]>([]);
  const departmentsCell = new Writable<Department[]>([]);
  const entrancesCell = new Writable<{ position: WallPosition }[]>([]);
  const itemLocationsCell = new Writable<ItemLocation[]>([]);

  // Instantiate the store mapper pattern
  const store = StoreMapper({
    storeName: storeNameCell,
    aisles: aislesCell,
    departments: departmentsCell,
    entrances: entrancesCell,
    itemLocations: itemLocationsCell,
  });

  // Simulate external holders (selection cells) that read an item once and
  // keep the reference across later mutations (held-reference survival).
  // Typed non-null (placeholder initial value) so the cells can be bound
  // directly as handler state (`FactoryInput<T>` accepts `Cell<T>`, not `T | null`).
  const heldDept = new Writable<Department>({
    name: "",
    icon: "",
    location: "unassigned",
    description: "",
  });
  const heldAisle = new Writable<Aisle>({ name: "", description: "" });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_add_aisle_1 = setAisles({
    aisles: aislesCell,
    data: [{ name: "1", description: "" }],
  });

  const action_add_aisle_2 = setAisles({
    aisles: aislesCell,
    data: [
      { name: "1", description: "" },
      { name: "2", description: "" },
    ],
  });

  const action_add_aisle_5 = setAisles({
    aisles: aislesCell,
    data: [
      { name: "1", description: "" },
      { name: "2", description: "" },
      { name: "5", description: "" },
    ],
  });

  const action_set_aisle_1_description = setAisles({
    aisles: aislesCell,
    data: [
      { name: "1", description: "Dairy & Eggs" },
      { name: "2", description: "" },
      { name: "5", description: "" },
    ],
  });

  const action_load_departments = setDepts({
    departments: departmentsCell,
    data: [
      { name: "Bakery", icon: "🥖", location: "unassigned", description: "" },
      { name: "Deli", icon: "🥪", location: "unassigned", description: "" },
      { name: "Produce", icon: "🥬", location: "unassigned", description: "" },
    ],
  });

  const action_assign_bakery = setDepts({
    departments: departmentsCell,
    data: [
      { name: "Bakery", icon: "🥖", location: "front-left", description: "" },
      { name: "Deli", icon: "🥪", location: "unassigned", description: "" },
      { name: "Produce", icon: "🥬", location: "unassigned", description: "" },
    ],
  });

  const action_add_coffee_correction = setCorrections({
    itemLocations: itemLocationsCell,
    data: [
      {
        itemName: "Coffee",
        correctAisle: "Aisle 5",
        incorrectAisle: "",
        // Fixed timestamp: the correction's timestamp value is never asserted
        // on, and reading the ambient clock in the pattern top-level body is
        // not permitted under the time/entropy capability gate.
        timestamp: 0,
      },
    ],
  });

  const action_change_store_name = setStoreName({
    storeName: storeNameCell,
    name: "My Grocery Store",
  });

  // ==========================================================================
  // Assertions - use store's computed values where available
  // ==========================================================================

  // Initial state - use computed count values for reliable reactive array length checks
  const assert_initial_store_name = assert(() =>
    String(store.storeName) === "Test Store"
  );
  const assert_initial_no_aisles = assert(() => Number(store.aisleCount) === 0);
  // With auto-populated default departments (7 total)
  const assert_initial_default_departments = assert(() =>
    Number(store.deptCount) === 7
  );
  const assert_initial_no_corrections = assert(() =>
    Number(store.correctionCount) === 0
  );

  // After adding aisles - use computed aisleCount for reliable reactive array length checks
  const assert_one_aisle = assert(() => Number(store.aisleCount) === 1);
  const assert_two_aisles = assert(() => Number(store.aisleCount) === 2);
  const assert_three_aisles = assert(() => Number(store.aisleCount) === 3);
  const assert_first_aisle_is_1 = assert(() => store.aisles[0]?.name === "1");

  // After setting description
  const assert_aisle_1_has_description = assert(() =>
    store.aisles[0]?.description === "Dairy & Eggs"
  );

  // After loading departments - use computed deptCount for reliable reactive array length checks
  const assert_three_departments = assert(() => Number(store.deptCount) === 3);
  const assert_bakery_exists = assert(() =>
    store.departments[0]?.name === "Bakery"
  );
  const assert_bakery_unassigned = assert(() =>
    store.departments[0]?.location === "unassigned"
  );

  // After assigning location
  const assert_bakery_assigned = assert(() =>
    store.departments[0]?.location === "front-left"
  );

  // After adding correction - use computed correctionCount for reliable reactive array length checks
  const assert_one_correction = assert(() =>
    Number(store.correctionCount) === 1
  );
  const assert_coffee_correction = assert(() =>
    store.itemLocations[0]?.itemName === "Coffee" &&
    store.itemLocations[0]?.correctAisle === "Aisle 5"
  );

  // Outline generation
  const assert_outline_contains_aisle_1 = assert(() =>
    String(store.outline).includes("# Aisle 1")
  );
  const assert_outline_contains_description = assert(() =>
    String(store.outline).includes("Dairy & Eggs")
  );
  const assert_outline_contains_bakery = assert(() =>
    String(store.outline).includes("# Bakery")
  );
  const assert_outline_contains_coffee = assert(() =>
    String(store.outline).includes("Coffee")
  );

  // Store name change
  const assert_store_name_changed = assert(() =>
    String(store.storeName) === "My Grocery Store"
  );

  // ==========================================================================
  // AI Photo Import Handler Actions
  // ==========================================================================

  // Test 9: addExtractedAisle with valid products
  const action_add_extracted_aisle_8 = addExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Bread", "Cereal", "Coffee"] },
  });

  // Test 10: addExtractedAisle with null products (should not crash)
  const action_add_extracted_aisle_9_null_products = addExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "9", products: null },
  });

  // Test 11: addExtractedAisle duplicate (should not add - aisle "8" already exists)
  const action_add_extracted_aisle_8_duplicate = addExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Snacks", "Chips"] },
  });

  // Test 12: mergeExtractedAisle - merge new products into existing aisle 8
  const action_merge_extracted_aisle_8 = mergeExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Tea", "Coffee", "Sugar"] }, // Coffee is duplicate, Tea and Sugar are new
  });

  // ==========================================================================
  // Held-reference survival actions (CT-1715)
  // ==========================================================================

  // Test 13: setDepartmentLocation must preserve the department's entity
  // identity. Stash a reference, relocate the department, then relocate it
  // AGAIN driving the handler with the stashed reference.
  const action_stash_held_dept = action(() => {
    const d = store.departments[0];
    if (d) heldDept.set(d);
  });
  const action_relocate_first_dept = setDepartmentLocation({
    departments: departmentsCell,
    dept: departmentsCell.key(0),
    location: "back-center",
  });
  const action_relocate_via_held_dept = setDepartmentLocation({
    departments: departmentsCell,
    dept: heldDept,
    location: "right-back",
  });

  // Test 14: mergeExtractedAisle must preserve the aisle's entity identity.
  // Stash a reference to aisle "8" (index 3: 1, 2, 5, 8, 9), merge more
  // products into it, then REMOVE it driving removeAisle with the stashed
  // reference (removeAisle locates the aisle with equals()).
  const action_stash_held_aisle = action(() => {
    const a = store.aisles[3];
    if (a) heldAisle.set(a);
  });
  const action_merge_into_held_aisle = mergeExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Honey"] },
  });
  const action_remove_via_held_aisle = removeAisle({
    aisles: aislesCell,
    aisle: heldAisle,
  });

  // ==========================================================================
  // AI Photo Import Handler Assertions
  // ==========================================================================

  // After adding extracted aisle 8
  const assert_four_aisles = assert(() => Number(store.aisleCount) === 4);
  const assert_aisle_8_exists = assert(() =>
    store.aisles.some((a: Aisle) => a.name === "8")
  );
  const assert_aisle_8_has_products = assert(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    return aisle8 !== undefined &&
      String(aisle8.description).includes("Bread") &&
      String(aisle8.description).includes("Cereal") &&
      String(aisle8.description).includes("Coffee");
  });

  // After adding extracted aisle 9 with null products
  const assert_five_aisles = assert(() => Number(store.aisleCount) === 5);
  const assert_aisle_9_exists = assert(() =>
    store.aisles.some((a: Aisle) => a.name === "9")
  );
  const assert_aisle_9_empty_description = assert(() => {
    const aisle9 = store.aisles.find((a: Aisle) => a.name === "9");
    return aisle9 !== undefined && String(aisle9.description) === "";
  });

  // After attempting to add duplicate aisle 8 (count should remain 5)
  const assert_still_five_aisles = assert(() => Number(store.aisleCount) === 5);
  const assert_aisle_8_unchanged = assert(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    // Description should NOT contain Snacks or Chips from the duplicate attempt
    return aisle8 !== undefined &&
      !String(aisle8.description).includes("Snacks") &&
      !String(aisle8.description).includes("Chips");
  });

  // After merging into aisle 8
  const assert_aisle_8_merged = assert(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    // Should have original items plus Tea and Sugar, but Coffee only once
    return aisle8 !== undefined &&
      String(aisle8.description).includes("Bread") &&
      String(aisle8.description).includes("Tea") &&
      String(aisle8.description).includes("Sugar");
  });
  const assert_aisle_8_no_duplicate_coffee = assert(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    if (!aisle8) return false;
    // Count occurrences of "Coffee" in description
    const matches = String(aisle8.description).match(/Coffee/g);
    return matches !== null && matches.length === 1;
  });

  // ==========================================================================
  // Held-reference survival assertions (CT-1715)
  // ==========================================================================

  const assert_held_dept_stashed = assert(() => {
    const h = heldDept.get();
    return h.name !== "" && equals(store.departments[0], h);
  });
  const assert_dept_relocated = assert(() =>
    store.departments[0]?.location === "back-center"
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the
  // department AFTER setDepartmentLocation updated it.
  const assert_held_dept_survives = assert(() => {
    const h = heldDept.get();
    return h.name !== "" && equals(store.departments[0], h);
  });
  // KEY: the held reference still DRIVES the handler after the update.
  const assert_dept_relocated_via_held = assert(() =>
    store.departments[0]?.location === "right-back"
  );

  const assert_held_aisle_stashed = assert(() => {
    const h = heldAisle.get();
    return h.name !== "" && equals(store.aisles[3], h);
  });
  const assert_aisle_8_has_honey = assert(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    return aisle8 !== undefined &&
      String(aisle8.description).includes("Honey");
  });
  const assert_held_aisle_survives = assert(() => {
    const h = heldAisle.get();
    return h.name !== "" && equals(store.aisles[3], h);
  });
  const assert_aisle_8_removed_via_held = assert(() =>
    Number(store.aisleCount) === 4 &&
    store.aisles.find((a: Aisle) => a.name === "8") === undefined
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Test 1: Initial state ===
      { assertion: assert_initial_store_name },
      { assertion: assert_initial_no_aisles },
      { assertion: assert_initial_default_departments },
      { assertion: assert_initial_no_corrections },

      // === Test 2: Add aisles ===
      { action: action_add_aisle_1 },
      { assertion: assert_one_aisle },
      { assertion: assert_first_aisle_is_1 },
      { action: action_add_aisle_2 },
      { assertion: assert_two_aisles },
      { action: action_add_aisle_5 },
      { assertion: assert_three_aisles },

      // === Test 3: Set aisle description ===
      { action: action_set_aisle_1_description },
      { assertion: assert_aisle_1_has_description },

      // === Test 4: Load departments ===
      { action: action_load_departments },
      { assertion: assert_three_departments },
      { assertion: assert_bakery_exists },
      { assertion: assert_bakery_unassigned },

      // === Test 5: Assign department location ===
      { action: action_assign_bakery },
      { assertion: assert_bakery_assigned },

      // === Test 6: Add item correction ===
      { action: action_add_coffee_correction },
      { assertion: assert_one_correction },
      { assertion: assert_coffee_correction },

      // === Test 7: Verify outline generation ===
      { assertion: assert_outline_contains_aisle_1 },
      { assertion: assert_outline_contains_description },
      { assertion: assert_outline_contains_bakery },
      { assertion: assert_outline_contains_coffee },

      // === Test 8: Store name change ===
      { action: action_change_store_name },
      { assertion: assert_store_name_changed },

      // === Test 9: Add extracted aisle with valid products ===
      { action: action_add_extracted_aisle_8 },
      { assertion: assert_four_aisles },
      { assertion: assert_aisle_8_exists },
      { assertion: assert_aisle_8_has_products },

      // === Test 10: Add extracted aisle with null products (should not crash) ===
      { action: action_add_extracted_aisle_9_null_products },
      { assertion: assert_five_aisles },
      { assertion: assert_aisle_9_exists },
      { assertion: assert_aisle_9_empty_description },

      // === Test 11: Add duplicate extracted aisle (should not add) ===
      { action: action_add_extracted_aisle_8_duplicate },
      { assertion: assert_still_five_aisles },
      { assertion: assert_aisle_8_unchanged },

      // === Test 12: Merge products into existing aisle ===
      { action: action_merge_extracted_aisle_8 },
      { assertion: assert_aisle_8_merged },
      { assertion: assert_aisle_8_no_duplicate_coffee },

      // === Test 13: Held-reference survival — setDepartmentLocation ===
      { action: action_stash_held_dept },
      { assertion: assert_held_dept_stashed },
      { action: action_relocate_first_dept },
      { assertion: assert_dept_relocated },
      { assertion: assert_held_dept_survives },
      { action: action_relocate_via_held_dept },
      { assertion: assert_dept_relocated_via_held },

      // === Test 14: Held-reference survival — mergeExtractedAisle ===
      { action: action_stash_held_aisle },
      { assertion: assert_held_aisle_stashed },
      { action: action_merge_into_held_aisle },
      { assertion: assert_aisle_8_has_honey },
      { assertion: assert_held_aisle_survives },
      { action: action_remove_via_held_aisle },
      { assertion: assert_aisle_8_removed_via_held },
    ],
    store,
  };
});
