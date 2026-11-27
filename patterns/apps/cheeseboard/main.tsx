import { fetchJson, lift, NAME, pattern, UI } from "commonfabric";

/**
 * Fetch the Cheeseboard pizza schedule via Toolshed's web-read endpoint and
 * display a list of pizza descriptions inside the piece.
 *
 * Uses: fetchJson, lift, map built-in, toolshed web-read endpoint
 */
const DATE_LINE_REGEX = /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}$/;

type CheeseboardEntry = [date: string, pizza: string];

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
type WebReadResult = {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    date?: string;
    word_count: number;
  };
};

/** Reactive system will call this lift when the fetched data
  is updated. it also allows us to call our pure function
  `extractPizzas` and return the results
*/
const createPizzaListCell = lift<{ result: WebReadResult }, CheeseboardEntry[]>(
  ({ result }) => {
    return extractPizzas(result?.content ?? "");
  },
);

export default pattern(() => {
  const cheeseBoardUrl =
    "https://cheeseboardcollective.coop/home/pizza/pizza-schedule/";
  const { result } = fetchJson<WebReadResult>({
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
  };
});
