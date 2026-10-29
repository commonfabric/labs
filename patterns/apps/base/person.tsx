/**
 * Person - Canonical base pattern for person data.
 *
 * This pattern serves as the schelling point for person-like data.
 * It implements the PersonLike interface ({ firstName, lastName }) and adds
 * optional contact fields (email, phone) plus rich detail fields
 * (notes, tags, addresses, socialProfiles).
 *
 * Sub-types can extend Person or PersonLike to add domain-specific fields:
 * - FamilyMember adds: relationship, birthday, dietary restrictions
 * - Colleague adds: company, department, title
 * - Contact adds: multiple phones, addresses, social profiles
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

import type { ContactPiece, Person, PersonLike } from "./contact-types.tsx";

// Re-export for backwards compatibility
export type { ContactPiece, Person, PersonLike } from "./contact-types.tsx";

// ============================================================================
// Constants
// ============================================================================

const SOCIAL_PLATFORM_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "LinkedIn", label: "LinkedIn" },
  { value: "Twitter", label: "Twitter" },
  { value: "GitHub", label: "GitHub" },
  { value: "Instagram", label: "Instagram" },
  { value: "Facebook", label: "Facebook" },
  { value: "Website", label: "Website" },
  { value: "Other", label: "Other" },
];

const MONTH_OPTIONS = [
  { value: "0", label: "Month..." },
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

const DAY_OPTIONS = [
  { value: "0", label: "Day..." },
  ...Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  })),
];

const MONTH_NAMES = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const ADDRESS_LABEL_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "Home", label: "Home" },
  { value: "Work", label: "Work" },
  { value: "Other", label: "Other" },
];

// ============================================================================
// Handlers
// ============================================================================

const selectSameAs = handler<
  { detail: { data?: PersonLike } },
  { person: Writable<Person>; showPicker: Writable<boolean> }
>(({ detail }, { person, showPicker }) => {
  const linked = detail?.data;
  if (!linked) return;
  person.update({ sameAs: linked });
  showPicker.set(false);
});

const clearSameAs = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    person.update({ sameAs: undefined });
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

const updateTags = handler<
  { detail: { tags: string[] } },
  { person: Writable<Person> }
>(({ detail }, { person }) => {
  person.update({ tags: detail?.tags ?? [] });
});

const addAddress = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    const addresses = [...(person.get().addresses || [])];
    addresses.push({
      label: "",
      street: "",
      city: "",
      state: "",
      zip: "",
      country: "",
    });
    person.update({ addresses });
  },
);

const removeAddress = handler<
  unknown,
  { person: Writable<Person>; index: number }
>((_event, { person, index }) => {
  const addresses = [...(person.get().addresses || [])];
  addresses.splice(index, 1);
  person.update({ addresses });
});

const addSocialProfile = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    const socialProfiles = [...(person.get().socialProfiles || [])];
    socialProfiles.push({ platform: "", url: "" });
    person.update({ socialProfiles });
  },
);

const removeSocialProfile = handler<
  unknown,
  { person: Writable<Person>; index: number }
>((_event, { person, index }) => {
  const socialProfiles = [...(person.get().socialProfiles || [])];
  socialProfiles.splice(index, 1);
  person.update({ socialProfiles });
});

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  person: Writable<
    | Person
    | Default<{
      firstName: "";
      lastName: "";
      middleName: "";
      nickname: "";
      prefix: "";
      suffix: "";
      pronouns: "";
      birthday: { month: 0; day: 0; year: 0 };
      photo: "";
      email: "";
      phone: "";
      notes: "";
      tags: [];
      addresses: [];
      socialProfiles: [];
    }>
  >;
  // Optional: reactive source of sibling contacts for sameAs linking.
  sameAs?: Writable<ContactPiece[]>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  person: Person;
}

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

export default pattern<Input, Output>(({ person, sameAs }) => {
  // Computed display name from first + last name
  const displayName = computed(() => {
    const first = person.key("firstName").get();
    const last = person.key("lastName").get();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return "Person";
  });

  // Computed: current sameAs link display
  const sameAsDisplay = computed(() => {
    const linked = person.key("sameAs").get();
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
  const showNameDetails = new Writable(false);
  const showContactInfo = new Writable(true);
  const showAddresses = new Writable(false);
  const showSocial = new Writable(false);
  const showNotes = new Writable(false);

  const nameHeader = computed(() =>
    buildSectionHeaderLabel("Name Details", showNameDetails.get())
  );
  const contactHeader = computed(() =>
    buildSectionHeaderLabel("Contact Info", showContactInfo.get())
  );
  const addressesHeader = computed(() =>
    buildSectionHeaderLabel(
      "Addresses",
      showAddresses.get(),
      (person.key("addresses").get() || []).length,
      true,
    )
  );
  const socialHeader = computed(() =>
    buildSectionHeaderLabel(
      "Social Profiles",
      showSocial.get(),
      (person.key("socialProfiles").get() || []).length,
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
  const toggleNameDetails = toggle({ section: showNameDetails });
  const toggleContactInfo = toggle({ section: showContactInfo });
  const toggleAddresses = toggle({ section: showAddresses });
  const toggleSocial = toggle({ section: showSocial });
  const toggleNotes = toggle({ section: showNotes });

  // Computed: autocomplete items from reactive sibling source, filtering self
  const sameAsItems = computed(() => {
    if (!sameAs) return [];
    const all = sameAs.get();
    if (!all || all.length === 0) return [];

    const selfFirst = person.key("firstName").get();
    const selfLast = person.key("lastName").get();
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
                $value={person.key("firstName")}
                placeholder="First name"
              />
            </cf-vstack>
            <cf-vstack style={{ gap: "4px", flex: 1 }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Last Name
              </label>
              <cf-input
                $value={person.key("lastName")}
                placeholder="Last name"
              />
            </cf-vstack>
          </cf-hstack>

          {/* Pronouns */}
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Pronouns
            </label>
            <cf-input
              $value={person.key("pronouns")}
              placeholder="e.g. he/him, she/her, they/them"
            />
          </cf-vstack>

          {/* Tags */}
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Tags</label>
            <cf-tags
              tags={person.key("tags")}
              oncf-change={updateTags({ person })}
            />
          </cf-vstack>

          {/* Name Details Section */}
          <div>
            {header(nameHeader, toggleNameDetails)}
            {computed(() => {
              if (!showNameDetails.get()) return null;
              return (
                <cf-vstack style={{ gap: "8px" }}>
                  <cf-hstack style={{ gap: "8px" }}>
                    <cf-vstack style={{ gap: "4px", flex: 1 }}>
                      <label style={{ fontSize: "12px", color: "#6b7280" }}>
                        Prefix
                      </label>
                      <cf-input
                        $value={person.key("prefix")}
                        placeholder="Dr., Mr., Prof."
                      />
                    </cf-vstack>
                    <cf-vstack style={{ gap: "4px", flex: 1 }}>
                      <label style={{ fontSize: "12px", color: "#6b7280" }}>
                        Suffix
                      </label>
                      <cf-input
                        $value={person.key("suffix")}
                        placeholder="Jr., III, Ph.D."
                      />
                    </cf-vstack>
                  </cf-hstack>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Middle Name
                    </label>
                    <cf-input
                      $value={person.key("middleName")}
                      placeholder="Middle name"
                    />
                  </cf-vstack>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Nickname
                    </label>
                    <cf-input
                      $value={person.key("nickname")}
                      placeholder="Preferred name / what they go by"
                    />
                  </cf-vstack>
                </cf-vstack>
              );
            })}
          </div>

          {/* Birthday Section */}
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Birthday
            </label>
            <cf-hstack style={{ gap: "8px", alignItems: "center" }}>
              <cf-select
                $value={person.key("birthday").key("month")}
                items={MONTH_OPTIONS}
              />
              <cf-select
                $value={person.key("birthday").key("day")}
                items={DAY_OPTIONS}
              />
              <cf-input
                $value={person.key("birthday").key("year")}
                placeholder="Year"
                style={{ width: "80px" }}
              />
            </cf-hstack>
            {computed(() => {
              const month = person.key("birthday").key("month").get() || 0;
              const day = person.key("birthday").key("day").get() || 0;
              const year = person.key("birthday").key("year").get() || 0;
              if (month === 0 || day === 0) return null;
              const monthName = MONTH_NAMES[month] || "";
              const display = year > 0
                ? `${monthName} ${day}, ${year}`
                : `${monthName} ${day}`;
              return (
                <span style={{ fontSize: "12px", color: "#6b7280" }}>
                  {display}
                </span>
              );
            })}
          </cf-vstack>

          {/* Photo URL */}
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Photo URL
            </label>
            <cf-input
              $value={person.key("photo")}
              placeholder="https://..."
              type="url"
            />
          </cf-vstack>

          {
            /* Contact Info Section
           * WORKAROUND: Each computed() must be the sole reactive child of its
           * parent element. Multiple computed() siblings break rendering.
           * Wrap each sectionHeader+computed pair in a <div>.
           */
          }
          <div>
            {header(contactHeader, toggleContactInfo)}
            {computed(() => {
              if (!showContactInfo.get()) return null;
              return (
                <cf-vstack style={{ gap: "8px" }}>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Email
                    </label>
                    <cf-input
                      $value={person.key("email")}
                      placeholder="Email"
                      type="email"
                    />
                  </cf-vstack>
                  <cf-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Phone
                    </label>
                    <cf-input
                      $value={person.key("phone")}
                      placeholder="Phone"
                      type="tel"
                    />
                  </cf-vstack>
                </cf-vstack>
              );
            })}
          </div>

          {/* Addresses Section */}
          <div>
            {header(addressesHeader, toggleAddresses)}
            {computed(() => {
              if (!showAddresses.get()) return null;
              const addresses = person.key("addresses").get() || [];
              return (
                <cf-vstack style={{ gap: "8px" }}>
                  {addresses.map((_addr, i) => (
                    <cf-card>
                      <cf-vstack style={{ gap: "4px" }}>
                        <cf-hstack
                          style={{
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <cf-select
                            $value={person
                              .key("addresses")
                              .key(i)
                              .key("label")}
                            items={ADDRESS_LABEL_OPTIONS}
                          />
                          <cf-button
                            variant="ghost"
                            size="sm"
                            onClick={removeAddress({ person, index: i })}
                          >
                            ×
                          </cf-button>
                        </cf-hstack>
                        <cf-input
                          $value={person
                            .key("addresses")
                            .key(i)
                            .key("street")}
                          placeholder="Street"
                        />
                        <cf-hstack style={{ gap: "4px" }}>
                          <cf-input
                            $value={person
                              .key("addresses")
                              .key(i)
                              .key("city")}
                            placeholder="City"
                            style={{ flex: "1" }}
                          />
                          <cf-input
                            $value={person
                              .key("addresses")
                              .key(i)
                              .key("state")}
                            placeholder="State"
                            style={{ width: "60px" }}
                          />
                          <cf-input
                            $value={person.key("addresses").key(i).key("zip")}
                            placeholder="Zip"
                            style={{ width: "80px" }}
                          />
                        </cf-hstack>
                        <cf-input
                          $value={person
                            .key("addresses")
                            .key(i)
                            .key("country")}
                          placeholder="Country"
                        />
                      </cf-vstack>
                    </cf-card>
                  ))}
                  <cf-button
                    variant="ghost"
                    size="sm"
                    onClick={addAddress({ person })}
                  >
                    + Add Address
                  </cf-button>
                </cf-vstack>
              );
            })}
          </div>

          {/* Social Profiles Section */}
          <div>
            {header(socialHeader, toggleSocial)}
            {computed(() => {
              if (!showSocial.get()) return null;
              const profiles = person.key("socialProfiles").get() || [];
              return (
                <cf-vstack style={{ gap: "8px" }}>
                  {profiles.map((_profile, i) => (
                    <cf-hstack style={{ gap: "4px", alignItems: "center" }}>
                      <cf-select
                        $value={person
                          .key("socialProfiles")
                          .key(i)
                          .key("platform")}
                        items={SOCIAL_PLATFORM_OPTIONS}
                      />
                      <cf-input
                        $value={person
                          .key("socialProfiles")
                          .key(i)
                          .key("url")}
                        placeholder="URL"
                        style={{ flex: "1" }}
                      />
                      <cf-button
                        variant="ghost"
                        size="sm"
                        onClick={removeSocialProfile({ person, index: i })}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  ))}
                  <cf-button
                    variant="ghost"
                    size="sm"
                    onClick={addSocialProfile({ person })}
                  >
                    + Add Profile
                  </cf-button>
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
                    $value={person.key("notes")}
                    placeholder="Notes about this person..."
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
                      onClick={clearSameAs({ person })}
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
                      oncf-select={selectSameAs({ person, showPicker })}
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
    person,
  };
});
