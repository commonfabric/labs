import {
  BuiltInLLMTool,
  compileAndRun,
  computed,
  fetchJson,
  fetchProgram,
  fetchText,
  type FrameworkProvided,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  wish,
  Writable,
} from "commonfabric";

///// COMMON FABRIC (get it?) ////

import { type MentionablePiece } from "./backlinks-index.tsx";

/**
 * Calculate the result of a mathematical expression.
 * Supports +, -, *, /, and parentheses.
 */
type CalculatorRequest = {
  /** The mathematical expression to evaluate. */
  expression: string;

  /** The base to use for the calculation. */
  base?: number;
};

function evaluateMathExpression(source: string): number {
  let index = 0;

  function skipWhitespace() {
    while (index < source.length && /\s/u.test(source[index])) {
      index += 1;
    }
  }

  function parsePrimary(): number {
    skipWhitespace();
    const next = source[index];

    if (next === "+" || next === "-") {
      index += 1;
      const value = parsePrimary();
      return next === "-" ? -value : value;
    }

    if (next === "(") {
      index += 1;
      const value = parseExpression();
      skipWhitespace();
      if (source[index] !== ")") {
        throw new Error("Invalid expression");
      }
      index += 1;
      return value;
    }

    const start = index;
    let sawDigit = false;
    while (index < source.length) {
      const ch = source[index];
      if (ch >= "0" && ch <= "9") {
        sawDigit = true;
        index += 1;
        continue;
      }
      if (ch === ".") {
        index += 1;
        continue;
      }
      break;
    }

    if (!sawDigit) {
      throw new Error("Invalid expression");
    }

    const value = Number(source.slice(start, index));
    if (!Number.isFinite(value)) {
      throw new Error("Invalid number");
    }
    return value;
  }

  function parseTerm(): number {
    let value = parsePrimary();
    while (true) {
      skipWhitespace();
      const operator = source[index];
      if (operator !== "*" && operator !== "/") {
        return value;
      }
      index += 1;
      const rhs = parsePrimary();
      value = operator === "*" ? value * rhs : value / rhs;
    }
  }

  function parseExpression(): number {
    let value = parseTerm();
    while (true) {
      skipWhitespace();
      const operator = source[index];
      if (operator !== "+" && operator !== "-") {
        return value;
      }
      index += 1;
      const rhs = parseTerm();
      value = operator === "+" ? value + rhs : value - rhs;
    }
  }

  const result = parseExpression();
  skipWhitespace();
  if (index !== source.length || !Number.isFinite(result)) {
    throw new Error("Invalid expression");
  }
  return result;
}

export const calculator = pattern<
  CalculatorRequest,
  string | { error: string }
>(({ expression, base }) => {
  return computed(() => {
    const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, "");
    let sanitizedBase = Number(base);
    if (
      Number.isNaN(sanitizedBase) || sanitizedBase < 2 || sanitizedBase > 36
    ) {
      sanitizedBase = 10;
    }
    let result;
    try {
      result = evaluateMathExpression(sanitized).toString(sanitizedBase);
    } catch (error) {
      result = { error: (error as any)?.message || "<error>" };
    }
    return result;
  });
});

/** Add an item to the list. */
type AddListItemRequest = {
  /** The item to add to the list. */
  item: string;
  result: Writable<string>;
};

/** Read all items from the list. */
type ReadListItemsRequest = {
  result: Writable<string>;
};

export type ListItem = {
  title: string;
};

export const addListItem = handler<
  AddListItemRequest,
  { list: Writable<ListItem[]> }
