/**
 * Form Demo Pattern
 *
 * Demonstrates the form buffering system with both create and edit modes:
 * - Create mode: Modal form with fresh data
 * - Edit mode: Modal form with existing data
 * - Cancel discards buffered changes
 * - Submit flushes all fields atomically
 * - Validation prevents invalid submissions
 */
import {
  action,
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

export interface Person {
  name: string;
  email: string;
  role: "user" | "admin" | Default<"user">;
}

interface FormDemoInput {
  people: Writable<Person[] | Default<[]>>;
}

export interface FormDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  people: Person[];
}

const createEmptyPerson = (): Person => ({
  name: "",
  email: "",
  role: "user",
});

// Form submit handler - must be at module scope
// cf-form flushes buffered values to bound cells before emitting cf-submit,
// so handlers read from the cells directly (type-safe, no reconstruction needed)
const handleFormSubmit = handler<
  unknown,
  {
    formData: Writable<Person>;
    people: Writable<Person[]>;
    editing: Writable<{ editing: Person | null }>;
    modalOpen: Writable<boolean>;
  }
>((_, { formData, people, editing, modalOpen }) => {
  const next = { ...formData.get() };
  const target = editing.get().editing;
  if (target === null) {
    people.push(next);
  } else {
    const current = people.get();
    const index = current.findIndex((p) => equals(p, target));
    if (index >= 0) {
      const updated = [...current];
      updated[index] = next;
      people.set(updated);
    }
  }

  modalOpen.set(false);
  editing.set({ editing: null });
});

export const EditPerson = pattern<
  {
    editing: Writable<{ editing: Person | null }>;
    formData: Writable<Person>;
    people: Writable<Person[]>;
    modalOpen: Writable<boolean>;
  },
  { [UI]: VNode }
>(
  ({ editing, formData, people, modalOpen }) => {
    const isEditMode = computed(() => editing.get().editing !== null);

    // Cancel handler - close modal without saving
    const handleCancel = action(() => {
      modalOpen.set(false);
      editing.set({ editing: null });
      // Form fields automatically reset via form.reset()
    });

    return {
      [UI]: (
        <cf-form
          oncf-submit={handleFormSubmit({
            formData,
            people,
            editing,
            modalOpen,
          })}
        >
          <cf-vstack gap="3">
            {/* Name field */}
            <cf-field label="Name" required>
              <cf-input
                name="name"
                $value={formData.key("name")}
                placeholder="Enter full name"
                required
              />
            </cf-field>

            {/* Email field */}
            <cf-field label="Email" required>
              <cf-input
                name="email"
                $value={formData.key("email")}
                type="email"
                placeholder="email@example.com"
                required
              />
            </cf-field>

            {/* Role field */}
            <cf-field label="Role">
              <cf-select
                name="role"
                $value={formData.key("role")}
                items={[
                  { label: "User", value: "user" },
                  { label: "Admin", value: "admin" },
                ]}
              />
            </cf-field>

            {/* Form actions */}
            <cf-hstack gap="2" style="margin-top: 1rem;">
              <cf-button
                type="reset"
                variant="secondary"
                onClick={handleCancel}
                style="flex: 1;"
              >
                Cancel
              </cf-button>
              <cf-button
                type="submit"
                variant="primary"
                style="flex: 1;"
              >
                {isEditMode ? "Save" : "Create"}
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-form>
      ),
    };
  },
);

// ===== Module-scope handlers =====

const startEdit = handler<
  unknown,
  {
    person: Person;
    people: Writable<Person[]>;
    editing: Writable<{ editing: Person | null }>;
    formData: Writable<Person>;
    modalOpen: Writable<boolean>;
  }
>((_event, { person, people, editing, formData, modalOpen }) => {
  const current = people.get();
  const index = current.findIndex((p) => equals(p, person));
  if (index >= 0) {
    formData.set({ ...current[index] });
    editing.set({ editing: person });
    modalOpen.set(true);
  }
});

const deletePerson = handler<
  Event,
  {
    person: Person;
    people: Writable<Person[]>;
  }
>((event, { person, people }) => {
  // Stop propagation to prevent card's onClick (startEdit) from firing
  event?.stopPropagation?.();
  const current = people.get();
  const filteredPeople = current.filter((p) => !equals(p, person));
  people.set(filteredPeople);
});

// ===== Pattern =====

export default pattern<FormDemoInput, FormDemoOutput>(({ people }) => {
  const editing = new Writable<{ editing: Person | null }>({ editing: null });
  const formData = new Writable<Person>(createEmptyPerson());
  const modalOpen = new Writable(false);

  // Computed values
  const peopleCount = computed(() => people.get().length);
  const isEditMode = computed(() => editing.get().editing !== null);
  const modalTitle = isEditMode ? "Edit Person" : "Add Person";

  const showModal = computed(() => modalOpen.get());

  // Open modal in create mode
  const startCreate = action(() => {
    formData.set(createEmptyPerson());
    editing.set({ editing: null });
    modalOpen.set(true);
  });

  return {
    [NAME]: computed(() => `People Directory (${people.get().length})`),
    [UI]: (
      <cf-screen>
        {/* Header */}
        <cf-vstack slot="header" gap="2">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>People Directory</cf-heading>
            <cf-text tone="tertiary">
              {peopleCount}{" "}
              {computed(() => people.get().length === 1 ? "person" : "people")}
            </cf-text>
          </cf-hstack>
        </cf-vstack>

        {/* Main content - list of people */}
        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" padding="4">
            {people.map((person) => (
              <cf-card
                style="cursor: pointer;"
                onClick={startEdit({
                  person,
                  people,
                  editing,
                  formData,
                  modalOpen,
                })}
              >
                <cf-hstack gap="2" align="center">
                  <cf-vstack gap="1" style="flex: 1;" align="start">
                    <cf-text variant="heading-sm">
                      {person.name || "(unnamed)"}
                    </cf-text>
                    <cf-text tone="muted">
                      {person.email}
                    </cf-text>
                    <cf-badge
                      variant="outline"
                      color={person.role === "admin" ? "primary" : "neutral"}
                      size="sm"
                    >
                      {person.role}
                    </cf-badge>
                  </cf-vstack>
                  <cf-button
                    variant="ghost"
                    onClick={deletePerson({ person, people })}
                  >
                    ×
                  </cf-button>
                </cf-hstack>
              </cf-card>
            ))}

            {ifElse(
              computed(() => people.get().length === 0),
              <cf-empty-state message='No people yet. Click "Add Person" to create one!' />,
              null,
            )}
          </cf-vstack>
        </cf-vscroll>

        {/* Footer - Add button */}
        <cf-hstack slot="footer" gap="2" padding="4">
          <cf-button
            variant="primary"
            onClick={startCreate}
            style="flex: 1;"
          >
            + Add Person
          </cf-button>
        </cf-hstack>

        {/* Modal form */}
        <cf-modal
          $open={modalOpen}
          dismissable
          size="md"
          oncf-modal-close={action(() => {
            modalOpen.set(false);
            editing.set({ editing: null });
          })}
        >
          <span slot="header">{modalTitle}</span>
          {ifElse(
            showModal,
            <EditPerson
              editing={editing}
              formData={formData}
              people={people}
              modalOpen={modalOpen}
            />,
            null,
          )}
        </cf-modal>
      </cf-screen>
    ),
    people,
  };
});
