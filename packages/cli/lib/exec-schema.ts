import type { JSONSchema } from "@commonfabric/api";
import { toCompactDebugString } from "@commonfabric/data-model";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
  schemaToTypeString,
} from "@commonfabric/runner";
import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";
import { cliCommand } from "./cli-name.ts";
// A value import back to callable.ts, whose own import of this module is
// type-only and therefore erased — so this creates no runtime cycle.
import {
  declaredEventFields,
  eventSchemaJudgesRootFields,
  requiredEventFieldsOwed,
  verbRunsWithoutPayload,
} from "./callable.ts";
import { EVENT_ROOT_POSITION, nearestName } from "./refusal.ts";
import { shellQuote } from "./shell-quote.ts";
import {
  firstReadOption,
  projectionInSectionRefusal,
  READ_OPTION_NAMES,
  type SpendsNextWord,
  VERB_KEYWORDS,
} from "./verb-section.ts";

export interface ExecCommandSpec {
  callableKind: "handler" | "tool";
  defaultVerb: "invoke" | "run";
  inputSchema: JSONSchema;
  outputSchemaSummary?: JSONSchema;

  /**
   * What this callable is FOR, in the author's own words: the doc comment on
   * the pattern property that declares it.
   *
   * Absent where the author wrote none, which is why it is optional rather
   * than defaulted — a page with no summary line says nothing, while one
   * carrying a restated property name says something false about where it came
   * from. It describes the callable and not its input, so it does not ride
   * `inputSchema`, whose own `description` would be a claim about the event
   * object a caller sends.
   */
  description?: string;
}

export interface ParsedExecArgs {
  verb: "invoke" | "run";
  input: unknown;
  showHelp: boolean;
  showHelpJson: boolean;
  readJsonFromStdin: boolean;
  readTextFromStdin: boolean;
  inputFile?: {
    format: "json" | "text";
    path: string;
  };
  usedJsonInput: boolean;
}

export interface RenderExecHelpOptions {
  commandPrefix?: string;
  invocationStyle?: "cf" | "direct";
}

export interface ExecInputResolverDeps {
  readJsonInput?: () => Promise<unknown>;
  readTextInput?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  isStdinTerminal?: () => boolean;
}

export interface ResolvedExecInvocation {
  parsed: ParsedExecArgs;
  input?: unknown;
}

interface FlagDescriptor {
  key: string;
  flagName: string;
  schema: JSONSchema;
}

interface ParsedInputMode {
  input: unknown;
  readJsonFromStdin: boolean;
  readTextFromStdin: boolean;
  inputFile?: {
    format: "json" | "text";
    path: string;
  };
  usedJsonInput: boolean;
}

function isSchemaObject(schema: JSONSchema): schema is ReadonlyRecord {
  return isObjectNotArray(schema);
}

/**
 * The fields a verb declares, as every flag-facing surface reads them.
 *
 * Delegates to `declaredEventFields`, which merges what a conjunction's
 * members contribute and follows a `$ref` into the definition that carries
 * them. Reading `schema.properties` alone — which this did — made an
 * `allOf`-declared field invisible here while the payload door judged it: the
 * help page omitted it, `required` did not enforce it, and a flag naming it
 * was refused as undeclared. One reader is what keeps the two doors from
 * disagreeing about what a verb declares.
 *
 * `null` still means "not a position with fields", which is the signal the
 * single-value paths key off.
 */
function objectProperties(
  schema: JSONSchema,
): Record<string, JSONSchema> | null {
  return declaredEventFields(schema)?.properties ?? null;
}

function schemaType(schema: JSONSchema): string | undefined {
  return isSchemaObject(schema) ? schema.type as string | undefined : undefined;
}

function flagNameForKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function displayCommandPath(path: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(path) ? path : shellQuote(path);
}

function parseBoolean(value: string, flagName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid value for ${flagName}: expected true or false`);
}

function parseJson(value: string, flagName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON for ${flagName}`);
  }
}

function parseInlineOrStdinJson(
  args: string[],
  index: number,
): { inlineValue?: string; consumeNext: boolean; fromStdin?: boolean } {
  const candidate = args[index + 1];
  if (candidate === undefined) {
    return { consumeNext: false };
  }
  if (candidate.startsWith("--")) {
    throw new Error("--json cannot be combined with generated flags");
  }
  if (candidate === "-") {
    // stdin sentinel, same as --json-file -
    return { consumeNext: true, fromStdin: true };
  }
  return { inlineValue: candidate, consumeNext: true };
}

function parseFilePathArg(
  args: string[],
  index: number,
  flagName: string,
): string {
  const candidate = args[index + 1];
  if (candidate === undefined || candidate.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return candidate;
}

function validateEnum(
  value: unknown,
  schema: JSONSchema,
  flagName: string,
): void {
  if (!isSchemaObject(schema) || !Array.isArray(schema.enum)) return;
  if (!schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`Invalid value for ${flagName}`);
  }
}

