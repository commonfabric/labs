/**
 * Test Pattern: Sprint organizer
 *
 * - an empty organizer reports nothing to own
 * - people, projects and items arrive through their streams, with guards
 * - item ids are minted per project and a cut item keeps its number
 * - assignment, helpers (added and dropped) and status move the per-person
 *   load and the counts
 * - `importAll` replaces the whole organizer
 *
 * Run: deno task cf test packages/patterns/sprint-organizer/main.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import SprintOrganizer from "./main.tsx";

export default pattern(() => {
  const organizer = SprintOrganizer({});

  // ===== People and projects =====

  const action_add_ada = action(() => {
    organizer.addPerson.send({ name: "Ada" });
  });
  const action_add_bo = action(() => {
    organizer.addPerson.send({ name: "  Bo " });
  });
  const action_add_ada_again = action(() => {
    organizer.addPerson.send({ name: "Ada" });
  });
  const action_add_blank_person = action(() => {
    organizer.addPerson.send({ name: "   " });
  });
  const action_add_garden_project = action(() => {
    organizer.addProject.send({
      prefix: "gdn",
      title: "Garden",
      intent: "Ready by spring",
    });
  });
  const action_add_kitchen_project = action(() => {
    organizer.addProject.send({ prefix: "KIT", title: "Kitchen" });
  });
  const action_add_garden_project_again = action(() => {
    organizer.addProject.send({ prefix: "GDN", title: "Garden two" });
  });

  // ===== Items =====

  const action_add_beds = action(() => {
    organizer.addItem.send({ project: "GDN", component: "Raised beds" });
  });
  const action_add_compost = action(() => {
    organizer.addItem.send({ project: "GDN", component: " Compost bin " });
  });
  const action_add_shelving = action(() => {
    organizer.addItem.send({ project: "KIT", component: "Shelving" });
  });
  const action_add_blank_item = action(() => {
    organizer.addItem.send({ project: "GDN", component: "  " });
  });
  const action_add_item_to_unknown_project = action(() => {
    organizer.addItem.send({ project: "NOPE", component: "Orphan" });
  });

  // ===== Assignment =====

  const action_assign_beds_to_ada = action(() => {
    organizer.assign.send({ id: "GDN-1", lead: "Ada" });
  });
  const action_propose_bo_for_shelving = action(() => {
    organizer.assign.send({ id: "KIT-1", lead: "Bo", tentative: true });
  });
  const action_bo_helps_with_beds = action(() => {
    organizer.setWith.send({ id: "GDN-1", withPeople: ["Bo"] });
  });
  const action_bo_stops_helping = action(() => {
    organizer.dropHelper.send({ id: "GDN-1", name: "Bo" });
  });
  const action_bo_helps_again = action(() => {
    organizer.setWith.send({ id: "GDN-1", withPeople: ["Ada", "Bo"] });
  });
  const action_move_beds_to_bo = action(() => {
    organizer.assign.send({ id: "GDN-1", lead: "Bo" });
  });
  const action_assign_unknown_item = action(() => {
    organizer.assign.send({ id: "GDN-99", lead: "Ada" });
  });

  // ===== Status =====

  const action_beds_usable = action(() => {
    organizer.setStatus.send({ id: "GDN-1", status: "usable" });
  });
  const action_cut_compost = action(() => {
    organizer.setStatus.send({ id: "GDN-2", status: "cut" });
  });
  const action_add_irrigation = action(() => {
    organizer.addItem.send({ project: "GDN", component: "Irrigation" });
  });

  // ===== Import =====

  const action_import = action(() => {
    organizer.importAll.send({
      title: "Spring push",
      window: "Two weeks",
      people: ["Cy"],
      projects: [{ prefix: "SHD", title: "Shed", intent: "" }],
      items: [{
        id: "SHD-4",
        project: "SHD",
        component: "Workbench",
        lead: "Cy",
        withPeople: [],
        tentative: false,
        status: "active",
        source: "WB",
        notes: "",
      }],
    });
  });
  const action_add_after_import = action(() => {
    organizer.addItem.send({ project: "SHD", component: "Tool rack" });
  });

  // ===== Assertions =====

  const assert_starts_empty = assert(() =>
    organizer.liveCount === 0 && organizer.ownedCount === 0 &&
    organizer.load.length === 0 && organizer.unownedIds.length === 0
  );
  const assert_default_title = assert(() =>
    organizer.title === "Sprint organizer"
  );

  const assert_two_people_trimmed = assert(() =>
    organizer.people.length === 2 && organizer.people[0] === "Ada" &&
    organizer.people[1] === "Bo"
  );
  const assert_load_rows_follow_people = assert(() =>
    organizer.load.length === 2 && organizer.load[1]?.name === "Bo" &&
    organizer.load[1]?.lead.length === 0
  );
  const assert_prefix_uppercased = assert(() =>
    organizer.projects.length === 1 && organizer.projects[0]?.prefix === "GDN"
  );
  const assert_two_projects = assert(() => organizer.projects.length === 2);
  const assert_duplicate_project_refused = assert(() =>
    organizer.projects.length === 2 &&
    organizer.projects[0]?.title === "Garden"
  );

  const assert_first_id = assert(() =>
    organizer.items.length === 1 && organizer.items[0]?.id === "GDN-1" &&
    organizer.items[0]?.lead === "" && organizer.items[0]?.status === "todo"
  );
  const assert_second_id_and_trim = assert(() =>
    organizer.items[1]?.id === "GDN-2" &&
    organizer.items[1]?.component === "Compost bin"
  );
  const assert_ids_are_per_project = assert(() =>
    organizer.items[2]?.id === "KIT-1"
  );
  const assert_three_items_all_unowned = assert(() =>
    organizer.items.length === 3 && organizer.liveCount === 3 &&
    organizer.ownedCount === 0 && organizer.unownedIds.length === 3
  );

  const assert_ada_leads_beds = assert(() =>
    organizer.items[0]?.lead === "Ada" &&
    organizer.load[0]?.lead.length === 1 &&
    organizer.load[0]?.lead[0] === "GDN-1" && organizer.ownedCount === 1 &&
    organizer.unownedIds.length === 2
  );
  const assert_bo_is_tentative_on_shelving = assert(() =>
    organizer.items[2]?.lead === "Bo" &&
    organizer.items[2]?.tentative === true &&
    organizer.load[1]?.lead[0] === "KIT-1" && organizer.ownedCount === 2
  );
  const assert_bo_helps = assert(() =>
    organizer.load[1]?.with.length === 1 &&
    organizer.load[1]?.with[0] === "GDN-1" &&
    organizer.load[0]?.with.length === 0
  );
  const assert_bo_dropped = assert(() =>
    organizer.items[0]?.withPeople?.length === 0 &&
    organizer.load[1]?.with.length === 0
  );
  const assert_two_helpers = assert(() =>
    organizer.items[0]?.withPeople?.length === 2
  );
  const assert_drop_keeps_the_others = assert(() =>
    organizer.items[0]?.withPeople?.length === 1 &&
    organizer.items[0]?.withPeople?.[0] === "Ada"
  );
  const assert_beds_moved = assert(() =>
    organizer.load[0]?.lead.length === 0 &&
    organizer.load[1]?.lead.length === 2 && organizer.ownedCount === 2 &&
    organizer.items[0]?.tentative === false
  );
  const assert_summary_counts = assert(() =>
    organizer.summary === "2 of 3 items have a lead; Ada 0, Bo 2"
  );

  const assert_beds_status = assert(() =>
    organizer.items[0]?.status === "usable" && organizer.liveCount === 3
  );
  const assert_cut_leaves_the_counts = assert(() =>
    organizer.items.length === 3 && organizer.liveCount === 2 &&
    organizer.unownedIds.length === 0
  );
  const assert_cut_id_is_not_reused = assert(() =>
    organizer.items.length === 4 && organizer.items[3]?.id === "GDN-3" &&
    organizer.unownedIds.length === 1 && organizer.unownedIds[0] === "GDN-3"
  );

  const assert_import_replaced_everything = assert(() =>
    organizer.title === "Spring push" && organizer.window === "Two weeks" &&
    organizer.people.length === 1 && organizer.projects.length === 1 &&
    organizer.items.length === 1 && organizer.load[0]?.name === "Cy" &&
    organizer.load[0]?.lead[0] === "SHD-4" && organizer.ownedCount === 1
  );
  const assert_id_continues_from_import = assert(() =>
    organizer.items[1]?.id === "SHD-5"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { assertion: assert_default_title },

      { action: action_add_ada },
      { action: action_add_bo },
      { action: action_add_ada_again },
      { action: action_add_blank_person },
      { assertion: assert_two_people_trimmed },
      { assertion: assert_load_rows_follow_people },
      { action: action_add_garden_project },
      { assertion: assert_prefix_uppercased },
      { action: action_add_kitchen_project },
      { assertion: assert_two_projects },
      { action: action_add_garden_project_again },
      { assertion: assert_duplicate_project_refused },

      { action: action_add_beds },
      { assertion: assert_first_id },
      { action: action_add_compost },
      { assertion: assert_second_id_and_trim },
      { action: action_add_shelving },
      { assertion: assert_ids_are_per_project },
      { action: action_add_blank_item },
      { action: action_add_item_to_unknown_project },
      { assertion: assert_three_items_all_unowned },

      { action: action_assign_beds_to_ada },
      { assertion: assert_ada_leads_beds },
      { action: action_propose_bo_for_shelving },
      { assertion: assert_bo_is_tentative_on_shelving },
      { action: action_bo_helps_with_beds },
      { assertion: assert_bo_helps },
      { action: action_bo_stops_helping },
      { assertion: assert_bo_dropped },
      { action: action_bo_helps_again },
      { assertion: assert_two_helpers },
      { action: action_bo_stops_helping },
      { assertion: assert_drop_keeps_the_others },
      { action: action_move_beds_to_bo },
      { action: action_assign_unknown_item },
      { assertion: assert_beds_moved },
      { assertion: assert_summary_counts },

      { action: action_beds_usable },
      { assertion: assert_beds_status },
      { action: action_cut_compost },
      { assertion: assert_cut_leaves_the_counts },
      { action: action_add_irrigation },
      { assertion: assert_cut_id_is_not_reused },

      { action: action_import },
      { assertion: assert_import_replaced_everything },
      { action: action_add_after_import },
      { assertion: assert_id_continues_from_import },
    ],
  };
});
