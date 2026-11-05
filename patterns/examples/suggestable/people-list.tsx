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

const PersonList = pattern<PersonListInput, PersonListOutput>(() => {
  const people = wish<Person>({ query: "#person", scope: [".", "~"] });

  return {
    [NAME]: computed(() =>
      people.candidates?.length
        ? `People: ${people.candidates?.length}`
        : "People"
    ),
    [UI]: (
      <cf-vstack gap="2" style="padding: 1.5rem;">
        <div>
          {people.candidates.map((person) => (
            <cf-hstack gap="2" align="center">
              <span>{person.contact.name}</span>
              <span>{person.contact.email}</span>
            </cf-hstack>
          ))}
        </div>
      </cf-vstack>
    ),
    people: people.candidates,
  };
});

export default PersonList;
