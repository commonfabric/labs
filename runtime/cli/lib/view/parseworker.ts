/**
 * A parse worker's entry: loaded in a Deno Worker by `workerParser`, it parses
 * the requests the pager sends, in order, and sends their outcomes in batches
 * of at least {@link IN_PLACE_PARSE_BUDGET} characters of source, and at most
 * {@link BATCHES} batches, so that the pager colors the diff again a few times
 * rather than once per file. The protocol is in `backgroundparse.ts`; nothing
 * outside a worker imports this module.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";

import {
  IN_PLACE_PARSE_BUDGET,
  parse,
  type ParseOutcome,
  type ParseRequest,
  type ParseWorkerAnswer,
  type ParseWorkerMessage,
} from "./backgroundparse.ts";
import { finishGrammarLoads, languageForName } from "./languages/language.ts";

/** How many batches, at most, the outcomes of a long list of requests are
 * sent in, so that a large diff is colored again a bounded number of times. */
const BATCHES = 20;

self.onmessage = async (event: MessageEvent<ParseWorkerMessage>) => {
  const { requests } = event.data;
  const total = requests.reduce((sum, request) => sum + request.text.length, 0);
  const batch = Math.max(IN_PLACE_PARSE_BUDGET, total / BATCHES);
  let outcomes: ParseOutcome[] = [];
  let size = 0;
  for (const request of requests) {
    outcomes.push(await outcome(request));
    size += request.text.length;
    if (size >= batch) {
      send(outcomes);
      outcomes = [];
      size = 0;
    }
  }
  if (outcomes.length > 0) send(outcomes);
};

/** Parses `request`, giving the failure as its outcome when it throws. */
async function outcome(request: ParseRequest): Promise<ParseOutcome> {
  const { index, kind, languageId, text, fileName } = request;
  try {
    const language = languageForName(languageId);
    if (language === undefined) {
      throw new Error(`No language is named "${languageId}".`);
    }
    await language.prepare?.();
    // A language embedded in another, such as the language an Org source
    // block names, starts loading its parser when a parse reaches it.
    let result = parse(kind, language, text, fileName);
    while (await finishGrammarLoads()) {
      result = parse(kind, language, text, fileName);
    }
    return { kind: "parsed", index, result };
  } catch (error) {
    return { kind: "failed", index, failure: describeFailure(error) };
  }
}

/** Sends `outcomes` to the pager. */
function send(outcomes: readonly ParseOutcome[]): void {
  const answer: ParseWorkerAnswer = { outcomes };
  self.postMessage(answer);
}