function parseValueForSchema(
  rawValue: string,
  schema: JSONSchema,
  flagName: string,
): unknown {
  const type = schemaType(schema);

  if (type === "boolean") {
    const value = parseBoolean(rawValue, flagName);
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "number" || type === "integer") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid value for ${flagName}: expected ${type}`);
    }
    if (type === "integer" && !Number.isInteger(value)) {
      throw new Error(`Invalid value for ${flagName}: expected integer`);
    }
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "array" || type === "object") {
    const value = parseJson(rawValue, flagName);
    if (type === "array" && !Array.isArray(value)) {
      throw new Error(`Invalid value for ${flagName}: expected array JSON`);
    }
    if (
      type === "object" &&
      !isObjectNotArray(value)
    ) {
      throw new Error(`Invalid value for ${flagName}: expected object JSON`);
    }
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "null") {
    const value = parseJson(rawValue, flagName);
    if (value !== null) {
      throw new Error(`Invalid value for ${flagName}: expected null`);
    }
    return value;
  }

  validateEnum(rawValue, schema, flagName);
  return rawValue;
}

/**
 * The flags a verb taking a single non-object value accepts. Fixed rather
 * than schema-derived, because such a verb declares no fields for a flag to
 * name — the value is the whole payload.
 */
const SCALAR_INPUT_FLAGS = [
  "value",
  "value-file",
  "json",
  "json-file",
] as const;

/**
 * Which words of a single-value verb's section are values.
 *
 * Three of the four flags above take whatever word stands next: the value IS
 * the payload, and a payload or a path beginning with dashes is still a
 * payload or a path. `--json` alone declines one, because bare it reads stdin
 * and a flag-shaped word after it is refused rather than taken.
 *
 * That is where this and {@link sectionValueSpend} part company, and the
 * parsers are what part: `--json-file` refuses a flag-shaped path at the field
 * door and accepts one here. An oracle that reported the same rule at both
 * doors would print a corrected line one of the two parsers rejects.
 */
const SCALAR_VALUE_SPEND: SpendsNextWord = (flag, next) =>
  flag !== "json" || !next.startsWith("--");

/**
 * `--help` was given an argument by a verb that declares no `help` field.
 *
 * Written once and used at both arrival points, which parse their arguments
 * separately: two copies of one sentence drift, and this one is long enough
 * that a drift would not be obvious in a diff.
 *
 * `--help` is not unknown — alone it prints the help page. It takes an
 * argument only where the verb declares a `help` field for it to fill.
 */
const HELP_TAKES_NO_ARGUMENTS =
  "--help takes no arguments — it prints the help page, and this verb " +
  "declares no help field for it to fill";

/**
 * The refusal a flag naming no declared field earns.
 *
 * The same five elements `undeclaredVerbFieldError` gives the payload door:
 * the name, the position, the refusal, a near miss, and the accepted
 * vocabulary. A caller who types `--titel` and a caller who sends
 * `{"titel": …}` have made one mistake, and the flag spelling is the one the
 * verb-session walkthrough teaches — so it is the spelling most likely to be
 * mistyped and was the one answering with the least.
 *
 * Two honest differences from the payload door, both forced:
 *
 * - The position is always `<event>`, because a flag can only name a root
 *   field. A payload can nest, so its refusal has a path to report.
 * - Names are written as flags, because that is what the caller typed and
 *   what they must retype. `flagNameForKey` is what maps a declared field to
 *   it, so the vocabulary here is the same event schema the payload door
 *   validates against, spelled for this door.
 *
 * Declaration order, not sorted: it is the order the help page lists the
 * flags in and the order the payload door names them in, so a caller reading
 * two of the three sees one vocabulary rather than two arrangements of it.
 */
function undeclaredFlagError(
  rawFlag: string,
  descriptors: Map<string, FlagDescriptor>,
): string {
  const declared = [...descriptors.keys()];
  const opening = `"--${rawFlag}" at ${EVENT_ROOT_POSITION} is not a field ` +
    "this verb declares. ";

  // A caller who wrote `--no-something` is asking to negate, and only a
  // boolean can be negated. Both halves of the answer narrow accordingly:
  // the near miss is searched against the negatable names, and the
  // vocabulary lists those rather than every field. Offering `--no-title`
  // for a string `title` would name a spelling that fails just as surely.
  //
  // The prefix is stripped before matching because it is three edits of pure
  // noise against the declared name, and the threshold scales with the
  // misspelling's length — so leaving it on makes the match HARDER precisely
  // because the caller typed more.
  if (rawFlag.startsWith("no-")) {
    const negatable = declared.filter((name) =>
      schemaType(descriptors.get(name)!.schema) === "boolean"
    );
    const nearest = nearestName(rawFlag.slice(3), negatable);
    return opening +
      (nearest === undefined ? "" : `Did you mean "--no-${nearest}"? `) +
      (negatable.length === 0
        ? "Only a boolean field can be negated, and this verb declares none"
        : `Only a boolean field can be negated, and this verb declares ${
          negatable.map((name) => `"--${name}"`).join(", ")
        }`);
  }

  const nearest = nearestName(rawFlag, declared);
  return opening +
    (nearest === undefined ? "" : `Did you mean "--${nearest}"? `) +
    (declared.length === 0
      ? `${EVENT_ROOT_POSITION} declares no fields at all`
      : `${EVENT_ROOT_POSITION} takes ${
        declared.map((name) => `"--${name}"`).join(", ")
      }`);
}

/**
 * Which words of this verb's section are values rather than flags.
 *
 * The same answer the loop below acts on, in the form the refusals need it:
 * they are handed a section to re-render and have to divide it exactly as the
 * verb's own parser did, or they move a word the verb had already spent.
 */
function sectionValueSpend(
  descriptors: ReadonlyMap<string, FlagDescriptor>,
): SpendsNextWord {
  return (flag, next) => {
    // Both refuse a flag-shaped word outright rather than taking it as the
    // payload, so one never stands as their value.
    if (flag === "json" || flag === "json-file") return !next.startsWith("--");
    // A negation carries its own answer, and so does a boolean field.
    if (!descriptors.has(flag) && flag.startsWith("no-")) {
      return !descriptors.has(flag.slice(3));
    }
    const descriptor = descriptors.get(flag);
    if (descriptor) return schemaType(descriptor.schema) !== "boolean";
    // An undeclared name against a schema that judges nothing is taken as the
    // string the caller typed, which is the word after it.
    return true;
  };
}

function parseObjectInput(
  schema: JSONSchema,
  args: string[],
  sectionPrefix: string,
): ParsedInputMode {
  const properties = objectProperties(schema) ?? {};
  const descriptors = new Map<string, FlagDescriptor>();
  for (const [key, propertySchema] of Object.entries(properties)) {
    const flagName = flagNameForKey(key);
    descriptors.set(flagName, { key, flagName, schema: propertySchema });
  }

  const input: Record<string, unknown> = {};
  let directJsonInput: unknown;
  let usedJson = false;
  let usedGeneratedFlags = false;
  let readJsonFromStdin = false;
  let inputFile: ParsedInputMode["inputFile"];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}`);
    }

    if (token === "--json") {
      if (usedGeneratedFlags) {
        throw new Error("--json cannot be combined with generated flags");
      }
      if (usedJson) {
        throw new Error("--json can only be provided once");
      }
      const { inlineValue, consumeNext, fromStdin } = parseInlineOrStdinJson(
        args,
        i,
      );
      usedJson = true;
      if (fromStdin) {
        readJsonFromStdin = true;
        i++;
        continue;
      }
      if (inlineValue === undefined) {
        readJsonFromStdin = true;
        continue;
      }
      directJsonInput = parseJson(inlineValue, "--json");
      if (consumeNext) {
        i++;
      }
      continue;
    }

    if (token === "--json-file") {
      if (usedGeneratedFlags) {
        throw new Error("--json-file cannot be combined with generated flags");
      }
      if (usedJson) {
        throw new Error("--json can only be provided once");
      }
      usedJson = true;
      const filePath = parseFilePathArg(args, i, "--json-file");
      if (filePath === "-") {
        readJsonFromStdin = true;
      } else {
        inputFile = { format: "json", path: filePath };
      }
      i++;
      continue;
    }

    if (usedJson) {
      throw new Error("--json cannot be combined with generated flags");
    }

    const inlineSplit = token.slice(2).split("=", 2);
    const rawFlag = inlineSplit[0];
    const inlineValue = inlineSplit.length === 2 ? inlineSplit[1] : undefined;

    let negated = false;
    let descriptor = descriptors.get(rawFlag);
    if (!descriptor && rawFlag.startsWith("no-")) {
      descriptor = descriptors.get(rawFlag.slice(3));
      negated = descriptor !== undefined;
    }
    if (!descriptor) {
      // A read option that names no field of this verb is a projection
      // written inside the callable's section. It is answered before the
      // schema is consulted at all, because the two vocabularies are
      // independent: a schema that judges nothing would otherwise absorb the
      // word as a field and run the handler with input the caller never
      // meant, which is the silent reinterpretation the boundary exists to
      // stop. A verb that DOES declare the field never reaches here.
      if (READ_OPTION_NAMES.includes(rawFlag)) {
        throw new Error(
          projectionInSectionRefusal(
            rawFlag,
            sectionPrefix,
            args,
            new Set(descriptors.keys()),
            sectionValueSpend(descriptors),
          ),
        );
      }
      // The question is whether the SCHEMA judges its fields, not whether
      // this particular name is declared. Asking the second lets a declared
      // field typed in its schema spelling — `--fooBar` where the flag is
      // `--foo-bar` — read as undeclared-against-an-open-schema and be
      // accepted as a silent alias, when what the caller needs is the near
      // miss naming the spelling that works.
      if (eventSchemaJudgesRootFields(schema)) {
        throw new Error(undeclaredFlagError(rawFlag, descriptors));
      }
      // A schema judging nothing says nothing about the value either, so the
      // flag is taken as the string the caller typed: there is no declared
      // type to read it as, and inventing one would be this door deciding
      // something the schema deliberately left open.
      descriptor = { key: rawFlag, flagName: rawFlag, schema: true };
    }

    const flagName = `--${descriptor.flagName}`;
    const type = schemaType(descriptor.schema);
    if (negated) {
      if (type !== "boolean") {
        // The field exists, so naming the vocabulary would send the caller
        // looking for a name they already found. What is wrong is the
        // negation, and only its own field can say so.
        throw new Error(
          `"--${rawFlag}" negates "${flagName}", which is not a boolean field`,
        );
      }
      input[descriptor.key] = false;
      usedGeneratedFlags = true;
      continue;
    }

    if (type === "boolean") {
      if (inlineValue !== undefined) {
        input[descriptor.key] = parseBoolean(inlineValue, flagName);
      } else {
        input[descriptor.key] = true;
      }
      usedGeneratedFlags = true;
      continue;
    }

    const rawValue = inlineValue ?? args[i + 1];
    if (rawValue === undefined) {
      throw new Error(`Missing value for ${flagName}`);
    }
    input[descriptor.key] = parseValueForSchema(
      rawValue,
      descriptor.schema,
      flagName,
    );
    usedGeneratedFlags = true;
    if (inlineValue === undefined) {
      i++;
    }
  }

  if (readJsonFromStdin) {
    return {
      input: undefined,
      readJsonFromStdin: true,
      readTextFromStdin: false,
      usedJsonInput: true,
    };
  }

  if (inputFile) {
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      inputFile,
      usedJsonInput: true,
    };
  }

  // Only enforce required fields for schema-derived flags.
  // JSON input validation is deferred to the runner.
  //
  // What is enforced is what the caller is OWED to supply, not what the
  // schema marks required: a field carrying a default is answered by the
  // pattern, and demanding it here refuses a call the runtime would have
  // filled in and dispatched.
  if (!usedJson) {
    for (const key of requiredEventFieldsOwed(schema)) {
      if (!(key in input)) {
        throw new Error(`Missing required flag --${flagNameForKey(key)}`);
      }
    }
  }

  return {
    input: usedJson ? directJsonInput : input,
    readJsonFromStdin: false,
    readTextFromStdin: false,
    usedJsonInput: usedJson,
  };
}

