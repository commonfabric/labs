/**
 * Test Pattern: Sprint organizer, through its rendered controls
 *
 * A row's controls are bound to the item's own cells, so an edit made in a
 * row, including a row of a filtered view, lands on the stored item and moves
 * the per-person load. The filters and the view tabs are session controls that
 * change what is rendered and nothing that is stored.
 *
 * Run: deno task cf test packages/patterns/sprint-organizer/ui.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findNode,
  hasExactText,
  hasText,
  innermostNode,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";
import SprintOrganizer from "./main.tsx";

type Settable = { set: (value: unknown) => void };

const isElement = (node: unknown, name: string): boolean => {
  const value = readValue(node) as { name?: unknown } | undefined;
  return typeof value === "object" && value !== null &&
    readValue(value.name) === name;
};

/** Every element named `name` under `root`, in document order. */
const allElements = (root: unknown, name: string): unknown[] => {
  const found: unknown[] = [];
  findNode(root, (node) => {
    if (isElement(node, name)) found.push(node);
    return false;
  });
  return found;
};

/** The grid row carrying an item's id: the innermost `div` that holds both
 * the id and a lead select. The by-person view shows ids too, as badges, and
 * those sit in no such row. */
const rowOf = (root: unknown, id: string): unknown =>
  innermostNode(
    root,
    (node) =>
      isElement(node, "div") &&
      findNode(node, (inner) => hasExactText(inner, id)) !== undefined &&
      findElement(node, "cf-select") !== undefined,
  );

/** The cell a control is bound through, which is what the component writes
 * when someone uses it. Throws when the control or its binding is missing, so
 * a lost binding fails the test. */
const bound = (node: unknown, prop: string, what: string): Settable => {
  const cell = propsOf(node)?.[prop];
  if (
    typeof cell !== "object" || cell === null ||
    typeof (cell as Settable).set !== "function"
  ) {
    throw new Error(`${what} has no ${prop} binding`);
  }
  return cell as Settable;
};

