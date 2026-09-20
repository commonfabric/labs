/**
 * What `tab` finishes: the token a line ends in, completed against the verbs
 * and against what stands where shuttle stands.
 *
 * Decision 3 (`docs/plans/shuttle/README.md`) names completion as part of what
 * serves the audience it puts second, and this is that: a person who knows
 * the fabric and not this shell's vocabulary finds both by pressing one key.
 *
 * `packages/cli` has a completion of its own under `lib/completion/`, and this
 * is not a second copy of it. That one answers a shell asking what a
 * half-typed `cf` line could become, so each provider resolves its own
 * connection from the words on that line and fails silently and empty; this
 * one runs inside a process that already holds a connection and already
 * stands somewhere, so what it reads is the listing (`listing.ts`) rather
 * than a resolution. The one thing it takes from the other is that posture
 * toward failure: a read that failed offers nothing, where `ls` raises,
 * because a tab is not a request for an answer about the fabric and a person
 * pressing one has not asked to be told anything.
 *
 * Two properties bound what may be offered, and both are borrowed rather than
 * restated.
 *
 * **A completion offers a token the line takes.** The candidates under a
 * place are `operandForChild`'s answers (`place.ts`), which is what a listing
 * prints for the same rows, so a name a completion writes is one `cd` takes
 * back to the row — including a name whose own characters are readings, which
 * comes back as the operand that reaches it. Where on the line the token may
 * stand is `candidatesAfter`'s answer (`verbs.ts`), which reads the tokens
 * before it through the dispatch's own option reading, so a completion never
 * offers an operand the verb would refuse.
 *
 * Nothing else turns a candidate down, and in particular nothing reads its
 * shape. An operand carrying the separator is offered like any other, which
 * is how a row whose own operand is a reference is reached at all. So what
 * bounds a completion is which candidates there are rather than which are
 * allowed: `cd slugs/bo` at a space root writes nothing because no row
 * standing at the root is called that, the row it names standing inside
 * `slugs/` — and reaching a row there is a read of a place the line has not
 * moved to, which is a completion of its own rather than a rule against this
 * one.
 *
 * **A completion reads, so it cancels.** The read and the answer each go
 * through `guarded`, so a `ctrl-c` stops the read that has not gone out and
 * the answer that has not been given. What it cannot stop is a read already
 * sent, and what stops that taking effect is the prompt: a completion is
 * written onto the line it was computed for and onto no other, and a `ctrl-c`
 * has emptied that line.
 */

import { quoteToken, tailOfLine } from "./line.ts";
import { type Listing, listPlace } from "./listing.ts";
import { operandForChild } from "./place.ts";
import { candidatesAfter, VERB_WORDS } from "./verbs.ts";
import { guarded, type Shuttle, type VerbDeps } from "./vocabulary.ts";

/**
 * The line `tab` leaves behind where it was pressed at the end of `line`, and
 * nothing where the line is left as it was.
 *
 * Nothing is the answer to four different questions and they are not
 * distinguished, because a person pressing `tab` gets the same thing from
 * each: a line whose last token this cannot read, a position no token may
 * stand at, no candidate matching what is typed, and a candidate that adds
 * nothing to it. None of them is a mistake and none is worth a line above the
 * prompt.
 *
 * @throws Nothing. A read that failed offers nothing, which is the one place
 * this parts from `ls`.
 */
export async function completeLine(
  shuttle: Shuttle,
  line: string,
  deps: VerbDeps = {},
): Promise<string | undefined> {
  const tail = tailOfLine(line);
  if (tail === undefined) return undefined;
  const wanted = candidatesAfter(tail.before);
  if (wanted === "nothing") return undefined;
  let offered: readonly string[] = VERB_WORDS;
  if (wanted === "children") {
    const listed = await guarded(deps, childOperands, shuttle, deps);
    if (listed.kind !== "ran") return undefined;
    offered = listed.answer;
  }
  // The composition is guarded as the read is, and for the same reason `ls`
  // guards writing its numbering: what comes back from here is written onto
  // the line, so a line the person stopped waiting for is one nothing is
  // written onto. The arguments are built before `guarded` is entered, which
  // is what leaves no await between its check and the call.
  const written = await guarded(deps, chosen, offered, tail.prefix, tail.head);
  return written.kind === "ran" ? written.answer : undefined;
}

