import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import type { PieceCallablesListing } from "../lib/piece.ts";
import { listPieceCallables, partitionVerbListing } from "../lib/piece.ts";
import { verbListingJson, verbListingLines } from "../commands/piece.ts";

const TEST_PATTERN_REF = {
  source: {
    ref: "sha256:deadbeef",
    repository: "labs",
    entry: "patterns/apps/topics/main.tsx",
  },
} as never;

const ADD_TOPIC_EVENT: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    agentName: { type: "string" },
  },
  required: ["title"],
};

/** Two event schemas that cannot be mistaken for one another: a row carrying
 * one names which cell the listing reached the verb on. */
const RESULT_SIDE_EVENT: JSONSchema = {
  type: "object",
  properties: { note: { type: "string" } },
  required: ["note"],
};

const INPUT_SIDE_EVENT: JSONSchema = {
  type: "object",
  properties: { seed: { type: "number" } },
};

const SEARCH_ARGUMENTS: JSONSchema = {
  type: "object",
  properties: { query: { type: "string" }, source: { type: "string" } },
  required: ["query", "source"],
};

const SEARCH_RESULT: JSONSchema = {
  type: "object",
  properties: { summary: { type: "string" } },
};

const CREATE_NOTE_RESULT: JSONSchema = {
  type: "object",
  properties: { note: { type: "object" } },
  required: ["note"],
};

/** A declared tool property, as the generator lowers a `patternTool` result
 * type: the shape `isPatternToolSchema` classifies on, and nothing a caller
 * could build a payload from — the arguments ride the tool value itself. */
const TOOL_PROPERTY: JSONSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "object",
      properties: {
        argumentSchema: { type: "object" },
        resultSchema: { type: "object" },
      },
    },
    extraParams: { type: "object" },
  },
};

/** A tool as `patternTool` stores it in a compiled result: the sub-pattern's
 * schemas inline, and the parameters the tool binds. */
function toolValue(bound: Record<string, unknown> = {}) {
  return {
    pattern: {
      argumentSchema: SEARCH_ARGUMENTS,
      resultSchema: SEARCH_RESULT,
      result: {},
      nodes: [],
    },
    extraParams: bound,
  };
}

/** One compiled result property as the builder serializes a stream: an alias
 * to a derived internal cell, named by its cause. Taken from what
 * `patternManager.compilePattern` actually emits for a CTS `action` — both the
 * result property and the handler node's `$event` carry this same shape. */
function streamAlias(cause: unknown, schema: JSONSchema | true = true) {
  return { $alias: { partialCause: cause, scope: "space", path: [], schema } };
}

/** A handler node driving the stream `cause` names, declaring `event` as
 * what it reads and `result` as what it returns. */
function handlerNode(
  cause: unknown,
  { event, result }: { event?: JSONSchema; result?: JSONSchema } = {},
) {
  return {
    module: {
      wrapper: "handler",
      ...(event !== undefined
        ? {
          argumentSchema: {
            type: "object",
            properties: { $event: event, $ctx: { type: "object" } },
          },
        }
        : {}),
      ...(result !== undefined ? { resultSchema: result } : {}),
    },
    inputs: { $event: streamAlias(cause) },
    outputs: {},
  };
}

/** A compiled pattern double. `getPattern()` resolves a real `Pattern`, which
 * is CALLABLE with its schemas and graph hung off it — a plain object here
 * would pass a lister that rejects the shape the runtime actually hands it. */
function compiledPattern(
  graph: {
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    result?: Record<string, unknown>;
    nodes?: unknown[];
  },
) {
  return Object.assign(() => {}, { result: {}, nodes: [], ...graph });
}

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  piece: "fid1:piece-123",
  space: "home",
};

/**
 * The listing of `pattern`, through a piece double that offers the compiled
 * pattern and nothing else. Every cell the piece could hand out throws on
 * access: the listing is read from the pattern alone, and a lister reaching
 * for a cell fails here rather than passing on a double that happened to
 * answer.
 */