function parseNonObjectInput(
  schema: JSONSchema,
  args: string[],
  sectionPrefix: string,
): ParsedInputMode {
  // The boundary the field door draws, on a verb with no fields for a read
  // option to collide with. Such a verb declares nothing, so every read option
  // written here as a FLAG is a projection inside the callable's section —
  // answered with the position it belongs to and the line that puts it there,
  // the same as at the field door. The vocabulary refusal below would
  // otherwise name the four value flags, which is a true sentence about the
  // wrong subject.
  //
  // Written as a value it is the payload, and this verb's payload is one whole
  // word the caller chose: `--value --select` asks for the string "--select",
  // which is not a projection and not this door's to touch.
  const projection = firstReadOption(args, SCALAR_VALUE_SPEND);
  if (projection !== undefined) {
    throw new Error(
      projectionInSectionRefusal(
        projection,
        sectionPrefix,
        args,
        new Set(),
        SCALAR_VALUE_SPEND,
      ),
    );
  }

  if (args.length === 0) {
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      usedJsonInput: false,
    };
  }
  if (args.length > 2) {
    throw new Error(`Unexpected argument ${args[2]}`);
  }

  const [flag, rawValue] = args;
  if (
    flag !== "--value" && flag !== "--json" && flag !== "--value-file" &&
    flag !== "--json-file"
  ) {
    // A verb taking a single non-object value has no fields, so its
    // vocabulary is this fixed four rather than anything schema-derived, and
    // there is no position to name — the value IS the payload. The near miss
    // is owed all the same: a fixed vocabulary is still a vocabulary, and
    // `--valu` is the same slip here as `--titel` is at the field door.
    const nearest = nearestName(flag.replace(/^--/, ""), SCALAR_INPUT_FLAGS);
    throw new Error(
      `"${flag}" is not a flag this verb takes. ` +
        (nearest === undefined ? "" : `Did you mean "--${nearest}"? `) +
        "This verb takes a single value, so its flags are " +
        SCALAR_INPUT_FLAGS.map((name) => `"--${name}"`).join(", "),
    );
  }
  if (flag === "--json" && rawValue === undefined) {
    return {
      input: undefined,
      readJsonFromStdin: true,
      readTextFromStdin: false,
      usedJsonInput: true,
    };
  }
  if (rawValue === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (flag === "--json-file") {
    if (rawValue === "-") {
      return {
        input: undefined,
        readJsonFromStdin: true,
        readTextFromStdin: false,
        usedJsonInput: true,
      };
    }
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      inputFile: { format: "json", path: rawValue },
      usedJsonInput: true,
    };
  }
  if (flag === "--value-file") {
    if (rawValue === "-") {
      return {
        input: undefined,
        readJsonFromStdin: false,
        readTextFromStdin: true,
        usedJsonInput: false,
      };
    }
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      inputFile: { format: "text", path: rawValue },
      usedJsonInput: false,
    };
  }
  if (flag === "--json") {
    if (rawValue.startsWith("--")) {
      throw new Error("--json cannot be combined with generated flags");
    }
    if (rawValue === "-") {
      // stdin sentinel, same as --json-file -
      return {
        input: undefined,
        readJsonFromStdin: true,
        readTextFromStdin: false,
        usedJsonInput: true,
      };
    }
    return {
      input: parseJson(rawValue, flag),
      readJsonFromStdin: false,
      readTextFromStdin: false,
      usedJsonInput: true,
    };
  }
  return {
    input: parseValueForSchema(rawValue, schema, flag),
    readJsonFromStdin: false,
    readTextFromStdin: false,
    usedJsonInput: false,
  };
}

