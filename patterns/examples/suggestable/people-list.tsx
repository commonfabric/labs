import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  wish,
} from "commonfabric";

// ===== Types =====

type PersonListInput = Record<string, never>;

type Person = {
  contact: {
    name: string;
    email: string | Default<"">;
  };
};

export type PersonListOutput = {
  [NAME]: string;
  [UI]: VNode;
  people: Person[];
};

// ===== Pattern =====

export interface PersonListViewInput {
  /** The people to list. */
  people: Person[];
}

/** Lists `people`, and counts them in its name. */
export const PersonListView = pattern<PersonListViewInput, PersonListOutput>((
  { people },
) => {
  return {
    [NAME]: computed(() =>
      people.length ? `People: ${people.length}` : "People"
    ),
    [UI]: (
      <cf-vstack gap="2" style="padding: 1.5rem;">
        <div>
          {people.map((person) => (
            <cf-hstack gap="2" align="center">
              <span>{person.contact.name}</span>
              <span>{person.contact.email}</span>
            </cf-hstack>
          ))}
        </div>
      </cf-vstack>
    ),
    people,
  };
});

/** Lists the people the space and the viewer's home space mention. */
const PersonList = pattern<PersonListInput, PersonListOutput>(() => {
  const people = wish<Person>({ query: "#person", scope: [".", "~"] });
  return PersonListView({ people: people.candidates });
});

export default PersonList;
