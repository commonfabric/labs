import { lift } from "commonfabric";

interface Person {
  name: string;
  age: number;
}

interface PersonWithYear {
  name: string;
  birthYear: number;
}

const currentYear = 2024;

// FIXTURE: schema-generation-lift-inside-jsx
// Verifies: lift() inside a JSX expression still gets schemas injected from inline param types
//   lift((person: Person): PersonWithYear => ...) → lift(inputSchema, outputSchema, fn)
// Context: lift() appears as a JSX child expression; schemas derived from param + return type annotations
export const result = (
  <div>
    {lift((person: Person): PersonWithYear => ({
      name: person.name,
      birthYear: currentYear - person.age,
    }))}
  </div>
);