function hasHelpField(schema: JSONSchema): boolean {
  const properties = objectProperties(schema);
  return properties ? "help" in properties : false;
}

function isSchemaLessHandlerInput(linkSchema: JSONSchema): boolean {
  if (linkSchema === true) {
    return true;
  }
  if (!isSchemaObject(linkSchema)) {
    return false;
  }
  // A link's schema can be a content-addressed reference, with the stream
  // declaration and the event's own type on the document it names and nothing
  // but the reference at the root. Every check below reads that document, so
  // a referenced `{ asCell: ["stream"], type: "string" }` is judged as the
  // single-value verb it is rather than by its bare-looking wrapper.
  const schema = resolveExternalRootRefForStructure(linkSchema);
  if (schema.type !== undefined || schema.properties !== undefined) {
    return false;
  }
  // A `$ref` beside the stream marker describes the event — in the definition
  // rather than at the root, which is where a pattern routinely puts it. The
  // root looks bare either way, so reading it alone called such a verb
  // schema-less and rendered its page as `void`: no input type, no flags, and
  // no sign that the fields the parser accepts exist at all.
  //
  // What settles it is where the ref LANDS, not that one is written. A ref
  // reaching a fields position describes an event, and only that answers
  // here. Every other ref — to a scalar, to a position naming nothing, or one
  // that does not resolve — carries no fields to derive and is left to the
  // marker check below, which is the classification it had before any ref was
  // followed. Answering for those directly would take the marker out of the
  // question: a `$ref` to a scalar with no stream marker is a single-value
  // verb, and calling it schema-less costs it both `--value` and its input
  // type on the page.
  if (typeof schema.$ref === "string" && objectProperties(schema) !== null) {
    return false;
  }
  return ContextualFlowControl.declaresStream(schema);
}

export function normalizeCallableInputForExecution(
  spec: ExecCommandSpec,
  input: unknown,
): unknown {
  if (spec.callableKind !== "tool") {
    return input;
  }
  if (!isObjectNotArray(input)) {
    return input;
  }

  const properties = objectProperties(spec.inputSchema);
  const helpSchema = properties?.help;
  if (!helpSchema || schemaType(helpSchema) !== "string") {
    return input;
  }
  if ("help" in (input as Record<string, unknown>)) {
    return input;
  }

  return {
    ...(input as Record<string, unknown>),
    help: "",
  };
}

