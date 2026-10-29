import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

describe("Stream with a declared result", () => {
  // A verb's declared result rides a second type parameter on `Stream` (verb
  // contract WS-C/C1). Schema generation must keep recognizing the property as
  // a stream when that parameter is present — the marker and the event schema
  // both come off the same type check, so if two type arguments confused it, a
  // returning verb would stop being a verb.

  async function schemaFor(code: string) {
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );
    return asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );
  }

  it("marks a result-declaring stream exactly like a value-less one", async () => {
    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface SchemaRoot {
  valueLess: Stream<AddTopic>;
  returning: Stream<AddTopic, TopicRef>;
}
`);

    const properties = asObjectSchema(schema).properties as Record<
      string,
      Record<string, unknown> | undefined
    >;

    // Both are streams. A declared result must not cost a verb its marker.
    expect(properties.valueLess?.asCell).toEqual(["stream"]);
    expect(properties.returning?.asCell).toEqual(["stream"]);
  });

  it("keeps the event as the payload schema, not the result", async () => {
    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface SchemaRoot {
  returning: Stream<AddTopic, TopicRef>;
}
`);

    const returning = asObjectSchema(
      (asObjectSchema(schema).properties as Record<string, unknown>)
        .returning,
    );

    // The stream's own schema describes what a caller SENDS: a reference to
    // the event type, carrying the marker. `cf piece verbs` publishes exactly
    // this as the input schema and `cf piece call` validates payloads against it,
    // so a result leaking in here would both misreport the verb and start
    // refusing good payloads.
    expect(returning.$ref).toBe("#/$defs/AddTopic");
    expect(returning.asCell).toEqual(["stream"]);
    expect(JSON.stringify(returning)).not.toContain("fid");
  });

  it("does not yet carry the result into the schema — that is C3", async () => {
    // C1 puts the result in the TYPE; emitting it into the schema is C3. Until
    // then a returning verb and a value-less one generate byte-identical
    // schemas and the result type never reaches `$defs` at all. Pinned so that
    // C3 has a baseline to move rather than a belief to check, and so the day
    // this stops being true is a failing test rather than a discovery.

    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface SchemaRoot {
  valueLess: Stream<AddTopic>;
  returning: Stream<AddTopic, TopicRef>;
}
`);

    const properties = asObjectSchema(schema).properties as Record<
      string,
      unknown
    >;
    expect(properties.returning).toEqual(properties.valueLess);

    const defs = asObjectSchema(schema).$defs as Record<string, unknown>;
    expect(Object.keys(defs)).toEqual(["AddTopic"]);
    expect(JSON.stringify(schema)).not.toContain("TopicRef");
  });

  it("leaves the event schema open — closed-world emission is blocked on the update gate (C5)", async () => {
    const schema = await schemaFor(`
interface SchemaRoot {
  verb: Stream<{ title: string }>;
}
`);

    const verb = asObjectSchema(
      (asObjectSchema(schema).properties as Record<string, unknown>).verb,
    );

    // The verb contract's design rule 1 wants EVENT schemas closed-world
    // (`additionalProperties: false` — an undeclared field is a rejection,
    // never ignored). Emitting it is currently BLOCKED: the pattern-update
    // gate judges a stream property under its enclosing role, and for a verb
    // arriving through a piece's ARGUMENT schema the argument-role
    // additionalProperties rule refuses the open→closed direction against
    // every recorded baseline ("additional properties accepted previously
    // would now be rejected" — measured on calendar/calendar.tsx,
    // lunch-poll/poll-option-card.tsx, notes/note.tsx). Landing the emission
    // needs that migration step first; the sequencing finding is recorded in
    // docs/history/plans/pattern-verb-contract-implementation.md (WS-C and
    // Risks).
    // Until then this pin makes the open event side an explicit decision, not
    // an omission — dispatch-side enforcement (runner, C5) already honors a
    // schema that declares the closure by hand.
    expect(Object.hasOwn(verb, "additionalProperties")).toBe(false);
    expect(verb.type).toBe("object");
  });
});