>(
  (args, state) => {
    try {
      state.list.push({ title: args.item });
      args.result.set(`${state.list.get().length} items`);
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

export const readListItems = handler<
  ReadListItemsRequest,
  { list: ListItem[] }
>(
  (args, state) => {
    try {
      const items = state.list;
      if (items.length === 0) {
        args.result.set("The list is empty");
      } else {
        const itemList = items.map((item, index) =>
          `${index + 1}. ${item.title}`
        ).join("\n");
        args.result.set(`List items (${items.length} total):\n${itemList}`);
      }
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

/** Search the web for information. */
type SearchQuery = {
  /** The query to search the web for. */
  query: string;
};

type SearchWebResult = {
  results: {
    title: string;
    url: string;
    description: string;
  }[];
};

export const searchWeb = pattern<
  SearchQuery,
  SearchWebResult | { error: string }
>(({ query }) => {
  const { result, error } = fetchJson<SearchWebResult>({
    url: "/api/agent-tools/web-search",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        query,
        max_results: 5,
      },
    },
  });

  // TODO(seefeld): Should we instead return { result, error }? Or allocate a
  // special [ERROR] for errors? Ideally this isn't specific to using patterns as
  // tools but a general pattern.
  return ifElse(error, { error }, result);
});

/** Read and extract content from a specific webpage URL. */
type ReadWebRequest = {
  /** The URL of the webpage to read and extract content from. */
  url: string;
};

type ReadWebResult = {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    date?: string;
    word_count: number;
  };
};

export const readWebpage = pattern<
  ReadWebRequest,
  ReadWebResult | { error: string }
>(({ url }) => {
  const { result, error } = fetchJson<ReadWebResult>({
    url: "/api/agent-tools/web-read",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        url,
        max_tokens: 4000,
        include_code: true,
      },
    },
  });

  return ifElse(error, { error }, result);
});

/**
 * Execute a bash command in a persistent cloud sandbox.
 * The sandbox preserves installed packages and files across calls.
 */
type BashRequest = {
  /** The bash command to execute. */
  command: string;

  /** Working directory for the command. */
  workingDirectory?: string;

  /** Timeout in milliseconds. Defaults to 60000. */
  timeout?: number;

  /** Additional environment variables as key-value pairs. */
  environment?: Record<string, string>;

  /** Sandbox identifier. Automatically provided — do not set. */
  sandboxId: FrameworkProvided<string>;
};

type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const bash = pattern<BashRequest, BashResult | { error: string }>(
  ({ command, workingDirectory, timeout, environment, sandboxId }) => {
    // Since some of our input fields should not be included if they are
    // undefined, we use computed to conditionally construct the body object.
    const body = computed(() => {
      return {
        sandboxId,
        command,
        // optional parameters - only include if provided
        ...(workingDirectory !== undefined && { workingDirectory }),
        ...(timeout !== undefined && { timeout }),
        ...(environment !== undefined && { environment }),
      };
    });
    const { result, error } = fetchJson<BashResult>({
      url: "/api/sandbox/exec",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    });
    return ifElse(error, { error }, result);
  },
);

type ToolsInput = {
  list: ListItem[];
};

export default pattern<ToolsInput>(({ list }) => {
  const tools: Record<string, BuiltInLLMTool> = {
    search_web: {
      pattern: searchWeb,
    },
    read_webpage: {
      pattern: readWebpage,
    },
    calculator: {
      pattern: calculator,
    },
    addListItem: {
      handler: addListItem({ list }),
    },
  };

  return { tools, list };
});

/**
 * `fetchAndRunPattern({ url: "https://...", args: {} })`
 *
 * Instantiates patterns (e.g. from listPatternIndex) and returns the cell that
 * contains the results. The instantiated pattern will keep running and updating
 * the cell. Pass the resulting cell to `navigateTo` to show the pattern's UI.
 *
 * Pass in arguments to initialize the pattern. It's especially useful to pass
 * in links to other cells as `{ "@link": "/of:bafe.../path/to/data" }`.
 */
type FetchAndRunPatternInput = {
  url: string;
  args: Writable<any>;
};

export const fetchAndRunPattern = pattern<FetchAndRunPatternInput>(
  ({ url, args }) => {
    const { pending: _fetchPending, result: program, error: _fetchError } =
      fetchProgram({ url });

    // Use computed to safely handle when program is undefined/pending
    // Filter out undefined elements to handle race condition where array proxy
    // pre-allocates with undefined before populating elements
    const compileParams = computed(() => ({
      // Note: Type predicate removed - doesn't work with OpaqueCell types after transformation
      files: (program?.files ?? []).filter(
        (f) => f !== undefined && f !== null && typeof f.name === "string",
      ),
      main: program?.main ?? "",
      input: args,
    }));

    const { pending, result, error } = compileAndRun(compileParams);

    return ifElse(
      computed(() => pending || (!result && !error)),
      undefined,
      {
        cell: result,
        error,
      },
    );
  },
);

/**
 * `navigateTo({ cell: { "@link": "/of:xyz" } })` - Navigates to that cell's UI
 *
 * Especially useful after instantiating a pattern with fetchAndRunPattern:
 * Pass the "@link" you get at `cell` to navigate to the pattern's view.
 */
type NavigateToPatternInput = { cell: Writable<any> }; // Hack to steer LLM
export const navigateToPattern = pattern<NavigateToPatternInput>(
  ({ cell }) => {
    const success = navigateTo(cell);

    return ifElse(success, { success }, undefined);
  },
);

/**
 * `listPatternIndex()` - Returns the index of patterns.
 *
 * Useful as input to fetchAndRun.
 */
type ListPatternIndexInput = Record<string, never>;

export const listPatternIndex = pattern<ListPatternIndexInput>(
  ({ _ }) => {
    const patternIndexUrl = wish<{ url: Writable<string> }>({
      query: "#patternIndex",
    });

    const resolvedUrl = new Writable<string>("/api/patterns/index.md");
    computed(() => {
      const urlRef = patternIndexUrl?.result?.url;
      const urlValue = typeof urlRef?.get === "function"
        ? urlRef.get()
        : (typeof urlRef === "string" ? urlRef : undefined);
      if (typeof urlValue === "string" && urlValue.length > 0) {
        resolvedUrl.set(urlValue);
      }
    });

    const { pending, result } = fetchText({
      url: resolvedUrl,
    });
    return ifElse(computed(() => pending || !result), undefined, { result });
  },
);

/**
 * `updateProfile({ summary: "new profile text" })` - Updates the user's profile summary
 *
 * Allows the LLM to remember things about the user by updating their profile text.
 */
type UpdateProfileInput = {
  /** New profile summary text to set */
  summary: string;
};

export const updateProfile = pattern<
  UpdateProfileInput,
  { success: boolean; message: string }
>(({ summary }) => {
  // Wish for the profile cell (which is the summary string cell)
  const profileCell = wish<Writable<string>>({ query: "#learnedSummary" });

  const result = computed(() => {
    const cell = profileCell.result;
    if (!cell) return { success: false, message: "Profile not available" };

    // Set the new summary text
    cell.set(summary);

    return {
      success: true,
      message: "Profile updated successfully",
    };
  });

  return result;
});

export const listMentionable = pattern<
  { mentionable: Array<MentionablePiece> },
  { result: Array<{ label: string; piece: MentionablePiece }> }
>(({ mentionable }) => {
  const result = mentionable.map((c) => ({
    label: c[NAME]!,
    piece: c,
  }));
  return { result };
});