async function defaultReadTextInput(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

async function defaultReadTextFile(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

function parseJsonText(text: string, source: string): unknown {
  if (text.trim().length === 0) {
    throw new Error(`Expected JSON from ${source}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${source}`);
  }
}

export async function resolveParsedExecInput(
  spec: ExecCommandSpec,
  parsed: ParsedExecArgs,
  deps: ExecInputResolverDeps = {},
): Promise<unknown> {
  if (parsed.readJsonFromStdin) {
    if (deps.readJsonInput) {
      return await deps.readJsonInput();
    }
    const text = await (deps.readTextInput ?? defaultReadTextInput)();
    return parseJsonText(text, "stdin for --json");
  }

  if (parsed.readTextFromStdin) {
    const text = await (deps.readTextInput ?? defaultReadTextInput)();
    return parseValueForSchema(text, spec.inputSchema, "--value-file");
  }

  if (parsed.inputFile) {
    const text = await (deps.readTextFile ?? defaultReadTextFile)(
      parsed.inputFile.path,
    );
    if (parsed.inputFile.format === "json") {
      return parseJsonText(
        text,
        `${parsed.inputFile.path} for --json-file`,
      );
    }
    return parseValueForSchema(text, spec.inputSchema, "--value-file");
  }

  return parsed.input;
}

async function resolveImplicitPipedHandlerInput(
  spec: ExecCommandSpec,
  rawArgs: string[],
  deps: ExecInputResolverDeps = {},
): Promise<ResolvedExecInvocation | null> {
  if (spec.callableKind !== "handler" || rawArgs.length > 0) {
    return null;
  }

  // A schema-less input declares no payload, so no piped input exists to
  // infer: return before consulting stdin at all. Reading it would hold the
  // advertised bare spelling open until a non-terminal stdin reaches EOF —
  // a hang whenever the pipe outlives the call.
  if (isSchemaLessHandlerInput(spec.inputSchema)) {
    return null;
  }

  const isTerminal = deps.isStdinTerminal?.() ?? Deno.stdin.isTerminal();
  if (isTerminal) {
    return null;
  }

  const text = await (deps.readTextInput ?? defaultReadTextInput)();
  if (text.length === 0) {
    return null;
  }

  const properties = objectProperties(spec.inputSchema);
  const input = properties
    ? parseJsonText(text, "stdin")
    : parseValueForSchema(text, spec.inputSchema, "--value-file");

  return {
    parsed: {
      verb: spec.defaultVerb,
      input,
      showHelp: false,
      showHelpJson: false,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      usedJsonInput: properties !== null,
    },
    input,
  };
}

export async function resolveExecInvocation(
  spec: ExecCommandSpec,
  rawArgs: string[],
  deps: ExecInputResolverDeps = {},
  sectionPrefix?: string,
): Promise<ResolvedExecInvocation> {
  const implicit = await resolveImplicitPipedHandlerInput(spec, rawArgs, deps);
  if (implicit) {
    return implicit;
  }

  const parsed = parseExecArgs(spec, rawArgs, sectionPrefix);
  if (parsed.showHelp) {
    return { parsed };
  }

  return {
    parsed,
    input: await resolveParsedExecInput(spec, parsed, deps),
  };
}

function schemaDescription(schema: JSONSchema): string | undefined {
  return isSchemaObject(schema) && typeof schema.description === "string"
    ? schema.description
    : undefined;
}

function schemaEnumSummary(schema: JSONSchema): string | undefined {
  if (!isSchemaObject(schema) || !Array.isArray(schema.enum)) return undefined;
  return (schema.enum as unknown[]).map((value) => toCompactDebugString(value))
    .join(" | ");
}

function schemaDefaultSummary(schema: JSONSchema): string | undefined {
  if (!isSchemaObject(schema) || !("default" in schema)) return undefined;
  return toCompactDebugString(schema.default);
}

function valuePlaceholder(schema: JSONSchema): string {
  const type = schemaType(schema);
  switch (type) {
    case "boolean":
      return "<boolean>";
    case "integer":
      return "<integer>";
    case "number":
      return "<number>";
    case "string":
      return "<string>";
    case "object":
      return "<json-object>";
    case "array":
      return "<json-array>";
    case "null":
      return "<null>";
    default:
      return "<json>";
  }
}

function primaryFlagUsage(flagName: string, schema: JSONSchema): string {
  const type = schemaType(schema);
  if (type === "boolean") {
    return `--${flagName}`;
  }
  return `--${flagName} ${valuePlaceholder(schema)}`;
}

function fullFlagUsage(flagName: string, schema: JSONSchema): string {
  const type = schemaType(schema);
  if (flagName === "help" && type === "boolean") {
    return "--help=<boolean> | --no-help";
  }
  if (type === "boolean") {
    return `--${flagName} | --no-${flagName}`;
  }
  return primaryFlagUsage(flagName, schema);
}

/** One flag the schema-derived parser accepts for a verb's declared input. */
export interface DeclaredVerbFlag {
  /** The flag's long name, without dashes — `flagNameForKey`'s mapping. */
  readonly name: string;

  /** The declared field it fills; absent for a non-object input's own flags. */
  readonly key?: string;

  /** That field's schema, for a caller rendering a placeholder or a type. */
  readonly schema?: JSONSchema;

  /** Whether the payload door owes this field. */
  readonly required: boolean;

  /** Whether `--no-<name>` is accepted beside it. */
  readonly negatable: boolean;
}

/**
 * Every flag the schema-derived parser accepts for `inputSchema`, in
 * declaration order — the order the help page lists them and the order the
 * payload door names them in.
 *
 * The generic flags (`--json`, `--help`, and their `-file` forms) are not
 * here: they are the same for every verb and belong to the command rather than
 * to what the verb declared.
 *
 * The vocabulary rather than a rendering of it, so that a second surface
 * naming these flags — shell completion is one — reads the same enumeration
 * the help page does. Two readers of one schema is how a flag comes to be
 * accepted by the parser and named by neither, or the reverse.
 */
export function declaredVerbFlags(inputSchema: JSONSchema): DeclaredVerbFlag[] {
  // A schema-less input declares no fields, but the parser still takes the
  // value flags for it and the usage lines still advertise them — so they are
  // reported here, which is what keeps the parser, the help page's flag list
  // and completion naming one vocabulary.
  const properties = objectProperties(inputSchema);
  if (!properties) {
    // A non-object input is written whole, so its flags name the value rather
    // than any field of one.
    return [
      {
        name: "value",
        schema: inputSchema,
        // A declared non-object input owes a value; a schema-less one does
        // not, because invoking it with no input at all is legal.
        required: !isSchemaLessHandlerInput(inputSchema),
        negatable: false,
      },
      { name: "value-file", required: false, negatable: false },
    ];
  }

  const required = requiredEventFieldsOwed(inputSchema);
  return Object.entries(properties).map(([key, propertySchema]) => ({
    name: flagNameForKey(key),
    key,
    schema: propertySchema,
    required: required.has(key),
    negatable: schemaType(propertySchema) === "boolean",
  }));
}

function specificFlagLines(schema: JSONSchema): string[] {
  const flags = declaredVerbFlags(schema);
  if (flags.length === 0) return [];

  // A non-object input is written whole, so its two flags name the value
  // rather than any field, and their padding is fixed rather than fitted.
  if (flags[0].key === undefined) {
    return [
      `  ${`--value ${valuePlaceholder(schema)}`.padEnd(20)}  ${
        flags[0].required ? "Required." : "Optional."
      }`,
      `  ${
        "--value-file <path>".padEnd(20)
      }  Read the value from a UTF-8 file. Use - for stdin.`,
    ];
  }

  const descriptors = flags.map((flag) => {
    const key = flag.key!;
    const propertySchema = flag.schema!;
    const parts: string[] = [];
    if (key === "help") {
      parts.push('Optional input field named "help".');
    } else {
      parts.push(flag.required ? "Required." : "Optional.");
    }
    if (key === "help" && flag.negatable) {
      parts.push("Boolean. Use --help=true or --no-help.");
    } else if (flag.negatable) {
      parts.push(
        `Boolean. Use --${flag.name} for true or --no-${flag.name} for false.`,
      );
    }
    const enumSummary = schemaEnumSummary(propertySchema);
    if (enumSummary) {
      parts.push(`Allowed: ${enumSummary}.`);
    }
    const defaultSummary = schemaDefaultSummary(propertySchema);
    if (defaultSummary !== undefined) {
      parts.push(`Default: ${defaultSummary}.`);
    }
    const description = schemaDescription(propertySchema);
    if (description) {
      parts.push(description);
    }
    return {
      usage: fullFlagUsage(flag.name, propertySchema),
      detail: parts.join(" "),
    };
  });

  const maxUsage = descriptors.reduce(
    (width, descriptor) => Math.max(width, descriptor.usage.length),
    0,
  );

  return descriptors.map((descriptor) =>
    `  ${descriptor.usage.padEnd(maxUsage)}  ${descriptor.detail}`
  );
}

function genericFlagLines(schema: JSONSchema): string[] {
  const jsonLabel = "--json";
  const jsonDescription = objectProperties(schema)
    ? "Read the full input object from stdin. Cannot be combined with other input flags."
    : "Read the full input value as JSON from stdin. Cannot be combined with other input flags.";
  const descriptors = [
    { usage: jsonLabel, detail: jsonDescription },
    {
      usage: "--json-file <path>",
      detail: objectProperties(schema)
        ? "Read the full input object from a JSON file. Use - for stdin."
        : "Read the full input value as JSON from a file. Use - for stdin.",
    },
    { usage: "--help", detail: "Show this help." },
    { usage: "--help --json", detail: "Show full schema details as JSON." },
  ];
  const maxUsage = descriptors.reduce(
    (width, descriptor) => Math.max(width, descriptor.usage.length),
    0,
  );

  return descriptors.map((descriptor) =>
    `  ${descriptor.usage.padEnd(maxUsage)}  ${descriptor.detail}`
  );
}

/** One line per output property — `name <placeholder>`, then the author's own
 * doc comment where the declared result carries one. The description is a
 * ref-site sibling on the property itself, so no resolution is needed to read
 * it: this is the same sentence `--help --json` serves beside the field.
 * Aligned the way the flag lines are, and a multi-line comment continues
 * indented under its own first line. */
function outputPropertyEntries(
  properties: Record<string, JSONSchema>,
): string[] {
  const descriptors = Object.entries(properties).map(([key, schema]) => ({
    usage: `${key} ${valuePlaceholder(schema)}`,
    description: schemaDescription(schema),
  }));
  const maxUsage = descriptors.reduce(
    (width, descriptor) => Math.max(width, descriptor.usage.length),
    0,
  );
  const lines: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.description === undefined) {
      lines.push(`    ${descriptor.usage}`);
      continue;
    }
    const [first, ...rest] = descriptor.description.split("\n");
    lines.push(`    ${descriptor.usage.padEnd(maxUsage)}  ${first}`);
    for (const line of rest) {
      lines.push(`    ${" ".repeat(maxUsage)}  ${line}`);
    }
  }
  return lines;
}