function listPattern(
  pattern: ReturnType<typeof compiledPattern>,
  overrides: Record<string, unknown> = {},
): Promise<PieceCallablesListing> {
  const trap = (name: string) => () => {
    throw new Error(`read the piece's ${name}`);
  };
  const piece = {
    get result() {
      return trap("result cell")();
    },
    get input() {
      return trap("input cell")();
    },
    getCell: trap("root cell"),
    getPatternRef: () => Promise.resolve(TEST_PATTERN_REF),
    getPattern: () => Promise.resolve(pattern),
    ...overrides,
  };
  return listPieceCallables(CONFIG, {
    loadPieces: () => Promise.resolve({ getSpace: () => "home" } as never),
    loadPiece: () => Promise.resolve(piece as never),
  });
}

describe("listPieceCallables", () => {
  it("loads the addressed piece without starting it or the space root", async () => {
    // Discovery reads the addressed piece and nothing else: the space root's
    // bootstrap and the target's start are dispatch concerns. The root double
    // carries no pattern a controller could load, so the listing it yields is
    // the honest empty one.
    const pieceRoot = { entityId: { "/": "fid1:piece-stored" } };
    const getPieceCellCalls: unknown[][] = [];
    let ensureCalls = 0;
    const manager = {
      ensureDefaultPattern: () => {
        ensureCalls++;
        return Promise.resolve();
      },
      getPieceCell: (...args: unknown[]) => {
        getPieceCellCalls.push(args);
        return Promise.resolve(pieceRoot);
      },
      getSpace: () => "home",
    };

    const listing = await listPieceCallables(
      { ...CONFIG, piece: "fid1:piece-stored" },
      { loadPieces: () => Promise.resolve(manager as never) },
    );

    expect(ensureCalls).toBe(0);
    expect(getPieceCellCalls).toEqual([
      [
        "fid1:piece-stored",
        { reconcile: true, start: false },
        undefined,
        undefined,
      ],
    ]);
    expect(listing.verbs).toEqual([]);
    expect(listing.incomplete).toBe("pattern-unavailable");
  });

  it("loads the pattern reference and compiled pattern concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const started: string[] = [];
    const pending = listPattern(compiledPattern({}), {
      getPatternRef: async () => {
        started.push("reference");
        await gate;
        return TEST_PATTERN_REF;
      },
      getPattern: async () => {
        started.push("compiled");
        await gate;
        return compiledPattern({});
      },
    });
    for (let i = 0; i < 10 && started.length < 2; i++) await Promise.resolve();
    const beforeRelease = [...started].sort();
    release();

    expect(beforeRelease).toEqual(["compiled", "reference"]);
    await pending;
  });

  it("lists the handlers and tools the declared result type carries, and none of its data", async () => {
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        type: "object",
        properties: {
          addTopic: {
            $ref: "#/$defs/AddTopicEvent",
            asCell: ["stream"],
            description: "File a topic on the board.",
          },
          search: TOOL_PROPERTY,
          topicCount: { type: "number" },
          // Byte ordering: utf8Compare puts this AFTER `search` (0xC3 > s),
          // where locale collation would interleave it linguistically.
          "\u00e9dit": { asCell: ["stream"], type: "object" },
        },
        $defs: { AddTopicEvent: ADD_TOPIC_EVENT },
      },
      result: {
        addTopic: streamAlias({ stream: "addTopic" }),
        search: toolValue({ source: "bound-source" }),
        topicCount: streamAlias("topicCount", { type: "number" }),
        "\u00e9dit": streamAlias({ stream: "\u00e9dit" }),
      },
    }));

    // The deployed pattern's identity rides the listing — the skew detector.
    expect(listing.pattern).toEqual(TEST_PATTERN_REF);
    expect(listing.incomplete).toBeUndefined();
    expect(listing.verbs.map((verb) => verb.name)).toEqual([
      "addTopic",
      "search",
      "\u00e9dit",
    ]);
    const [addTopic, search, accented] = listing.verbs;
    // The event type is served resolved: the definition, not the reference
    // with the verb's own prose and marker beside it.
    expect(addTopic).toEqual({
      name: "addTopic",
      kind: "handler",
      on: "result",
      inputSchema: ADD_TOPIC_EVENT,
      description: "File a topic on the board.",
    });
    // A tool's arguments ride the stored tool, less what it binds.
    expect(search).toEqual({
      name: "search",
      kind: "tool",
      on: "result",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      outputSchema: SEARCH_RESULT,
    });
    // An inline event serves its own shape without the stream marker.
    expect(accented.inputSchema).toEqual({ type: "object" });
  });

  it("serves an inline event without the keys that describe the verb", async () => {
    // A `Stream<void>` verb declares nothing about its event; what sits on
    // the property is the marker that makes it a verb and the prose and marks
    // the row publishes as fields of its own. None of that is a payload shape.
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        type: "object",
        properties: {
          saveBody: {
            asCell: ["stream", "opaque"],
            description: "UI wrapper: publish the draft.",
            tier: "wrapper",
          },
        },
      },
    }));

    expect(listing.verbs).toEqual([{
      name: "saveBody",
      kind: "handler",
      on: "result",
      inputSchema: {},
      description: "UI wrapper: publish the draft.",
      tier: "wrapper",
    }]);
  });

  it("reads a result type declared as a named definition", async () => {
    // A created piece's result is the named type its author declared, so the
    // properties live in the definition the root references — and the
    // definition may carry references of its own. The event served is cut to
    // the definitions it reaches, named as the `$defs` map names them: a
    // reference is a JSON Pointer, so a key holding `/` or `~` arrives
    // escaped and must still find its definition.
    const author: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        $ref: "#/$defs/TopicOutput",
        $defs: {
          TopicOutput: {
            type: "object",
            properties: {
              addComment: {
                $ref: "#/$defs/AddCommentEvent",
                asCell: ["stream"],
              },
              body: { type: "string" },
            },
          },
          AddCommentEvent: {
            type: "object",
            properties: {
              note: { type: "string" },
              author: { $ref: "#/$defs/Topic~1Author" },
            },
            required: ["note"],
          },
          "Topic/Author": author,
          Unreached: { type: "number" },
        },
      },
    }));

    expect(listing.verbs).toEqual([{
      name: "addComment",
      kind: "handler",
      on: "result",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string" },
          author: { $ref: "#/$defs/Topic~1Author" },
        },
        required: ["note"],
        $defs: { "Topic/Author": author },
      },
    }]);
  });

  for (const on of ["result", "input"] as const) {
    const schemaKey = on === "result" ? "resultSchema" : "argumentSchema";

    it(`carries transitive definitions in an inline ${on} verb's event schema`, async () => {
      const event: JSONSchema = {
        type: "object",
        properties: { author: { $ref: "#/$defs/Author" } },
        required: ["author"],
      };
      const author: JSONSchema = {
        type: "object",
        properties: { address: { $ref: "#/$defs/Address" } },
      };
      const address: JSONSchema = {
        type: "object",
        properties: { city: { type: "string" } },
      };
      const listing = await listPattern(compiledPattern({
        [schemaKey]: {
          type: "object",
          properties: { add: { ...event, asCell: ["stream"] } },
          $defs: {
            Author: author,
            Address: address,
            Unused: { type: "number" },
          },
        },
      }));

      expect(listing.verbs).toEqual([{
        name: "add",
        kind: "handler",
        on,
        inputSchema: { ...event, $defs: { Author: author, Address: address } },
      }]);
    });

    it(`serves an inline ${on} verb's event schema with the root's definitions, not the property's own`, async () => {
      // A `$defs` on the verb property, or on a schema below it, is inert
      // under the root's map: `#/$defs/Author` names the root's definition at
      // every depth, and the served event carries that one alone.
      const nested: JSONSchema = {
        type: "object",
        properties: { author: { $ref: "#/$defs/Author" } },
        $defs: { Author: { type: "number" } },
      };
      const event: JSONSchema = {
        type: "object",
        properties: { author: { $ref: "#/$defs/Author" }, nested },
        $defs: { Author: { type: "string" } },
      };
      const listing = await listPattern(compiledPattern({
        [schemaKey]: {
          type: "object",
          properties: {
            add: {
              ...event,
              asCell: ["stream"],
              $defs: { ...event.$defs, Unused: { type: "null" } },
            },
          },
          $defs: { Author: { type: "boolean" } },
        },
      }));

      expect(listing.verbs).toEqual([{
        name: "add",
        kind: "handler",
        on,
        inputSchema: {
          type: "object",
          properties: {
            author: { $ref: "#/$defs/Author" },
            nested: {
              type: "object",
              properties: { author: { $ref: "#/$defs/Author" } },
            },
          },
          $defs: { Author: { type: "boolean" } },
        },
      }]);
    });
  }

  for (const on of ["result", "input"] as const) {
    const schemaKey = on === "result" ? "resultSchema" : "argumentSchema";
    it(`serves an inline ${on} verb's event schema without the property's own definitions under a root declaring none`, async () => {
      // With no map on the root, `#/$defs/Author` names nothing, and the
      // property's own `$defs` is not what it names.
      const listing = await listPattern(compiledPattern({
        [schemaKey]: {
          type: "object",
          properties: {
            add: {
              type: "object",
              properties: { author: { $ref: "#/$defs/Author" } },
              asCell: ["stream"],
              $defs: { Author: { type: "string" } },
            },
          },
        },
      }));

      expect(listing.verbs).toEqual([{
        name: "add",
        kind: "handler",
        on,
        inputSchema: {
          type: "object",
          properties: { author: { $ref: "#/$defs/Author" } },
        },
      }]);
    });
  }

  it("reports a handler's declared result as its outputSchema", async () => {
    // A handler's declared result is not on its property — it rides the
    // module of the node the handler compiled to. The listing finds that node
    // by matching its `$event` input against the result property exposing the
    // same stream, so `publicName` below resolves through its CAUSE and not
    // through its property name: the two deliberately disagree, because a
    // name-keyed lookup would answer every other case in this test correctly.
    const stream = (name: string): JSONSchema => ({
      asCell: ["stream"],
      type: "object",
      title: name,
    });
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        type: "object",
        properties: {
          createNote: stream("createNote"),
          touch: stream("touch"),
          publicName: stream("publicName"),
          shared: stream("shared"),
          noteCount: { type: "number" },
        },
      },
      result: {
        createNote: streamAlias({ stream: "createNote" }, ADD_TOPIC_EVENT),
        touch: streamAlias({ stream: "touch" }),
        publicName: streamAlias({ stream: "internalCause" }),
        shared: streamAlias({ stream: "shared" }),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
      nodes: [
        // The event link carries the schema for the position it is read at;
        // identity is the cause, so a differing schema must not defeat the
        // match.
        handlerNode({ stream: "createNote" }, { result: CREATE_NOTE_RESULT }),
        // Declares nothing: the value-less shape.
        handlerNode({ stream: "touch" }),
        handlerNode({ stream: "internalCause" }, { result: SEARCH_RESULT }),
        // Two handlers on one stream: nothing names a single verb's result,
        // so the row keeps none rather than picking a winner.
        handlerNode({ stream: "shared" }, { result: SEARCH_RESULT }),
        handlerNode({ stream: "shared" }),
        // A compute node over ordinary data — no `$event` at all.
        {
          module: { type: "javascript", resultSchema: { type: "number" } },
          inputs: { list: streamAlias("notes") },
          outputs: streamAlias("noteCount"),
        },
      ],
    }));

    const byName = new Map(listing.verbs.map((verb) => [verb.name, verb]));
    expect(byName.get("createNote")?.outputSchema).toEqual(CREATE_NOTE_RESULT);
    expect(byName.get("publicName")?.outputSchema).toEqual(SEARCH_RESULT);
    expect(byName.get("touch")?.outputSchema).toBeUndefined();
    expect(byName.get("shared")?.outputSchema).toBeUndefined();
    // A declared result is an own property only when there is one: a row with
    // no result must not carry the key at all.
    expect(Object.hasOwn(byName.get("touch")!, "outputSchema")).toBe(false);
    // Data stays out of the listing whatever its node declares.
    expect(byName.has("noteCount")).toBe(false);
  });

  it("lists a handler the declared result type omits, off the handler node that drives it", async () => {
    // A pattern whose result type is its argument schema reused declares its
    // data and none of its verbs, while its result graph wires every one of
    // them. The node's `$event` is the same stream the result property
    // exposes, written twice in the pattern's own terms, and it is the only
    // source of such a verb's name. Its module's event contract stands in for
    // the declared event type nobody wrote.
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        type: "object",
        properties: { noteCount: { type: "number" } },
      },
      result: {
        hiddenVerb: streamAlias({ stream: "hiddenVerb" }),
        bareVerb: streamAlias({ stream: "bareVerb" }),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
      nodes: [
        handlerNode({ stream: "hiddenVerb" }, {
          event: ADD_TOPIC_EVENT,
          result: CREATE_NOTE_RESULT,
        }),
        // A module declaring no schemas at all: the row is unconstrained.
        handlerNode({ stream: "bareVerb" }),
        // Ordinary data: no `$event`, so never a verb.
        {
          module: { type: "javascript", resultSchema: { type: "number" } },
          inputs: { list: streamAlias("notes") },
          outputs: streamAlias("noteCount"),
        },
      ],
    }));

    expect(listing.verbs).toEqual([
      {
        name: "bareVerb",
        kind: "handler",
        on: "result",
        inputSchema: true,
      },
      {
        name: "hiddenVerb",
        kind: "handler",
        on: "result",
        inputSchema: ADD_TOPIC_EVENT,
        outputSchema: CREATE_NOTE_RESULT,
      },
    ]);
    // The pattern WAS read, so the listing claims to be the whole surface.
    expect(listing.incomplete).toBeUndefined();
  });

  it("lists a tool the declared result type omits, off the stored tool itself", async () => {
    // A tool compiles to no node and is marked by no stream, so neither of
    // the handler's sources can propose it; what names it is the tool value
    // `patternTool` wrote into the result, which also carries its schemas.
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        type: "object",
        properties: { noteCount: { type: "number" } },
      },
      result: {
        hiddenTool: toolValue(),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
    }));

    expect(listing.verbs).toEqual([{
      name: "hiddenTool",
      kind: "tool",
      on: "result",
      inputSchema: SEARCH_ARGUMENTS,
      outputSchema: SEARCH_RESULT,
    }]);
  });

  it("reports an empty listing as incomplete when the pattern cannot be read", async () => {
    // `getPattern` rejects on a real piece that carries no pattern identity
    // and on one whose source will not load in this space, and in both the
    // piece still DISPATCHES every verb — resolution never consults the
    // pattern. So the listing keeps answering. What it must not do is answer
    // as though it had looked: an empty listing is indistinguishable from a
    // piece with no verbs unless it says it is a lower bound.
    const listing = await listPattern(compiledPattern({}), {
      getPattern: () =>
        Promise.reject(new Error("could not load pattern sha256:x#default")),
    });

    expect(listing.verbs).toEqual([]);
    expect(listing.incomplete).toBe("pattern-unavailable");
    // The identity is advisory and still rides the listing.
    expect(listing.pattern).toEqual(TEST_PATTERN_REF);
  });

  it("lists a stream the argument type declares on the input cell, behind a result verb of the same name", async () => {
    // `resolvePieceCallable` tries the result cell first and only reaches the
    // input cell `if (!onResultCell)`, so a name both types declare is one
    // row, on the result cell, with the result-side event — the payload the
    // dispatcher actually sends. `setup` is declared by the argument type
    // alone and is reached on the input cell with its own event; `seed` is
    // argument data and no verb.
    const listing = await listPattern(compiledPattern({
      argumentSchema: {
        type: "object",
        properties: {
          notify: { asCell: ["stream"], ...INPUT_SIDE_EVENT },
          setup: {
            asCell: ["stream"],
            description: "Seed the piece.",
            ...INPUT_SIDE_EVENT,
          },
          seed: { type: "number" },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          notify: { asCell: ["stream"], ...RESULT_SIDE_EVENT },
        },
      },
    }));

    expect(listing.verbs).toEqual([
      {
        name: "notify",
        kind: "handler",
        on: "result",
        inputSchema: RESULT_SIDE_EVENT,
      },
      {
        name: "setup",
        kind: "handler",
        on: "input",
        inputSchema: INPUT_SIDE_EVENT,
        description: "Seed the piece.",
      },
    ]);
  });

  it("serves what degenerate declarations allow, and no more", async () => {
    // The schemas a compiled pattern carries are the generator's, and the
    // generator emits booleans and dangling references in the corners: an
    // argument property declared `true`, a definition that is `true`, a
    // reference nothing defines. Each is answered from what is there — a
    // boolean definition still travels with the event that reaches it, an
    // unresolvable event serves `true` rather than a shape the surface
    // invented — and a root that declares no object declares no verb.
    const listing = await listPattern(compiledPattern({
      argumentSchema: {
        type: "object",
        properties: { flag: true, seed: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: {
          ghost: { asCell: ["stream"], $ref: "#/$defs/Missing" },
          open: { asCell: ["stream"], $ref: "#/$defs/OpenEvent" },
        },
        $defs: {
          OpenEvent: {
            type: "object",
            properties: { anything: { $ref: "#/$defs/Any" } },
          },
          Any: true,
        },
      },
    }));
    expect(listing.verbs).toEqual([
      { name: "ghost", kind: "handler", on: "result", inputSchema: true },
      {
        name: "open",
        kind: "handler",
        on: "result",
        inputSchema: {
          type: "object",
          properties: { anything: { $ref: "#/$defs/Any" } },
          $defs: { Any: true },
        },
      },
    ]);

    const scalar = await listPattern(compiledPattern({
      resultSchema: { type: "number" },
      argumentSchema: { $ref: "#/$defs/Gone", $defs: {} },
    }));
    expect(scalar.verbs).toEqual([]);
  });

  it("returns an empty list for a pattern that exposes no callables", async () => {
    const listing = await listPattern(
      compiledPattern({
        resultSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
        result: { title: streamAlias("title", { type: "string" }) },
      }),
      // No getPatternRef on the double: identity degrades to null, honestly.
      { getPatternRef: undefined },
    );

    expect(listing.pattern).toBeNull();
    expect(listing.verbs).toEqual([]);
    expect(listing.incomplete).toBeUndefined();
  });

  it("carries the listing marks off the declared result type", async () => {
    // The generator emits `tier: "wrapper"` (session-scope inference) and
    // `deprecated: true` (@deprecated JSDoc) onto stream properties; the
    // listing surfaces them so the verbs command can hide marked rows by
    // default. `cf piece call` never consults them — everything stays
    // callable, which is why the marks ride the LISTING rather than the
    // dispatcher.
    const listing = await listPattern(compiledPattern({
      resultSchema: {
        type: "object",
        properties: {
          addTopic: { asCell: ["stream"], ...ADD_TOPIC_EVENT },
          submitTopic: { asCell: ["stream"], type: "object", tier: "wrapper" },
          setMyName: { asCell: ["stream"], type: "object", deprecated: true },
        },
      },
    }));
    const byName = new Map(listing.verbs.map((verb) => [verb.name, verb]));
    expect(byName.get("addTopic")?.tier).toBeUndefined();
    expect(byName.get("addTopic")?.deprecated).toBeUndefined();
    expect(byName.get("submitTopic")?.tier).toBe("wrapper");
    expect(byName.get("setMyName")?.deprecated).toBe(true);

    // The default partition: marked rows hide, counted per axis; the shown
    // set keeps its order and the marks stay on the hidden rows.
    const partition = partitionVerbListing(listing.verbs);
    expect(partition.shown.map((verb) => verb.name)).toEqual(["addTopic"]);
    expect(partition.wrapper).toBe(1);
    expect(partition.deprecated).toBe(1);
  });
});

