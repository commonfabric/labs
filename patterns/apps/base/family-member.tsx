/**
 * FamilyMember - Sub-type pattern extending PersonLike.
 *
 * Demonstrates the "fork-on-demand" concept for canonical base patterns.
 * A user who needs family tracking creates this pattern, which adds
 * domain-specific fields while remaining compatible with PersonLike.
 *
 * Any container accepting PersonLike[] can include FamilyMember items.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import type {
  ContactPiece,
  FamilyMember,
  PersonLike,
} from "./contact-types.tsx";

// Re-export for backwards compatibility
export type { FamilyMember } from "./contact-types.tsx";

// ============================================================================
// Constants
// ============================================================================

const RELATIONSHIP_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "spouse", label: "Spouse" },
  { value: "partner", label: "Partner" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "sibling", label: "Sibling" },
  { value: "grandparent", label: "Grandparent" },
  { value: "grandchild", label: "Grandchild" },
  { value: "aunt", label: "Aunt" },
  { value: "uncle", label: "Uncle" },
  { value: "cousin", label: "Cousin" },
  { value: "niece", label: "Niece" },
  { value: "nephew", label: "Nephew" },
  { value: "in-law", label: "In-law" },
  { value: "other", label: "Other" },
];

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  member: Writable<
    | FamilyMember
    | Default<{
      firstName: "";
      lastName: "";
      relationship: "";
      birthday: "";
      dietaryRestrictions: [];
      notes: "";
      tags: [];
      allergies: [];
      giftIdeas: [];
    }>
  >;
  // Optional: reactive source of sibling contacts for sameAs linking.
  sameAs?: Writable<ContactPiece[]>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  member: FamilyMember;
}

// ============================================================================
// Handlers
// ============================================================================

// Handler for cf-tags change event
const updateDietaryRestrictions = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  member.update({ dietaryRestrictions: detail?.tags ?? [] });
});

const updateTags = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  member.update({ tags: detail?.tags ?? [] });
});

const updateAllergies = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  member.update({ allergies: detail?.tags ?? [] });
});

const updateGiftIdeas = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  member.update({ giftIdeas: detail?.tags ?? [] });
});

// sameAs handlers
const selectSameAs = handler<
  { detail: { data?: PersonLike } },
  { member: Writable<FamilyMember>; showPicker: Writable<boolean> }
>(({ detail }, { member, showPicker }) => {
  const linked = detail?.data;
  if (!linked) return;
  member.update({ sameAs: linked });
  showPicker.set(false);
});

const clearSameAs = handler<unknown, { member: Writable<FamilyMember> }>(
  (_event, { member }) => {
    member.update({ sameAs: undefined });
  },
);

const togglePicker = handler<unknown, { showPicker: Writable<boolean> }>(
  (_event, { showPicker }) => {
    showPicker.set(!showPicker.get());
  },
);

const toggle = handler<Record<string, never>, { section: Writable<boolean> }>(
  (_event, { section }) => {
    section.set(!section.get());
  },
);

// ============================================================================
// UI Helpers
// ============================================================================

function buildSectionHeaderLabel(
  label: string,
  expanded: boolean,
  count = 0,
  showCount = false,
): string {
  const arrow = expanded ? "▾" : "▸";
  const suffix = showCount && count > 0 ? ` (${count})` : "";
  return `${arrow} ${label}${suffix}`;
}

function header(
  labelContent: string,
  onClick: Stream<Record<string, never>>,
) {
  return (
    <cf-hstack
      style={{
        justifyContent: "space-between",
        alignItems: "center",
        cursor: "pointer",
        paddingTop: "8px",
        borderTop: "1px solid #e5e7eb",
      }}
      onClick={onClick}
    >
      <label style={{ fontSize: "12px", color: "#6b7280", fontWeight: "600" }}>
        {labelContent}
      </label>
    </cf-hstack>
  );
}

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ member, sameAs }) => {
  // Computed display name showing name and relationship
  const displayName = computed(() => {
    const first = member.key("firstName").get();
    const last = member.key("lastName").get();
    const rel = member.key("relationship").get();

    let name = "";
    if (first && last) name = `${first} ${last}`;
    else if (first) name = first;
    else if (last) name = last;

    if (name && rel) return `${name} (${rel})`;
    if (name) return name;
    return "Family Member";
  });

  // Computed: current sameAs link display
  const sameAsDisplay = computed(() => {
    const linked = member.key("sameAs").get();
    if (!linked) return null;
    const first = linked.firstName || "";
    const last = linked.lastName || "";
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return "Unknown";
  });

  // State: whether the sameAs picker is expanded
  const showPicker = new Writable(false);

  // Section expansion state
  const showFamilyInfo = new Writable(true);
  const showHealth = new Writable(false);
  const showGifts = new Writable(false);
  const showNotes = new Writable(false);

  const familyHeader = computed(() =>
    buildSectionHeaderLabel("Family Info", showFamilyInfo.get())
  );
  const healthHeader = computed(() =>
    buildSectionHeaderLabel(
      "Health & Diet",
      showHealth.get(),
      (member.key("dietaryRestrictions").get() || []).length +
        (member.key("allergies").get() || []).length,
      true,
    )
  );
  const giftIdeasHeader = computed(() =>
    buildSectionHeaderLabel(
      "Gift Ideas",
      showGifts.get(),
      (member.key("giftIdeas").get() || []).length,
      true,
    )
  );
  const notesHeader = computed(() =>
    buildSectionHeaderLabel("Notes", showNotes.get())
  );

  // Each section's toggle is bound here rather than inside the rendered tree.
  // A handler bound inside a JSX expression that also calls a helper is
  // compiled as part of that expression, and the binding is not available
  // there.
  const toggleFamilyInfo = toggle({ section: showFamilyInfo });
  const toggleHealth = toggle({ section: showHealth });
  const toggleGifts = toggle({ section: showGifts });
  const toggleNotes = toggle({ section: showNotes });

  // Computed: autocomplete items from reactive sibling source, filtering self
  const sameAsItems = computed(() => {
    if (!sameAs) return [];
    const all = sameAs.get();
    if (!all || all.length === 0) return [];

    const selfFirst = member.key("firstName").get();
    const selfLast = member.key("lastName").get();
    const hasSelfName = Boolean(selfFirst || selfLast);

    const result: Array<{ value: string; label: string; data: PersonLike }> =
      [];
    for (const c of all) {
      const p = c.person ?? c.member;
      if (!p) continue;
      // Only filter by name if this contact actually has a name set
      if (
        hasSelfName &&
        p.firstName === selfFirst &&
        p.lastName === selfLast
      ) {
        continue;
      }
      const label = p.firstName && p.lastName
        ? `${p.firstName} ${p.lastName}`
        : p.firstName || p.lastName || "Person";
      result.push({ value: label, label, data: p });
    }
    return result;
  });

  const hasSameAsCandidates = computed(() => sameAsItems.length > 0);

  return {
    [NAME]: displayName,
    [UI]: (
      <cf-screen>
        <cf-vstack style={{ gap: "16px", padding: "16px" }}>
          {/* Basic Info - always visible */}
          <cf-hstack style={{ gap: "8px" }}>
            <cf-vstack style={{ gap: "4px", flex: 1 }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                First Name
              </label>
              <cf-input
                $value={member.key("firstName")}
                placeholder="First name"
              />
            </cf-vstack>
            <cf-vstack style={{ gap: "4px", flex: 1 }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Last Name
              </label>
              <cf-input
                $value={member.key("lastName")}
                placeholder="Last name"
              />
            </cf-vstack>
          </cf-hstack>

          {/* Tags */}
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Tags</label>
            <cf-tags
              tags={member.key("tags")}
              oncf-change={updateTags({ member })}
            />
          </cf-vstack>

          {
            /* Family Info Section
           * WORKAROUND: Each computed() must be the sole reactive child of its
           * parent element. Multiple computed() siblings break rendering.
           * Wrap each sectionHeader+computed pair in a <div>.
           */
          }
          <div>
            {header(familyHeader, toggleFamilyInfo)}
            {computed(() => {
              if (!showFamilyInfo.get()) return null;
              return (
                <cf-vstack style={{ gap: "8px" }}>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Relationship
                    </label>
                    <cf-select
                      $value={member.key("relationship")}
                      items={RELATIONSHIP_OPTIONS}
                    />
                  </cf-vstack>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Birthday
                    </label>
                    <cf-input $value={member.key("birthday")} type="date" />
                  </cf-vstack>
                </cf-vstack>
              );
            })}
          </div>

          {/* Health & Diet Section */}
          <div>
            {header(healthHeader, toggleHealth)}
            {computed(() => {
              if (!showHealth.get()) return null;
              return (
                <cf-vstack style={{ gap: "8px" }}>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Dietary Restrictions
                    </label>
                    <cf-tags
                      tags={member.key("dietaryRestrictions")}
                      oncf-change={updateDietaryRestrictions({ member })}
                    />
                  </cf-vstack>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Allergies
                    </label>
                    <cf-tags
                      tags={member.key("allergies")}
                      oncf-change={updateAllergies({ member })}
                    />
                  </cf-vstack>
                </cf-vstack>
              );
            })}
          </div>

          {/* Gift Ideas Section */}
          <div>
            {header(giftIdeasHeader, toggleGifts)}
            {computed(() => {
              if (!showGifts.get()) return null;
              return (
                <cf-vstack style={{ gap: "4px" }}>
                  <cf-tags
                    tags={member.key("giftIdeas")}
                    oncf-change={updateGiftIdeas({ member })}
                  />
                </cf-vstack>
              );
            })}
          </div>

          {/* Notes Section */}
          <div>
            {header(notesHeader, toggleNotes)}
            {computed(() => {
              if (!showNotes.get()) return null;
              return (
                <cf-vstack style={{ gap: "4px" }}>
                  <cf-input
                    $value={member.key("notes")}
                    placeholder="Notes about this family member..."
                    multiple
                  />
                </cf-vstack>
              );
            })}
          </div>

          {/* sameAs Section - collapsed by default, only if candidates exist */}
          <div>
            {computed(() => {
              if (!hasSameAsCandidates) return null;

              const linkedName = sameAsDisplay;

              // If linked, show compact display
              if (linkedName) {
                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      paddingTop: "8px",
                      borderTop: "1px solid #e5e7eb",
                      fontSize: "12px",
                      color: "#6b7280",
                    }}
                  >
                    <span>Same as: {linkedName}</span>
                    <span
                      style={{ cursor: "pointer", fontSize: "14px" }}
                      onClick={clearSameAs({ member })}
                    >
                      ×
                    </span>
                  </div>
                );
              }

              // If picker is open, show autocomplete
              if (showPicker.get()) {
                return (
                  <cf-vstack
                    style={{
                      gap: "4px",
                      paddingTop: "8px",
                      borderTop: "1px solid #e5e7eb",
                    }}
                  >
                    <cf-autocomplete
                      items={sameAsItems}
                      placeholder="Search contacts..."
                      oncf-select={selectSameAs({ member, showPicker })}
                    />
                  </cf-vstack>
                );
              }

              // Collapsed: small link to expand
              return (
                <cf-hstack
                  style={{
                    paddingTop: "8px",
                    borderTop: "1px solid #e5e7eb",
                  }}
                >
                  <cf-button
                    variant="ghost"
                    size="sm"
                    onClick={togglePicker({ showPicker })}
                    style={{ fontSize: "12px", color: "#6b7280" }}
                  >
                    Link to another contact...
                  </cf-button>
                </cf-hstack>
              );
            })}
          </div>
        </cf-vstack>
      </cf-screen>
    ),
    member,
  };
});