function outputPropertyLines(schema: JSONSchema): string[] {
  const properties = objectProperties(schema);
  if (!properties || Object.keys(properties).length === 0) {
    return ["  JSON on success."];
  }

  return ["  JSON on success:", ...outputPropertyEntries(properties)];
}

/** A handler's declared result, named at the position a caller reads it from:
 * the settled Invocation JSON's `result` key, not the command's stdout. An
 * object result enumerates its fields the way a tool's does; anything else
 * names its type, because a scalar result still has a shape worth publishing.
 */
function invocationResultLines(schema: JSONSchema): string[] {
  const properties = objectProperties(schema);
  if (!properties || Object.keys(properties).length === 0) {
    return [
      "  The invocation's `result`:",
      ...schemaShapeString(schema).split("\n").map((line) => `    ${line}`),
    ];
  }

  return ["  The invocation's `result`:", ...outputPropertyEntries(properties)];
}

/** The `Output:` section of a help page, or nothing at all.
 *
 * A DECLARED result decides it, not the callable kind. A verb declared
 * `Stream<E, R>` enumerates `R` exactly as a tool enumerates its pattern's
 * result; a handler that declares nothing keeps no section at all, because an
 * absent section reports that the page has nothing to say, where a fixed claim
 * about output would be false for every verb that returns one.
 *
 * The two kinds name different positions because a caller collects them from
 * different places: a tool's result IS the command's stdout, and a handler's
 * rides the settled Invocation JSON.
 */