/**
 * Helper for {@link completeLine}, which is the operand `cd` takes to each
 * row standing where shuttle stands, and none where the read failed.
 *
 * It is the listing `ls` composes, so a completion offers exactly the rows
 * `ls` prints and offers them under the names `ls` prints — one read, and one
 * answer about what a row is called. The operand is asked for again rather
 * than taken off the row, because a row carries its operand written as a
 * token and what a prefix is matched against is the value: a person typing
 * `my` is completing a key called `my key`, whose token spelling opens with a
 * quote and would match nothing they could have typed.
 *
 * A row `operandForChild` offers no operand for is left out. No operand it
 * tries reaches that row, so there is nothing to write that would take the
 * line there.
 */
async function childOperands(
  shuttle: Shuttle,
  deps: VerbDeps,
): Promise<readonly string[]> {
  const place = shuttle.place.place;
  let listing: Listing;
  try {
    listing = await listPlace(
      shuttle.config,
      place,
      shuttle.connection,
      // The listing reads twice, and the cancel has to reach the read between.
      { ...deps.listing, signal: deps.signal },
    );
  } catch {
    return [];
  }
  return listing.rows.flatMap((row) => {
    const operand = operandForChild(place, row.name);
    return operand === undefined ? [] : [operand];
  });
}

/**
 * Helper for {@link completeLine}, which is the line `head` becomes once the
 * token `prefix` opened is completed against `offered`, and nothing where it
 * is left as it was.
 *
 * One matching candidate is written whole, as the token that names it, and a
 * whole token is what the round trip covers: `quoteToken` writes it so that
 * the split reads back the candidate, whatever the candidate holds.
 *
 * Several are written as far as they agree, and that far only where the
 * agreement is a token in its own right. A partial that needs quoting is not
 * one — `'my ` is a quote nothing closes and the split refuses the line —
 * and a closed quote around a partial is worse, since the next character a
 * person types lands outside it. So a common prefix is written where it is
 * bare and withheld where it is not, and the person types on into a
 * completion that will offer the same candidates again.
 *
 * Nothing where the line would be unchanged: `tab` at a token already
 * complete leaves the buffer alone rather than writing what is already there.
 */
function chosen(
  offered: readonly string[],
  prefix: string,
  head: string,
): string | undefined {
  const matched = offered.filter((candidate) => candidate.startsWith(prefix));
  if (matched.length === 0) return undefined;
  const written = matched.length === 1
    ? quoteToken(matched[0])
    : bare(agreed(matched));
  return written === undefined || written === prefix
    ? undefined
    : `${head}${written}`;
}

/**
 * Helper for {@link chosen}, which is `text` where it is already the token
 * that names itself, and nothing where writing it as a token would change it.
 */
function bare(text: string): string | undefined {
  return quoteToken(text) === text ? text : undefined;
}

/**
 * Helper for {@link chosen}, which is the longest opening `candidates` all
 * share.
 *
 * The comparison is by character rather than by code unit, and the difference
 * is the whole of what this has to get right: two candidates that part inside
 * a surrogate pair share its leading half, so a comparison counting code
 * units would agree one unit past the last character they have in common and
 * hand back a string ending in half of one. A terminal cannot draw that half,
 * and the next character typed lands after it rather than completing it, so
 * what the line then holds reaches no candidate at all.
 *
 * The prefix a caller matched against is a value the split read off the line,
 * so it ends on a character boundary and every candidate that opens with it
 * opens with whole characters. What is left to get wrong is where the
 * agreement *ends*, which is here.
 */
function agreed(candidates: readonly string[]): string {
  // Cut into characters once, at the one point, so that what a comparison
  // below counts is settled here rather than at each side of it.
  const written = candidates.map((candidate) => [...candidate]);
  let shared = written[0];
  for (const candidate of written.slice(1)) {
    let length = 0;
    while (
      length < shared.length && length < candidate.length &&
      shared[length] === candidate[length]
    ) {
      length++;
    }
    shared = shared.slice(0, length);
  }
  return shared.join("");
}
