/**
 * Fetches the Cheeseboard pizza schedule through Toolshed's web-read endpoint
 * and presents dated pizza descriptions.
 */

import {
  type AsyncResult,
  fetchJson,
  lift,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
} from "commonfabric";

const DATE_LINE_REGEX = /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}$/;

/** One dated pizza description from the published schedule. */
export type CheeseboardEntry = [date: string, pizza: string];

/** Extract pizza descriptions from a web-read content blob. */
function extractPizzas(content: string): CheeseboardEntry[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const pizzas: CheeseboardEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const dateLine = lines[i].trim();
    if (!DATE_LINE_REGEX.test(dateLine)) {
      continue;
    }

    let cursor = i + 1;
    while (cursor < lines.length && lines[cursor].trim() === "") {
      cursor++;
    }

    if (lines[cursor]?.trim() !== "### Pizza") {
      continue;
    }

    cursor++;
    while (cursor < lines.length && lines[cursor].trim() === "") {
      cursor++;
    }

    const descriptionLines: string[] = [];
    for (; cursor < lines.length; cursor++) {
      const current = lines[cursor].trim();
      if (
        current === "" ||
        current.startsWith("### ") ||
        DATE_LINE_REGEX.test(current)
      ) {
        break;
      }
      descriptionLines.push(current);
    }

    if (descriptionLines.length > 0) {
      pizzas.push([
        dateLine,
        descriptionLines.join(" "),
      ]);
    }
  }

  return pizzas;
}

/** Shape of the Toolshed web-read response we care about. */
export type WebReadResult = {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    date?: string;
    word_count: number;
  };
};

/** Parses the content of a usable web-read response. */
const createPizzaListCell = lift<{ result: WebReadResult }, CheeseboardEntry[]>(
  ({ result }) => {
    return extractPizzas(result.content);
  },
);

const cheeseBoardUrl =
  "https://cheeseboardcollective.coop/home/pizza/pizza-schedule/";

/** Presents the current web-read result as a dated pizza schedule. */
export const CheeseboardPresentation = pattern<
  { responseRequest: AsyncResult<WebReadResult> },
  { [NAME]: string; [UI]: VNode; pizzaList: CheeseboardEntry[] }
>(({ responseRequest }) => {
  const result = resultOf(responseRequest);

  const pizzaList = createPizzaListCell({ result });

  return {
    [NAME]: "Cheeseboard",
    [UI]: (
      <div>
        <h2>Cheeseboard</h2>
        <p>
          <a
            href={cheeseBoardUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {cheeseBoardUrl}
          </a>
        </p>
        <div>
          <h3>Pizza list</h3>
          <ul>
            {pizzaList.map(([date, pizza]) => (
              <li>
                {date}: {pizza}
              </li>
            ))}
          </ul>
        </div>
      </div>
    ),
    pizzaList,
  };
});

export default pattern(() => {
  const request = fetchJson<WebReadResult>({
    url: "/api/agent-tools/web-read",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        url: cheeseBoardUrl,
        max_tokens: 4000,
      },
    },
  });
  return CheeseboardPresentation({ responseRequest: request });
});