function outputSectionLines(spec: ExecCommandSpec): string[] {
  if (spec.outputSchemaSummary === undefined) {
    return spec.callableKind === "tool"
      ? ["", "Output:", "  JSON on success."]
      : [];
  }
  return [
    "",
    "Output:",
    ...(spec.callableKind === "handler"
      ? invocationResultLines(spec.outputSchemaSummary)
      : outputPropertyLines(spec.outputSchemaSummary)),
  ];
}

/**
 * The command through the word that opened the callable's section, as both a
 * usage line and a refusal about that section print it.
 *
 * Exported because the refusal is raised by the parser, which is handed this
 * string rather than the path: two spellings of the same command on a help
 * page and on the refusal that page's flags earn would be two answers to one
 * question.
 */
export function usageCommandPrefix(
  mountedFilePath: string,
  invocationStyle: "cf" | "direct",
  commandPrefix?: string,
): string {
  if (commandPrefix) {
    return commandPrefix;
  }
  const displayedPath = displayCommandPath(mountedFilePath);
  return invocationStyle === "direct"
    ? displayedPath
    : cliCommand(["exec", displayedPath]);
}

function optionalVerbUsage(spec: ExecCommandSpec): string {
  return `[${spec.defaultVerb}]`;
}

function usageLine(
  mountedFilePath: string,
  spec: ExecCommandSpec,
  invocationStyle: "cf" | "direct",
  commandPrefix?: string,
): string {
  const prefix = usageCommandPrefix(
    mountedFilePath,
    invocationStyle,
    commandPrefix,
  );
  const verb = optionalVerbUsage(spec);
  const properties = objectProperties(spec.inputSchema);

  if (!properties) {
    return `${prefix} ${verb} --value ${valuePlaceholder(spec.inputSchema)}`;
  }

  const required = requiredEventFieldsOwed(spec.inputSchema);
  const requiredUsages = Object.entries(properties)
    .filter(([key]) => required.has(key))
    .map(([key, propertySchema]) =>
      primaryFlagUsage(flagNameForKey(key), propertySchema)
    );
  if (
    spec.callableKind === "handler" &&
    handlerAllowsInvokeWithoutInputs(spec.inputSchema) &&
    requiredUsages.length === 0
  ) {
    return `${prefix} ${spec.defaultVerb}`;
  }
  const suffix = requiredUsages.length > 0
    ? ` ${requiredUsages.join(" ")}`
    : "";
  return `${prefix} ${verb}${suffix}`;
}

function helpUsageLines(
  mountedFilePath: string,
  spec: ExecCommandSpec,
  invocationStyle: "cf" | "direct",
  commandPrefix?: string,
): string[] {
  const prefix = usageCommandPrefix(
    mountedFilePath,
    invocationStyle,
    commandPrefix,
  );
  const verb = optionalVerbUsage(spec);
  const properties = objectProperties(spec.inputSchema);
  return [
    `  ${usageLine(mountedFilePath, spec, invocationStyle, commandPrefix)}`,
    ...(!properties ? [`  ${prefix} ${verb} --value-file <path>`] : []),
    `  ${prefix} ${verb} --json`,
    `  ${prefix} ${verb} --json-file <path>`,
    `  ${prefix} ${verb} --help`,
    `  ${prefix} ${verb} --help --json`,
  ];
}

function handlerAllowsInvokeWithoutInputs(schema: JSONSchema): boolean {
  if (isSchemaLessHandlerInput(schema)) {
    return true;
  }
  return verbRunsWithoutPayload(schema);
}

