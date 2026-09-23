/** Runs the book pattern's authored assertions against a real external agent runner. */
import { fromFileUrl, join } from "@std/path";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { NormalizedFullLink } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { loadIdentity } from "../../cli/lib/identity.ts";
import {
  runTestPattern,
  type TestRunResult,
} from "../../cli/lib/test-runner.ts";

/** The caller supplies the real runner's deployment and identity. */
export interface AgentBookPatternTestOptions {
  apiUrl: URL;
  identityPath: string;
  books?: readonly { title: string; author: string }[];
  patternCoverageDir?: string;
}

const DEFAULT_BOOKS = [
  { title: "The Dispossessed", author: "Ursula K. Le Guin" },
  { title: "Parable of the Sower", author: "Octavia E. Butler" },
  { title: "Solaris", author: "Stanisław Lem" },
  { title: "Kindred", author: "Octavia E. Butler" },
  { title: "The Left Hand of Darkness", author: "Ursula K. Le Guin" },
];

const STATE_SCHEMA = {
  type: "object",
  properties: {
    pending: { type: "boolean" },
    error: { type: "string" },
    result: {
      type: "object",
      properties: { picks: { type: "array", items: {} } },
    },
  },
} as const;

type ObservedState = {
  pending?: boolean;
  error?: string;
  result?: { picks?: unknown[] };
};

/**
 * The host awaits the external agent before the authored assertions inspect
 * its actual linked result.
 */
export async function runAgentBookPatternTest(
  options: AgentBookPatternTestOptions,
): Promise<TestRunResult> {
  const books = options.books ?? DEFAULT_BOOKS;
  if (books.length !== 5) {
    throw new Error("The book fixture requires five books");
  }
  const identity = await loadIdentity(options.identityPath);
  const storageManager = StorageManager.open({
    as: identity,
    memoryHost: options.apiUrl,
  });
  const directory = await Deno.makeTempDir({
    dir: fromFileUrl(new URL("./", import.meta.url)),
    prefix: ".agent-book-cf-test-",
  });
  const fixture = join(directory, "main.test.tsx");
  let recommendationLink: NormalizedFullLink | undefined;
  const previousAgentFlag = Deno.env.get("EXPERIMENTAL_AGENT_BUILTIN");
  const previousServerFlag = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  try {
    await Deno.writeTextFile(
      fixture,
      `
import { assert, type Cfc, pattern, TESTS, Writable } from "commonfabric";
import BookRecommendations from "../../book-recommendations/main.tsx";
import type { Book } from "../../book-recommendations/view.tsx";
type ReaderBook = Cfc<Book, { confidentiality: [{
  type: "https://commonfabric.org/cfc/atom/User";
  subject: ${JSON.stringify(identity.did())};
}] }>;
export default pattern(() => {
  ${
        books.map((book, index) =>
          `const book${index} = new Writable<ReaderBook>(${
            JSON.stringify(book)
          });`
        ).join("\n  ")
      }
  const reader = BookRecommendations({
    finishedBooks: [${books.map((_, index) => `book${index}`).join(", ")}],
    favoriteAuthors: ${
        JSON.stringify([...new Set(books.map((book) => book.author))])
      },
  });
  return { [TESTS]: [
    { assertion: assert(() => [
      reader.recommendation.pending === false,
      reader.recommendation.error === undefined,
      reader.recommendation.result?.picks.length === 5,
      reader.recommendation.result?.picks[0].book.get().title !== undefined,
    ].every(Boolean)) },
  ] };
});
`,
    );
    Deno.env.set("EXPERIMENTAL_AGENT_BUILTIN", "true");
    Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", "false");
    return await runTestPattern(fixture, {
      root: fromFileUrl(new URL("../", import.meta.url)),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      ...(options.patternCoverageDir !== undefined
        ? { patternCoverageDir: options.patternCoverageDir }
        : {}),
      storageHost: {
        identity,
        storageManager,
        apiUrl: options.apiUrl,
        preserveDefaultPattern: true,
        onPatternInstantiated: (instance) => {
          if (
            recommendationLink !== undefined || instance.symbol !== "default" ||
            !instance.main?.endsWith("/book-recommendations/main.tsx")
          ) return;
          recommendationLink = instance.cell;
        },
        beforeAssertions: async (runtime) => {
          if (recommendationLink === undefined) {
            throw new Error("The book pattern was not instantiated");
          }
          const state = runtime.getCellFromLink(recommendationLink)
            .key("recommendation").asSchema<ObservedState>(STATE_SCHEMA);
          const value = await waitForCellValue<ObservedState>(
            runtime,
            state,
            (value) =>
              value?.error !== undefined ||
              (value?.pending === false && value.result !== undefined),
            {
              stuckLabel: "the book cf test's external agent run",
            },
          );
          if (value.error !== undefined) throw new Error(value.error);
        },
      },
    });
  } finally {
    if (previousAgentFlag === undefined) {
      Deno.env.delete("EXPERIMENTAL_AGENT_BUILTIN");
    } else Deno.env.set("EXPERIMENTAL_AGENT_BUILTIN", previousAgentFlag);
    if (previousServerFlag === undefined) {
      Deno.env.delete("EXPERIMENTAL_SERVER_EXECUTION");
    } else Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", previousServerFlag);
    await storageManager.close();
    await Deno.remove(directory, { recursive: true });
  }
}
