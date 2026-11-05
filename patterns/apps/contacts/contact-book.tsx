import {
  action,
  computed,
  Default,
  equals,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

import ContactDetail, { type Contact } from "./contact-detail.tsx";

export const matchesSearch = (contact: Contact, query: string): boolean => {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = (contact.name || "").toLowerCase();
  const email = (contact.email || "").toLowerCase();
  const company = (contact.company || "").toLowerCase();
  return name.includes(q) || email.includes(q) || company.includes(q);
};

interface Relationship {
  fromName: string;
  toName: string;
  label: string | Default<"">;
}

interface ContactBookInput {
  contacts: Writable<Contact[] | Default<[]>>;
  relationships: Writable<Relationship[] | Default<[]>>;
}

export interface ContactBookOutput {
  contacts: Contact[];
  relationships: Relationship[];
  mentionable: Contact[];
  summary: string;
  onAddContact: Stream<void>;
}

export default pattern<ContactBookInput, ContactBookOutput>(
  ({ contacts, relationships }) => {
    const searchQuery = new Writable("");

    const contactCount = computed(() => contacts.get().length);

    const summary = computed(() => {
      return contacts.get()
        .filter((c): c is Contact => c != null)
        .map((c) => c.name || "(unnamed)")
        .join(", ");
    });

    const contactSelectItems = computed(
      () =>
        contacts.get()
          .filter((c): c is Contact => c != null)
          .map((c) => ({ label: c.name || "(unnamed)", value: c.name })),
    );

    const onAddContact = action(() => {
      contacts.push({
        name: "",
        email: "",
        phone: "",
        company: "",
        tags: [],
        notes: "",
        createdAt: Date.now(),
      });
    });

    const newRelationFrom = new Writable("");
    const newRelationTo = new Writable("");
    const newRelationLabel = new Writable("");
    const onNewRelation = action(() => {
      const from = newRelationFrom.get();
      const to = newRelationTo.get();
      if (from && to && from !== to) {
        relationships.push({
          fromName: from,
          toName: to,
          label: newRelationLabel.get(),
        });
        newRelationFrom.set("");
        newRelationTo.set("");
        newRelationLabel.set("");
      }
    });

    return {
      [NAME]: "Contact Book",
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2">
            <cf-hstack justify="between" align="center">
              <cf-heading level={4}>Contacts ({contactCount})</cf-heading>
            </cf-hstack>
            <cf-input
              $value={searchQuery}
              placeholder="Search contacts..."
            />
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="2" style="padding: 1rem;">
              {contacts.map((contact) => {
                const isVisible = computed(() =>
                  matchesSearch(contact, searchQuery.get())
                );

                const contactRelations = computed(() => {
                  const name = contact.name;
                  return relationships
                    .get()
                    .filter(
                      (r: Relationship) =>
                        r.fromName === name || r.toName === name,
                    );
                });

                const onClick = action(() => {
                  const detail = ContactDetail({ contact });
                  return navigateTo(detail);
                });

                const onDelete = action(() => {
                  const current = contacts.get();
                  const idx = current.findIndex((c) => equals(contact, c));
                  if (idx >= 0) {
                    contacts.set(current.toSpliced(idx, 1));
                  }
                });

                return ifElse(
                  isVisible,
                  <cf-card
                    style="cursor: pointer;"
                    onClick={onClick}
                  >
                    <cf-hstack gap="2" align="start">
                      <cf-vstack gap="1" style="flex: 1;">
                        <span style="font-weight: 600; font-size: 1rem;">
                          {contact.name || "(unnamed)"}
                        </span>
                        {contact.email && (
                          <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                            {contact.email}
                          </span>
                        )}
                        {contact.company && (
                          <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                            {contact.company}
                          </span>
                        )}
                        {/* Show relationships */}
                        {contactRelations.map((rel: Relationship) => (
                          <span style="font-size: 0.75rem; color: var(--cf-colors-primary-500);">
                            ↔ {rel.fromName === contact.name
                              ? rel.toName
                              : rel.fromName}
                            {rel.label && <span>({rel.label})</span>}
                          </span>
                        ))}
                      </cf-vstack>
                      <cf-button
                        variant="ghost"
                        onClick={onDelete}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  </cf-card>,
                  null,
                );
              })}

              {ifElse(
                computed(() => contacts.get().length === 0),
                <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 2rem;">
                  No contacts yet. Add one below!
                </div>,
                null,
              )}
            </cf-vstack>
          </cf-vscroll>

          <cf-vstack slot="footer" gap="2" style="padding: 1rem;">
            <cf-hstack gap="2">
              <cf-button
                variant="primary"
                onClick={onAddContact}
              >
                Add Contact
              </cf-button>
            </cf-hstack>

            <cf-hstack gap="2">
              <cf-select
                $value={newRelationFrom}
                items={contactSelectItems}
                placeholder="From..."
                style="flex: 1;"
              />
              <cf-select
                $value={newRelationTo}
                items={contactSelectItems}
                placeholder="To..."
                style="flex: 1;"
              />
              <cf-input
                $value={newRelationLabel}
                placeholder="Label..."
                style="width: 100px;"
              />
              <cf-button
                onClick={onNewRelation}
              >
                Link
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-screen>
      ),
      contacts,
      relationships,
      mentionable: contacts,
      summary,
      onAddContact,
    };
  },
);