/** A listing as `listPieceCallables` returns one, built by hand so the
 * rendering is exercised over shapes the lister reaches only against a live
 * piece. */
function listingOf(
  verbs: PieceCallablesListing["verbs"],
  extra: Partial<PieceCallablesListing> = {},
): PieceCallablesListing {
  return { pattern: null, verbs, ...extra };
}

/** A pattern ref carrying the two fields `formatPatternIdentity` reads, so
 * the rendered PATTERN line is a real identity rather than `undefined`. */
const IDENTIFIED_PATTERN_REF = {
  identity: "sha256:feed",
  symbol: "default",
  source: { ref: "sha256:feed" },
} as never;

const ADD_TOPIC_ROW: PieceCallablesListing["verbs"][number] = {
  name: "addTopic",
  kind: "handler",
  on: "result",
  inputSchema: ADD_TOPIC_EVENT,
};

describe("cf piece verbs rendering", () => {
  it("prints no incomplete note for a listing that read its pattern", () => {
    const lines = verbListingLines(listingOf([ADD_TOPIC_ROW]), false);

    // The negative, asserted on the whole output rather than on a flag: this
    // is what fails against a renderer that prints the note unconditionally,
    // which an assertion that only looked for the note when it IS expected
    // would pass.
    expect(lines.join("\n")).not.toContain("the pattern could not be read");
    expect(lines.some((line) => line.startsWith("("))).toBe(false);
    // And the rows really did render, so the absence above is not the absence
    // of all output.
    expect(lines.join("\n")).toContain("addTopic");
  });

  it("prints the incomplete note under the rows when the pattern was unreadable", () => {
    const lines = verbListingLines(
      listingOf([ADD_TOPIC_ROW], { incomplete: "pattern-unavailable" }),
      false,
    );

    // Order is the assertion: a caller reads the note against the rows above
    // it, so a note printed before the table would describe nothing.
    expect(lines[lines.length - 1]).toBe(
      "(the pattern could not be read, so no verbs could be listed; a verb the piece stores is still callable by name)",
    );
    expect(lines.slice(0, -1).join("\n")).toContain("addTopic");
  });

  it("prints the incomplete note when no verbs are listed at all", () => {
    // The case the note exists for. Without it `<no callable verbs>` is
    // indistinguishable from a piece that genuinely has none — the failure
    // this whole change is about, at the surface a person actually reads.
    const lines = verbListingLines(
      listingOf([], { incomplete: "pattern-unavailable" }),
      false,
    );

    expect(lines).toEqual([
      "<no callable verbs>",
      "(the pattern could not be read, so no verbs could be listed; a verb the piece stores is still callable by name)",
    ]);
  });

  it("keeps the hidden-verb note and the incomplete note apart", () => {
    // Both ways a listing can be short, at once. The hidden count rides the
    // placeholder because it explains why the placeholder says "shown"; the
    // incomplete note is its own line because `--all` cannot recover what it
    // reports. Fails against a renderer that concatenates them, or that drops
    // either when the other is present.
    const lines = verbListingLines(
      listingOf([{ ...ADD_TOPIC_ROW, tier: "wrapper" }], {
        incomplete: "pattern-unavailable",
      }),
      false,
    );

    expect(lines).toEqual([
      "<no callable verbs shown> (1 wrapper, 0 deprecated hidden; --all lists them)",
      "(the pattern could not be read, so no verbs could be listed; a verb the piece stores is still callable by name)",
    ]);
  });

  it("prints each row's description beneath its grid line", () => {
    const lines = verbListingLines(
      listingOf([
        {
          ...ADD_TOPIC_ROW,
          description: "File a new topic.\nAppend-only; nothing rewrites one.",
        },
        { name: "clear", kind: "handler", on: "result", inputSchema: true },
      ]),
      false,
    );

    // The grid stays one line per row; the prose rides beneath its own row
    // and nowhere else — a row without a description stays bare.
    const addTopicAt = lines.findIndex((line) => line.startsWith("addTopic"));
    expect(lines[addTopicAt + 1]).toBe("    File a new topic.");
    expect(lines[addTopicAt + 2]).toBe(
      "    Append-only; nothing rewrites one.",
    );
    const clearAt = lines.findIndex((line) => line.startsWith("clear"));
    expect(clearAt).toBe(addTopicAt + 3);
    expect(lines[clearAt + 1]).toBeUndefined();
  });

  it("shows a wrapper row under --all, with no hidden note and the pattern line", () => {
    const lines = verbListingLines(
      listingOf([{ ...ADD_TOPIC_ROW, tier: "wrapper" }], {
        pattern: IDENTIFIED_PATTERN_REF,
      }),
      true,
    );

    // `--all` recovers the hidden row, so its note must go; the pattern
    // identity heads the view whenever the listing carries one.
    expect(lines[0]).toBe("PATTERN cf:module/sha256:feed#default");
    expect(lines.join("\n")).toContain("addTopic");
    expect(lines.join("\n")).toContain("wrapper");
    expect(lines.some((line) => line.startsWith("(1 wrapper"))).toBe(false);
  });

  it("carries incomplete into the --json payload and omits it otherwise", () => {
    // A machine reader has no listing text to read the bound off, so the flag
    // must survive into JSON — and must be absent, not false, when the
    // listing is whole.
    const degraded = verbListingJson(
      listingOf([ADD_TOPIC_ROW], { incomplete: "pattern-unavailable" }),
      false,
    );
    expect(degraded.incomplete).toBe("pattern-unavailable");
    expect(degraded.verbs).toEqual([ADD_TOPIC_ROW]);

    const whole = verbListingJson(listingOf([ADD_TOPIC_ROW]), false);
    expect(Object.hasOwn(whole, "incomplete")).toBe(false);

    // The hidden counts keep their own shape beside it.
    const hidden = verbListingJson(
      listingOf([{ ...ADD_TOPIC_ROW, deprecated: true }]),
      false,
    );
    expect(hidden.hidden).toEqual({ wrapper: 0, deprecated: 1 });
    expect(hidden.verbs).toEqual([]);
  });
});