export default pattern(() => {
  const organizer = SprintOrganizer({});

  const action_seed = action(() => {
    organizer.importAll.send({
      title: "Trial",
      window: "",
      people: ["Ada", "Bo"],
      projects: [
        { prefix: "GDN", title: "Garden", intent: "" },
        { prefix: "KIT", title: "Kitchen", intent: "" },
      ],
      items: [
        {
          id: "GDN-1",
          project: "GDN",
          component: "Raised beds",
          lead: "Ada",
          withPeople: [],
          tentative: false,
          status: "todo",
          source: "",
          notes: "",
        },
        {
          id: "GDN-2",
          project: "GDN",
          component: "Compost bin",
          lead: "",
          withPeople: [],
          tentative: false,
          status: "todo",
          source: "",
          notes: "",
        },
        {
          id: "KIT-1",
          project: "KIT",
          component: "Shelving",
          lead: "Bo",
          withPeople: [],
          tentative: true,
          status: "todo",
          source: "",
          notes: "",
        },
      ],
    });
  });

  // ===== A row's controls write the stored item =====

  const action_pick_bo_as_lead_of_compost = action(() => {
    const row = rowOf(organizer[UI], "GDN-2");
    bound(findElement(row, "cf-select"), "$value", "GDN-2's lead select")
      .set("Bo");
  });
  const action_add_ada_to_compost = action(() => {
    const row = rowOf(organizer[UI], "GDN-2");
    bound(findElement(row, "cf-autocomplete"), "$value", "GDN-2's with field")
      .set(["Ada"]);
  });
  const action_firm_up_shelving = action(() => {
    const row = rowOf(organizer[UI], "KIT-1");
    bound(findElement(row, "cf-checkbox"), "$checked", "KIT-1's maybe box")
      .set(false);
  });

  // ===== Session controls =====

  const action_filter_to_bo = action(() => {
    const header = allElements(organizer[UI], "cf-select")[0];
    bound(header, "$value", "the person filter").set("Bo");
  });
  const action_edit_status_in_filtered_row = action(() => {
    const row = rowOf(organizer[UI], "GDN-2");
    const status = allElements(row, "cf-select")[1];
    bound(status, "$value", "GDN-2's status select").set("active");
  });
  const action_clear_filter = action(() => {
    const header = allElements(organizer[UI], "cf-select")[0];
    bound(header, "$value", "the person filter").set("");
  });
  const action_unowned_only = action(() => {
    const box = findElement(organizer[UI], "cf-checkbox");
    bound(box, "$checked", "the unowned-only box").set(true);
  });
  const action_clear_beds_lead = action(() => {
    organizer.assign.send({ id: "GDN-1", lead: "" });
  });
  const action_show_people = action(() => {
    bound(findElement(organizer[UI], "cf-tabs"), "$value", "the view tabs")
      .set("people");
  });

  // ===== Assertions =====

  const assert_three_rows_rendered = assert(() =>
    rowOf(organizer[UI], "GDN-1") !== undefined &&
    rowOf(organizer[UI], "GDN-2") !== undefined &&
    rowOf(organizer[UI], "KIT-1") !== undefined
  );
  const assert_row_shows_stored_lead = assert(() => {
    const select = findElement(rowOf(organizer[UI], "GDN-1"), "cf-select");
    return readValue(propsOf(select)?.["$value"]) === "Ada";
  });
  const assert_lead_choices_offer_everyone = assert(() => {
    const select = findElement(rowOf(organizer[UI], "GDN-1"), "cf-select");
    const choices = readValue(propsOf(select)?.items) as { value: string }[];
    return choices.length === 3 && choices[0]?.value === "" &&
      choices[2]?.value === "Bo";
  });

  const assert_select_wrote_the_item = assert(() =>
    organizer.items[1]?.lead === "Bo" && organizer.ownedCount === 3 &&
    organizer.load[1]?.lead.length === 2 &&
    organizer.unownedIds.length === 0
  );
  const assert_with_wrote_the_item = assert(() =>
    organizer.items[1]?.withPeople?.length === 1 &&
    organizer.load[0]?.with[0] === "GDN-2"
  );
  const assert_helper_shows_as_a_chip = assert(() => {
    const chip = findElement(rowOf(organizer[UI], "GDN-2"), "cf-chip");
    return readValue(propsOf(chip)?.label) === "Ada";
  });
  const assert_checkbox_wrote_the_item = assert(() =>
    organizer.items[2]?.tentative === false
  );

  const assert_filter_hides_other_peoples_rows = assert(() =>
    rowOf(organizer[UI], "GDN-1") === undefined &&
    rowOf(organizer[UI], "GDN-2") !== undefined &&
    rowOf(organizer[UI], "KIT-1") !== undefined
  );
  const assert_filter_stores_nothing = assert(() =>
    organizer.items.length === 3 && organizer.ownedCount === 3
  );
  const assert_filtered_row_wrote_the_item = assert(() =>
    organizer.items[1]?.status === "active"
  );
  const assert_all_rows_back = assert(() =>
    rowOf(organizer[UI], "GDN-1") !== undefined
  );
  const assert_nothing_unowned_to_show = assert(() =>
    rowOf(organizer[UI], "GDN-1") === undefined &&
    rowOf(organizer[UI], "GDN-2") === undefined &&
    rowOf(organizer[UI], "KIT-1") === undefined
  );
  const assert_unowned_row_appears = assert(() =>
    rowOf(organizer[UI], "GDN-1") !== undefined &&
    rowOf(organizer[UI], "GDN-2") === undefined
  );
  const assert_people_view_hides_rows = assert(() =>
    rowOf(organizer[UI], "KIT-1") === undefined
  );
  const assert_people_view_counts = assert(() =>
    hasText(organizer[UI], "2 lead · 0 with")
  );
  const assert_people_view_lists_unowned = assert(() =>
    hasText(organizer[UI], "Unowned") && hasText(organizer[UI], "GDN-1")
  );

  return {
    [TESTS]: [
      { action: action_seed },
      { assertion: assert_three_rows_rendered },
      { assertion: assert_row_shows_stored_lead },
      { assertion: assert_lead_choices_offer_everyone },

      { action: action_pick_bo_as_lead_of_compost },
      { assertion: assert_select_wrote_the_item },
      { action: action_add_ada_to_compost },
      { assertion: assert_with_wrote_the_item },
      { assertion: assert_helper_shows_as_a_chip },
      { action: action_firm_up_shelving },
      { assertion: assert_checkbox_wrote_the_item },

      { action: action_filter_to_bo },
      { assertion: assert_filter_hides_other_peoples_rows },
      { assertion: assert_filter_stores_nothing },
      { action: action_edit_status_in_filtered_row },
      { assertion: assert_filtered_row_wrote_the_item },
      { action: action_clear_filter },
      { assertion: assert_all_rows_back },

      { action: action_unowned_only },
      { assertion: assert_nothing_unowned_to_show },
      { action: action_clear_beds_lead },
      { assertion: assert_unowned_row_appears },

      { action: action_show_people },
      { assertion: assert_people_view_hides_rows },
      { assertion: assert_people_view_counts },
      { assertion: assert_people_view_lists_unowned },
    ],
    organizer,
  };
});
