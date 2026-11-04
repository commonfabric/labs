import { computed, Default, NAME, pattern, UI, Writable } from "commonfabric";

/** Raw data shape - use in collection patterns */
export interface Contact {
  name: string;
  email: string | Default<"">;
  phone: string | Default<"">;
  company: string | Default<"">;
  tags: string[] | Default<[]>;
  notes: string | Default<"">;
  createdAt: number;
}

interface ContactDetailInput {
  contact: Writable<Contact>;
}

/** #contact #person */
export interface ContactDetailOutput {
  contact: Contact;
  summary: string;
}

export default pattern<ContactDetailInput, ContactDetailOutput>(
  ({ contact }) => {
    return {
      [NAME]: computed(() => `Contact: ${contact.key("name").get()}`),
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                Name
              </label>
              <cf-input
                $value={contact.key("name")}
                placeholder="Full name"
              />
            </cf-vstack>

            <cf-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                Email
              </label>
              <cf-input
                $value={contact.key("email")}
                placeholder="email@example.com"
                type="email"
              />
            </cf-vstack>

            <cf-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                Phone
              </label>
              <cf-input
                $value={contact.key("phone")}
                placeholder="+1 (555) 123-4567"
                type="tel"
              />
            </cf-vstack>

            <cf-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                Company
              </label>
              <cf-input
                $value={contact.key("company")}
                placeholder="Company name"
              />
            </cf-vstack>
          </cf-vstack>
        </cf-card>
      ),
      contact,
      summary: computed(() => {
        const c = contact.get();
        const parts = [c.name];
        if (c.company) parts.push(c.company);
        if (c.email) parts.push(c.email);
        if (c.notes) parts.push(c.notes.slice(0, 100));
        return parts.join(" - ");
      }),
    };
  },
);