export function parseExecArgs(
  spec: ExecCommandSpec,
  rawArgs: string[],
  sectionPrefix = "...",
): ParsedExecArgs {
  const args = [...rawArgs];
  let verb = spec.defaultVerb;
  const helpField = hasHelpField(spec.inputSchema);
  let explicitVerb = false;

  if (rawArgs[0] === "--help") {
    if (rawArgs.length === 1) {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: false,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (rawArgs.length === 2 && rawArgs[1] === "--json") {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: true,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (!helpField) {
      throw new Error(HELP_TAKES_NO_ARGUMENTS);
    }
  }

  if (VERB_KEYWORDS.includes(args[0])) {
    if (args[0] !== spec.defaultVerb) {
      throw new Error(
        `Invalid verb ${
          args[0]
        } for ${spec.callableKind}; use ${spec.defaultVerb}`,
      );
    }
    verb = args.shift() as "invoke" | "run";
    explicitVerb = true;
  }

  if (args[0] === "--help") {
    if (args.length === 1) {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: false,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (args.length === 2 && args[1] === "--json") {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: true,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (!helpField) {
      throw new Error(HELP_TAKES_NO_ARGUMENTS);
    }
  }

  if (
    spec.callableKind === "handler" && !explicitVerb && args.length === 0 &&
    !handlerAllowsInvokeWithoutInputs(spec.inputSchema)
  ) {
    const typeShape = schemaShapeString(spec.inputSchema);
    throw new Error(
      `Handler requires input. Expected type: ${typeShape}\nRun --help for full usage.`,
    );
  }

  const properties = objectProperties(spec.inputSchema);
  // The keyword was shifted off `args`, so it rejoins the prefix: a refusal
  // reprints the line the caller wrote, and a word dropped from it is a word
  // they would put back and be refused again for.
  const inputPrefix = explicitVerb ? `${sectionPrefix} ${verb}` : sectionPrefix;
  const parsedInput = properties
    ? parseObjectInput(spec.inputSchema, args, inputPrefix)
    : parseNonObjectInput(spec.inputSchema, args, inputPrefix);

  return {
    verb,
    input:
      properties && !parsedInput.readJsonFromStdin && !parsedInput.inputFile &&
        !parsedInput.usedJsonInput
        ? parsedInput.input ?? {}
        : parsedInput.input,
    showHelp: false,
    showHelpJson: false,
    readJsonFromStdin: parsedInput.readJsonFromStdin,
    readTextFromStdin: parsedInput.readTextFromStdin,
    inputFile: parsedInput.inputFile,
    usedJsonInput: parsedInput.usedJsonInput,
  };
}

export function renderExecHelpJson(spec: ExecCommandSpec): string {
  const value: Record<string, unknown> = {
    callableKind: spec.callableKind,
    ...(spec.description !== undefined && { description: spec.description }),
    inputSchema: spec.inputSchema,
  };
  if (spec.outputSchemaSummary !== undefined) {
    value.outputSchema = spec.outputSchemaSummary;
  }
  return JSON.stringify(value, null, 2);
}

export function renderExecHelp(
  mountedFilePath: string,
  spec: ExecCommandSpec,
  options: RenderExecHelpOptions = {},
): string {
  const commandPrefix = options.commandPrefix;
  const invocationStyle = options.invocationStyle ?? "cf";
  const specificFlags = specificFlagLines(spec.inputSchema);
  const genericFlags = genericFlagLines(spec.inputSchema);
  const typeShape = schemaShapeString(spec.inputSchema);

  const lines = [
    "Usage:",
    ...helpUsageLines(mountedFilePath, spec, invocationStyle, commandPrefix),
    "",
    "Input type:",
    ...typeShape.split("\n").map((line) => `  ${line}`),
    "",
    "Flags:",
    ...specificFlags,
    ...(specificFlags.length > 0 ? [""] : []),
    ...genericFlags,
  ];

  if (spec.callableKind === "handler") {
    lines.push("");
    lines.push("Alternatively, write JSON to this file to invoke the handler.");
    if (handlerAllowsInvokeWithoutInputs(spec.inputSchema)) {
      lines.push("Invoke alone will call the handler without any inputs.");
    }
  }
  lines.push(...outputSectionLines(spec));

  return lines.join("\n");
}

function schemaShapeString(schema: JSONSchema): string {
  if (isSchemaLessHandlerInput(schema)) {
    return "void";
  }
  // Same TS-like rendering the runner uses for LLM context; CLI help only adds
  // the "void" spelling for schema-less handler inputs above. The formatter
  // resolves $refs against options.defs, not the schema's own $defs, so
  // thread them through.
  return schemaToTypeString(schema, {
    defs: isSchemaObject(schema)
      ? schema.$defs as Record<string, JSONSchema> | undefined
      : undefined,
  });
}

function pieceJsonUsageLine(commandPrefix: string): string {
  return `${commandPrefix} <json>`;
}

function pieceExplicitJsonUsageLine(commandPrefix: string): string {
  return `${commandPrefix} --json [<json>]`;
}

function pieceFlagUsageLine(
  commandPrefix: string,
  spec: ExecCommandSpec,
): string {
  return usageLine(commandPrefix, spec, "cf", commandPrefix);
}

/**
 * The line that teaches the marker, and the only one on this page about the
 * read step rather than about the verb.
 *
 * It earns its place because this page is where a caller is looking at the
 * verb's own flags — the moment the boundary between those and a projection
 * has to be legible. `--select` stands for all three read options; the
 * command's own `--help` enumerates them.
 */
function pieceReadOptionUsageLine(commandPrefix: string): string {
  return `${commandPrefix} ... -- --select <fields>`;
}

function pieceUsageLines(
  commandPrefix: string,
  spec: ExecCommandSpec,
): string[] {
  const properties = objectProperties(spec.inputSchema);
  return [
    `  ${commandPrefix} --help`,
    `  ${commandPrefix} --help --json`,
    ...(spec.callableKind === "handler" &&
        handlerAllowsInvokeWithoutInputs(spec.inputSchema)
      ? [`  ${commandPrefix}`, `  ${commandPrefix} invoke`]
      : []),
    `  ${pieceJsonUsageLine(commandPrefix)}`,
    `  ${pieceExplicitJsonUsageLine(commandPrefix)}`,
    `  ${commandPrefix} --json-file <path>`,
    `  ${pieceFlagUsageLine(commandPrefix, spec)}`,
    ...(!properties ? [`  ${commandPrefix} --value-file <path>`] : []),
    `  ${pieceReadOptionUsageLine(commandPrefix)}`,
  ];
}

function pieceJsonInputLines(schema: JSONSchema): string[] {
  return [
    "  Pass inline JSON as one positional argument or after `--json`. Bare `--json` reads JSON from stdin.",
    "  Use `--json-file <path>` for a file. Schema-derived flags are written in the same place, which the callable name opened.",
    ...schemaShapeString(schema).split("\n").map((line) => `  ${line}`),
  ];
}

export function renderPieceCallHelp(
  commandPrefix: string,
  spec: ExecCommandSpec,
): string {
  const specificFlags = specificFlagLines(spec.inputSchema);
  const lines = [
    "Usage:",
    ...pieceUsageLines(commandPrefix, spec),
    // The verb's own prose, as a paragraph of its own between Usage and the
    // sections describing the payload. Nothing stands here when the author
    // wrote no comment: an empty paragraph would read as a summary the page
    // failed to fill in, rather than as a verb nobody documented.
    ...(spec.description !== undefined ? ["", spec.description] : []),
    "",
    "JSON input:",
    ...pieceJsonInputLines(spec.inputSchema),
  ];

  if (specificFlags.length > 0) {
    lines.push("");
    lines.push("Flags:");
    lines.push(...specificFlags);
  }

  // No write-through note here, unlike the mounted-file page above: this
  // command takes its payload as an argument, and there is no file for a
  // caller to write JSON to.
  if (
    spec.callableKind === "handler" &&
    handlerAllowsInvokeWithoutInputs(spec.inputSchema)
  ) {
    lines.push("");
    lines.push("Invoke alone will call the handler without any inputs.");
  }
  lines.push(...outputSectionLines(spec));

  return lines.join("\n");
}
