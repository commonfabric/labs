/**
 * A verb's own fields, shaped as the flags a caller writes them with.
 *
 * The pattern author's vocabulary rather than the CLI's, which is what makes
 * this the position where a caller has least to go on and completion has most
 * to give. Everything it needs rides the listing `callableCandidates` already
 * fetches, so filling the slot costs no request.
 *
 * Held here rather than beside `shapeVerbCandidates` in `providers.ts` for one
 * reason: reading a declared input means resolving `callable.ts`, which costs
 * about a third of a whole static completion. `providers.ts` is resolved on
 * every Tab and this module is resolved only where a verb's flags are being
 * offered, which is what the inline imports there buy everywhere else.
 *
 * The slot they belong to is the `tail` argument: the verb opens the callable's
 * section, so its fields are written directly after the verb name and `--`
 * closes that section rather than opening it. Routing them there is item 4 of
 * [CLI completion coverage](../../../../docs/plans/cli-completion-coverage.md);
 * this module is the half that does not depend on the wiring.
 */

import type { JSONSchema } from "@commonfabric/api";
import { type DeclaredVerbFlag, declaredVerbFlags } from "../exec-schema.ts";
import type { Candidate } from "./static.ts";

/** The half of a verb listing row these candidates are derived from. */
export interface VerbFlagListingLike {
  /** The verb's input schema, as `cf piece verbs` reports it. */
  readonly inputSchema: JSONSchema | true;
}

/**
 * `--help` reaches the verb's own page from inside the callable's section, so
 * it belongs in this slot rather than among the command's flags. The other
 * generic input flags are offered beside it because the parser accepts them
 * for every verb, whatever it declared.
 */
const GENERIC_FLAGS: readonly Candidate[] = [
  { value: "--json", description: "the whole input as JSON" },
  { value: "--json-file", description: "the whole input from a JSON file" },
  { value: "--help", description: "this verb's own help page" },
];

/**
 * Every flag the verb accepts, in the order its help page lists them: its
 * declared fields first, then the generic input flags.
 *
 * A boolean field is offered in both spellings — `--flag` and `--no-flag` —
 * because both are what the parser accepts and the negated one is the half a
 * caller is least likely to guess.
 *
 * The annotation is the author's own doc comment where the field carries one,
 * falling back to whether the payload door owes the field. That is the same
 * choice the help page makes, read from the same enumeration.
 */
export function shapeVerbFlagCandidates(
  verb: VerbFlagListingLike,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, description: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    candidates.push({ value, description });
  };

  const declared = declaredVerbFlags(verb.inputSchema);
  const describe = (flag: DeclaredVerbFlag) =>
    fieldDescription(flag.schema) ?? (flag.required ? "required" : "optional");
  // The token each declared field owns outright, which is the lookup the
  // parser makes first.
  const owned = new Set(declared.map((flag) => `--${flag.name}`));

  // In the parser's own order. `parseObjectInput` matches the bare `--json`
  // and `--json-file` before anything else, then a declared field of the
  // token's exact name, and only then reads a `no-` prefix as a negation. A
  // candidate list in any other order names flags that do something else.
  for (const flag of declared) {
    // A verb may declare `json`, `json-file` or `help` — names the command
    // owns as bare tokens. The parser reads the bare token as ITS meaning and
    // never reaches the field, so the field is offered in the one spelling
    // that does: a boolean carries its value, anything else stops at the `=`.
    if (RESERVED_BARE_SPELLINGS.has(flag.name)) {
      add(
        flag.negatable ? `--${flag.name}=true` : `--${flag.name}=`,
        `${describe(flag)} (the declared field)`,
      );
      continue;
    }
    add(`--${flag.name}`, describe(flag));
  }

  for (const flag of declared) {
    if (!flag.negatable) continue;
    const negation = `--no-${flag.name}`;
    // A field named `noActive` owns `--no-active`, and the parser finds it
    // before it ever reads the token as a negation of `active`. Offering the
    // negation there would annotate one field's flag with another's meaning —
    // so the inline spelling, which no other field can own, is offered instead.
    if (owned.has(negation)) {
      add(`--${flag.name}=false`, `${describe(flag)} (false)`);
      continue;
    }
    add(negation, `${describe(flag)} (false)`);
  }

  for (const generic of GENERIC_FLAGS) {
    add(generic.value, generic.description ?? "");
  }
  return candidates;
}

/**
 * Flag names the command consumes as bare tokens before a declared field is
 * ever consulted: `--json` and `--json-file` select an input mode, and
 * `--help` opens the verb's page. A field of one of those names is reachable
 * only as `--name=value`, which those doors do not match.
 */
const RESERVED_BARE_SPELLINGS: ReadonlySet<string> = new Set([
  "json",
  "json-file",
  "help",
]);

/** The author's doc comment on the field, where the schema carries one. */
function fieldDescription(schema: JSONSchema | undefined): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const description = (schema as { description?: unknown }).description;
  return typeof description === "string" && description.length > 0
    ? description.split("\n")[0]
    : undefined;
}
