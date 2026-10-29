/**
 * Contacts - Master-detail container for PersonLike items.
 *
 * Architecture: Stores piece results (pattern outputs with [UI]), not raw data.
 * Pattern instantiation happens at insertion time in handlers.
 *
 * Features:
 * - Add/remove Person and FamilyMember contacts
 * - Master-detail layout with resizable panels
 * - Groups data model (UI deferred due to framework limitation:
 *   computed() siblings of .map() break reactive rendering)
 */
import {
  action,
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// Import shared types
import type {
  ContactGroup,
  ContactPiece,
  FamilyMember,
  Person,
} from "./contact-types.tsx";

// Import patterns (they return pieces with [UI])
import PersonPattern from "./person.tsx";
import FamilyMemberPattern from "./family-member.tsx";

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  // Store piece results, not raw data
  contacts: Writable<ContactPiece[] | Default<[]>>;
  groups: Writable<ContactGroup[] | Default<[]>>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  contacts: ContactPiece[];
  groups: ContactGroup[];
  count: number;
}

// ============================================================================
// Handlers - Instantiate patterns here, push piece results
// ============================================================================

const addPerson = handler<
  unknown,
  {
    contacts: Writable<ContactPiece[]>;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, selectedIndex }) => {
  const personData = new Writable<Person>({
    firstName: "",
    lastName: "",
    middleName: "",
    nickname: "",
    prefix: "",
    suffix: "",
    pronouns: "",
    birthday: { month: 0, day: 0, year: 0 },
    photo: "",
    email: "",
    phone: "",
    notes: "",
    tags: [],
    addresses: [],
    socialProfiles: [],
  });
  const piece = PersonPattern({
    person: personData,
    sameAs: contacts,
  });
  const newIndex = (contacts.get() || []).length;
  contacts.push(piece as ContactPiece);
  selectedIndex.set(newIndex);
});

const addFamilyMember = handler<
  unknown,
  {
    contacts: Writable<ContactPiece[]>;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, selectedIndex }) => {
  const memberData = new Writable<FamilyMember>({
    firstName: "",
    lastName: "",
    relationship: "",
    birthday: "",
    dietaryRestrictions: [],
    notes: "",
    tags: [],
    allergies: [],
    giftIdeas: [],
  });
  const piece = FamilyMemberPattern({
    member: memberData,
    sameAs: contacts,
  });
  const newIndex = (contacts.get() || []).length;
  contacts.push(piece as ContactPiece);
  selectedIndex.set(newIndex);
});

const removeContact = handler<
  unknown,
  {
    contacts: Writable<ContactPiece[]>;
    groups: Writable<ContactGroup[]>;
    index: number;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, groups, index, selectedIndex }) => {
  const current = contacts.get() || [];
  contacts.set(current.toSpliced(index, 1));

  // Update group indices: remove references to deleted index, shift higher indices
  const currentGroups = groups.get() || [];
  const updatedGroups = currentGroups.map((g) => ({
    ...g,
    contactIndices: (g.contactIndices || [])
      .filter((i: number) => i !== index)
      .map((i: number) => (i > index ? i - 1 : i)),
  }));
  groups.set(updatedGroups);

  const sel = selectedIndex.get();
  if (sel >= current.length - 1) {
    selectedIndex.set(Math.max(-1, current.length - 2));
  } else if (sel > index) {
    selectedIndex.set(sel - 1);
  }
});

const selectContact = handler<
  unknown,
  { selectedIndex: Writable<number>; index: number }
>((_event, { selectedIndex, index }) => {
  selectedIndex.set(index);
});

// Group handlers
const addGroup = handler<
  unknown,
  { groups: Writable<ContactGroup[]> }
