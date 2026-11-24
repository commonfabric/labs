import { cell, handler, pattern, Stream } from "commonfabric";

interface Ping {
  word: string;
}

interface PingResult {
  echoed: string;
}

interface Verbs {
  ping: Stream<Ping, PingResult>;
  pingNamed: Stream<Ping, PingResult>;
  pingDeclared: Stream<Ping, PingResult>;
  poke: Stream<Ping>;
}

// The schema-first authored form: the author supplies the event and state
// schemas, so the transformer must not prepend generated ones — that would
// displace the callback out of the positions the runtime dispatch and the
// sandbox verifier accept (argument 0 or 2). With a declared result, the
// options object still lowers onto the trailing slot.
const ping = handler<Ping, { count: number }, PingResult>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  (event, _state) => {
    return { echoed: event.word };
  },
);

// The named-callback spelling of the same form: recognition is
// identifier-aware, so the call still passes through un-prepended and the
// declared result still lands in the trailing options. (SES-mode loading
// additionally demands a direct callback; the emission contract is what this
// pins — a garbled call would fail far more confusingly than the verifier's
// own refusal.)
const echoNamed = (event: Ping, _state: { count: number }): PingResult => ({
  echoed: event.word,
});
const pingNamed = handler<Ping, { count: number }, PingResult>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  echoNamed,
);

// A callback referenced as a function DECLARATION: no expression resolver can
// return it, so recognition asks callback-ness instead — without this, the
// prepend path ran and the trailing-options lowering spread-replaced the
// reference with the result options, handing the runtime a schema where its
// callback belonged.
function echoDeclared(event: Ping, _state: { count: number }): PingResult {
  return { echoed: event.word };
}
const pingDeclared = handler<Ping, { count: number }, PingResult>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  echoDeclared,
);

// The same form without a declared result: passed through untouched — no
// generated schemas, no options object.
const poke = handler<Ping, { count: number }>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  (_event, _state) => {},
);

export default pattern<Record<string, never>, Verbs>(() => {
  const count = cell(0);
  return {
    ping: ping({ count }),
    pingNamed: pingNamed({ count }),
    pingDeclared: pingDeclared({ count }),
    poke: poke({ count }),
  };
});

// FIXTURE: schema-first-declared-result
// Verifies: the schema-first authored form handler<E, T[, R]>(eventSchema,
//   stateSchema, callback) keeps its authored schemas and callback positions
//   — nothing is prepended — while a declared result still lowers into the
//   trailing options as `{ resultSchema: … }`. Without a declared result the
//   call passes through byte-identical.
// Context: before this recognition, the injection unconditionally prepended
//   two generated schemas, producing a call whose callback sat at argument 4
//   — a shape the runtime never reads and the sandbox verifier refuses.
