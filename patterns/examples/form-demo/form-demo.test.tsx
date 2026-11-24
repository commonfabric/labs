/**
 * Test Pattern: Form Demo
 *
 * Drives the people directory through its rendered view: adding, editing,
 * dismissing, and deleting people. The edit form is also run on its own, with
 * the test holding its cells, so a submission can carry data the test chose.
 *
 * Run: deno task cf test patterns/examples/form-demo/form-demo.test.tsx
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
  findElementByText,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  isButton,
  propValue,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import FormDemo, {
  type Editing,
  EditPerson,
  type Person,
} from "./form-demo.tsx";

const ADA: Person = { name: "Ada", email: "ada@example.com", role: "admin" };
const GRACE: Person = {
  name: "Grace",
  email: "grace@example.com",
  role: "user",
};

const modal = (root: unknown): unknown => findElement(root, "cf-modal");

const modalOpen = (root: unknown): unknown => propValue(modal(root), "$open");

// The text the form's name field shows.
const nameField = (root: unknown): unknown =>
  propValue(findNodeByProp(root, "name", "name"), "$value");

const hasSubmitButton = (root: unknown, label: string): boolean =>
  findNode(
    root,
    (node) => hasText(node, label) && propValue(node, "type") === "submit",
  ) !== undefined;

const submitForm = (root: unknown): void =>
  fireEvent(
    findElement(root, "cf-form"),
    "oncf-submit",
    { type: "cf-submit" },
    "the person form",
  );

const badgeColor = (root: unknown, name: string): unknown =>
  propValue(
    findElement(findElementByText(root, "cf-card", name), "cf-badge"),
    "color",
  );

export default pattern(() => {
  // ==========================================================================
  // The directory
  // ==========================================================================

  const directory = FormDemo({ people: [ADA, GRACE] });

  const assert_lists_seeded_people = assert(() =>
    directory[NAME] === "People Directory (2)" &&
    hasText(directory[UI], "2 people") &&
    hasText(directory[UI], "ada@example.com") &&
    hasText(directory[UI], "grace@example.com") &&
    badgeColor(directory[UI], "Ada") === "primary" &&
    badgeColor(directory[UI], "Grace") === "neutral" &&
    findElement(directory[UI], "cf-empty-state") === undefined &&
    modalOpen(directory[UI]) === false
  );

  const action_start_create = action(() =>
    clickButton(directory[UI], "+ Add Person")
  );
  const assert_creating = assert(() =>
    modalOpen(directory[UI]) === true &&
    hasText(modal(directory[UI]), "Add Person") &&
    hasSubmitButton(directory[UI], "Create") && nameField(directory[UI]) === ""
  );

  const action_cancel = action(() => clickButton(directory[UI], "Cancel"));
  const assert_closed_unchanged = assert(() =>
    modalOpen(directory[UI]) === false && directory.people.length === 2 &&
    findElement(directory[UI], "cf-form") === undefined
  );

  // Submitting the fresh form appends what it holds: a person with no name,
  // listed as "(unnamed)".
  const action_submit = action(() => submitForm(directory[UI]));
  const assert_created = assert(() =>
    modalOpen(directory[UI]) === false && directory.people.length === 3 &&
    directory.people[2]?.name === "" && hasText(directory[UI], "(unnamed)") &&
    directory[NAME] === "People Directory (3)"
  );

  // Clicking a card opens the form on that person.
  const action_edit_ada = action(() =>
    fireClick(findElementByText(directory[UI], "cf-card", "Ada"), "Ada's card")
  );
  const assert_editing_ada = assert(() =>
    modalOpen(directory[UI]) === true &&
    hasText(modal(directory[UI]), "Edit Person") &&
    hasSubmitButton(directory[UI], "Save") && nameField(directory[UI]) === "Ada"
  );

  // Dismissing the modal leaves edit mode, so the title is back to adding.
  const action_dismiss = action(() =>
    fireEvent(modal(directory[UI]), "oncf-modal-close", {
      type: "cf-modal-close",
    })
  );
  const assert_dismissed = assert(() =>
    modalOpen(directory[UI]) === false &&
    hasText(modal(directory[UI]), "Add Person")
  );

  // Saving an edited person writes the change to that person's place in the
  // list and leaves everyone else as they were.
  const action_type_ada_email = action(() =>
    setBound(
      findNodeByProp(directory[UI], "name", "email"),
      "$value",
      "ada@new.example",
      "the email field",
    )
  );
  const assert_saved_edit = assert(() =>
    modalOpen(directory[UI]) === false && directory.people.length === 3 &&
    directory.people[0]?.name === "Ada" &&
    directory.people[0]?.email === "ada@new.example" &&
    directory.people[0]?.role === "admin" &&
    directory.people[1]?.name === "Grace" &&
    directory.people[1]?.email === "grace@example.com" &&
    directory.people[2]?.name === "" && directory.people[2]?.email === "" &&
    hasText(directory[UI], "ada@new.example") &&
    !hasText(directory[UI], "ada@example.com") &&
    hasText(modal(directory[UI]), "Add Person")
  );

  const action_delete_grace = action(() =>
    clickInRow(directory[UI], "Grace", "×")
  );
  const assert_one_less = assert(() =>
    directory.people.length === 2 && !hasText(directory[UI], "Grace") &&
    hasText(directory[UI], "Ada") && modalOpen(directory[UI]) === false
  );
  const action_delete_unnamed = action(() =>
    clickInRow(directory[UI], "(unnamed)", "×")
  );
  // Two people can hold the same details; deleting one leaves the other.
  const assert_one_unnamed_left = assert(() =>
    directory.people.length === 2 &&
    directory.people.filter((person) => person.name === "").length === 1 &&
    hasText(directory[UI], "(unnamed)")
  );
  const assert_one_person = assert(() =>
    hasText(directory[UI], "1 person") &&
    directory[NAME] === "People Directory (1)"
  );
  const action_delete_ada = action(() => clickInRow(directory[UI], "Ada", "×"));
  const assert_empty = assert(() =>
    directory.people.length === 0 && hasText(directory[UI], "0 people") &&
    findElement(directory[UI], "cf-empty-state") !== undefined &&
    findNode(directory[UI], isButton("×")) === undefined
  );

  // ==========================================================================
  // The edit form on its own
  // ==========================================================================

  const people = Writable.of<Person[]>([ADA]);
  const editing = Writable.of<Editing>({ editing: null });
  const formData = Writable.of<Person>({
    name: "Linus",
    email: "linus@example.com",
    role: "user",
  });
  const formOpen = Writable.of(true);
  const form = EditPerson({ editing, formData, people, modalOpen: formOpen });

  const assert_form_creates = assert(() =>
    hasSubmitButton(form[UI], "Create") && !hasSubmitButton(form[UI], "Save")
  );
  const action_submit_form = action(() => submitForm(form[UI]));
  const assert_appended = assert(() =>
    people.get().length === 2 && people.get()[1]?.name === "Linus" &&
    formOpen.get() === false
  );

  const action_edit_ada_email = action(() => {
    editing.set({ editing: people.key(0) });
    formData.set({ ...ADA, email: "ada@new.example" });
    formOpen.set(true);
  });
  const assert_form_saves = assert(() =>
    hasSubmitButton(form[UI], "Save") && !hasSubmitButton(form[UI], "Create")
  );
  const assert_replaced = assert(() =>
    people.get().length === 2 &&
    people.get()[0]?.email === "ada@new.example" &&
    people.get()[1]?.name === "Linus" &&
    editing.get().editing === null && formOpen.get() === false
  );

  // Cancel closes the form without writing what it holds.
  const action_edit_then_cancel = action(() => {
    editing.set({ editing: people.key(0) });
    formData.set({ ...ADA, email: "ada@discarded.example" });
    formOpen.set(true);
    clickButton(form[UI], "Cancel");
  });
  const assert_closed_after_cancel = assert(() =>
    people.get().length === 2 && people.get()[0]?.email === "ada@new.example" &&
    editing.get().editing === null && formOpen.get() === false
  );

  return {
    [TESTS]: [
      { assertion: assert_lists_seeded_people },
      { action: action_start_create },
      { assertion: assert_creating },
      { action: action_cancel },
      { assertion: assert_closed_unchanged },
      { action: action_start_create },
      { action: action_submit },
      { assertion: assert_created },
      { action: action_edit_ada },
      { assertion: assert_editing_ada },
      { action: action_dismiss },
      { assertion: assert_dismissed },
      { action: action_edit_ada },
      { action: action_type_ada_email },
      { action: action_submit },
      { assertion: assert_saved_edit },
      { action: action_delete_grace },
      { assertion: assert_one_less },
      { action: action_start_create },
      { action: action_submit },
      { action: action_delete_unnamed },
      { assertion: assert_one_unnamed_left },
      { action: action_delete_unnamed },
      { assertion: assert_one_person },
      { action: action_delete_ada },
      { assertion: assert_empty },

      { assertion: assert_form_creates },
      { action: action_submit_form },
      { assertion: assert_appended },
      { action: action_edit_ada_email },
      { assertion: assert_form_saves },
      { action: action_submit_form },
      { assertion: assert_replaced },
      { action: action_edit_then_cancel },
      { assertion: assert_closed_after_cancel },
    ],
    directory,
    form,
  };
});