>((_event, { groups }) => {
  const current = groups.get() || [];
  groups.set([...current, { name: "New Group", contactIndices: [] }]);
});

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ contacts, groups }) => {
  const count = computed(() => (contacts.get() || []).length);
  const selectedIndex = new Writable<number>(-1);

  const openInNewView = action(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return;
    const piece = contacts.key(idx).get();
    return navigateTo(piece);
  });

  return {
    [NAME]: computed(() => `Contacts (${count})`),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" style="gap: 8px;">
          <cf-hstack style="justify-content: space-between; align-items: center;">
            <cf-heading level={4}>Contacts</cf-heading>
            <cf-hstack style="gap: 8px;">
              <cf-button
                variant="primary"
                onClick={addPerson({ contacts, selectedIndex })}
              >
                + Person
              </cf-button>
              <cf-button
                variant="secondary"
                onClick={addFamilyMember({ contacts, selectedIndex })}
              >
                + Family
              </cf-button>
              <cf-button
                variant="ghost"
                size="sm"
                onClick={addGroup({ groups })}
              >
                + Group
              </cf-button>
            </cf-hstack>
          </cf-hstack>
        </cf-vstack>

        <cf-resizable-panel-group direction="horizontal" style="flex: 1;">
          {/* Left: Contact List */}
          <cf-resizable-panel default-size="35" min-size="25" max-size="50">
            <cf-vscroll style="height: 100%;">
              <cf-vstack style="gap: 4px; padding: 8px;">
                {/* Render contact list using reactive .map() */}
                {contacts.map((piece, index) => (
                  <cf-card
                    style={computed(() =>
                      selectedIndex.get() === index
                        ? "background: var(--cf-colors-blue-50, #eff6ff); border: 1px solid var(--cf-colors-blue-500, #93c5fd); cursor: pointer;"
                        : "cursor: pointer;"
                    )}
                    onClick={selectContact({ selectedIndex, index })}
                  >
                    <cf-hstack style="gap: 8px; align-items: center;">
                      <span
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "50%",
                          background: "#e5e7eb",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "14px",
                          flexShrink: "0",
                        }}
                      >
                        {computed(() => {
                          const name = piece[NAME] || "";
                          const parts = name.split(" ");
                          if (parts.length >= 2) {
                            return (parts[0].charAt(0) + parts[1].charAt(0))
                              .toUpperCase();
                          }
                          return name.charAt(0).toUpperCase() || "?";
                        })}
                      </span>

                      <span style={{ flex: "1" }}>{piece[NAME]}</span>

                      <cf-button
                        variant="ghost"
                        size="sm"
                        onClick={removeContact({
                          contacts,
                          groups,
                          index,
                          selectedIndex,
                        })}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  </cf-card>
                ))}
              </cf-vstack>
            </cf-vscroll>
          </cf-resizable-panel>

          <cf-resizable-handle />

          {/* Right: Detail View - just render the piece's [UI] */}
          <cf-resizable-panel default-size="65" min-size="30">
            {computed(() => {
              const idx = selectedIndex.get();
              if (idx < 0 || idx >= (contacts.get() || []).length) {
                return (
                  <cf-vstack style="height: 100%; align-items: center; justify-content: center; color: #6b7280;">
                    <span style={{ fontSize: "48px" }}>←</span>
                    <span>Select a contact to view details</span>
                  </cf-vstack>
                );
              }

              const piece = contacts.key(idx);

              // Piece already has [UI] - just render it with wrapper
              return (
                <cf-vstack style="height: 100%;">
                  <cf-hstack style="padding: 8px 16px; border-bottom: 1px solid #e5e7eb; justify-content: flex-end;">
                    <cf-button
                      variant="outline"
                      size="sm"
                      onClick={openInNewView}
                    >
                      Open ↗
                    </cf-button>
                  </cf-hstack>

                  <cf-render $cell={piece} />
                </cf-vstack>
              );
            })}
          </cf-resizable-panel>
        </cf-resizable-panel-group>
      </cf-screen>
    ),
    contacts,
    groups,
    count,
  };
});
