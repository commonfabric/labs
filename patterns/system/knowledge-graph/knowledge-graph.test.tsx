/**
 * Test Pattern: the knowledge graph
 *
 * The graph's base links come from the space's mentionables, each piece's
 * `mentioned` list giving one link per mention. The test puts two pieces in
 * the space, one mentioning the other, gives the space the summary index the
 * graph also reads, and reads the link back through the graph's output, its
 * name, and its view. The neighbor and search queries are checked on edges the
 * test writes.
 *
 * The agent's annotations need a model, which a pattern test has none of, so
 * the functions that turn annotations into edges and groups are checked on
 * annotations the test writes itself.
 */
import {
  action,
  assert,
  computed,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findNode,
  hasText,
  isButton,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import type { MentionablePiece } from "../backlinks-index/backlinks-index.tsx";
import KnowledgeGraph, {
  annotatedEdges,
  annotatedGroups,
  getNeighborsPattern,
  graphAnalystPrompt,
  type GraphEdge,
  searchGraphPattern,
  type SummaryEntry,
} from "./knowledge-graph.tsx";

const piece = (name: string) =>
  new Writable<MentionablePiece>({ [NAME]: name, mentioned: [] });

/** The roles of the messages the view's conversation shows. */
const messageRoles = (ui: unknown): string => {
  const messages = propValue(findElement(ui, "cf-message-beads"), "$messages");
  return Array.isArray(messages)
    ? messages.map((message) => {
      const value = readValue(message);
      return typeof value === "object" && value !== null && "role" in value
        ? String(value.role)
        : "";
    }).join()
    : "";
};

/** How many of the conversation's messages are requests. */
const userMessageCount = (ui: unknown): number =>
  messageRoles(ui).split(",").filter((role) => role === "user").length;

export default pattern(() => {
  const mentionable = wish<Writable<MentionablePiece[]>>({
    query: "#mentionable",
  }).result!;
  const defaultApp = wish<
    Writable<{ summaryIndex?: { entries: SummaryEntry[] } }>
  >({ query: "#default" }).result!;

  const recipe = piece("Recipe");
  const groceries = piece("Groceries");
  const diary = piece("Diary");

  // ===== The graph over the space's mentionables =====

  const graph = KnowledgeGraph({});

  const action_mention_groceries = action(() => {
    recipe.key("mentioned").push(groceries);
    mentionable.push(recipe);
    mentionable.push(groceries);
    defaultApp.key("summaryIndex").set({
      entries: [
        { piece: recipe, name: "Recipe", summary: "Pancakes" },
        { piece: groceries, name: "Groceries", summary: "Eggs and flour" },
      ],
    });
  });

  const assert_mention_is_a_link = assert(() =>
    graph.edges.length === 1 &&
    graph.edges[0].fromName === "Recipe" &&
    graph.edges[0].toName === "Groceries" &&
    graph.edges[0].description === "mentions"
  );
  const assert_name_counts_link = assert(() =>
    graph[NAME] === "Knowledge Graph (1 links)"
  );
  const assert_view_counts_link = assert(() =>
    hasText(graph[UI], "1 base links, 0 agent links, 0 groups")
  );
  const assert_view_offers_build = assert(() =>
    findNode(graph[UI], isButton("Build Graph")) !== undefined &&
    findNode(graph[UI], isButton("Rebuild")) === undefined
  );

  const action_build = action(() => clickButton(graph[UI], "Build Graph"));
  const assert_build_asks_agent = assert(() =>
    messageRoles(graph[UI]).startsWith("user") &&
    findNode(graph[UI], isButton("Rebuild")) !== undefined
  );

  // A graph whose conversation already holds two requests.
  const rebuilt = KnowledgeGraph({
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Another question" },
    ],
  });
  const assert_offers_rebuild = assert(() =>
    userMessageCount(rebuilt[UI]) === 2 &&
    findNode(rebuilt[UI], isButton("Build Graph")) === undefined
  );
  const action_rebuild = action(() => clickButton(rebuilt[UI], "Rebuild"));
  // Rebuilding clears the conversation and asks again, so the new request is
  // the only one left.
  const assert_rebuild_restarts = assert(() =>
    userMessageCount(rebuilt[UI]) === 1 &&
    messageRoles(rebuilt[UI]).startsWith("user")
  );

  // ===== Neighbor and search queries =====

  const edges: GraphEdge[] = [
    {
      from: recipe,
      to: groceries,
      fromName: "Recipe",
      toName: "Groceries",
      description: "lists ingredients for",
    },
    {
      from: diary,
      to: recipe,
      fromName: "Diary",
      toName: "Recipe",
      description: "remembers cooking",
    },
  ];
  const neighbors = getNeighborsPattern({ entity: recipe, edges });
  const assert_neighbors_split_by_direction = assert(() =>
    neighbors.incoming.map((e) => e.fromName).join() === "Diary" &&
    neighbors.outgoing.map((e) => e.toName).join() === "Groceries"
  );

  const compoundNodes = [
    { [NAME]: "Kitchen", linkedPieces: [recipe], summary: "Cooking things" },
    { [NAME]: "Journal", linkedPieces: [diary], summary: "Daily notes" },
  ];
  const everything = searchGraphPattern({ query: " ", edges, compoundNodes });
  const assert_blank_search_returns_all = assert(() =>
    everything.edges.length === 2 && everything.compoundNodes.length === 2
  );
  // Each edge field is searched: a name on either end, or the description.
  const byName = searchGraphPattern({ query: "GROCER", edges, compoundNodes });
  const byDescription = searchGraphPattern({
    query: "cooking",
    edges,
    compoundNodes,
  });
  const assert_search_matches_edge_fields = assert(() =>
    byName.edges.map((e) => e.description).join() ===
      "lists ingredients for" &&
    byDescription.edges.map((e) => e.fromName).join() === "Diary"
  );
  // A group matches on its name or its summary.
  const assert_search_matches_group_fields = assert(() =>
    byName.compoundNodes.length === 0 &&
    byDescription.compoundNodes.map((n) => n[NAME]).join() === "Kitchen"
  );

  // ===== Annotations and the agent's instructions =====

  const entries: SummaryEntry[] = [
    { piece: recipe, name: "Recipe", summary: "Pancakes" },
    { piece: groceries, name: "Groceries", summary: "Eggs and flour" },
  ];
  const annotations = {
    links: [
      { fromName: "Groceries", toName: "Recipe", description: "supplies" },
      { fromName: "Groceries", toName: "Nowhere", description: "dropped" },
    ],
    groups: [{
      name: "Breakfast",
      pieceNames: ["Recipe", "Groceries", "Nowhere"],
      summary: "Morning food",
    }],
  };
  const resolvedEdges = computed(() => annotatedEdges(annotations, entries));
  const resolvedGroups = computed(() => annotatedGroups(annotations, entries));
  const assert_annotated_edges_resolve_names = assert(() =>
    resolvedEdges.length === 1 &&
    resolvedEdges[0].description === "supplies" &&
    resolvedEdges[0].fromName === "Groceries" &&
    annotatedEdges(undefined, entries).length === 0
  );
  const assert_annotated_groups_resolve_names = assert(() =>
    resolvedGroups.length === 1 &&
    resolvedGroups[0][NAME] === "Breakfast" &&
    resolvedGroups[0].linkedPieces.length === 2 &&
    annotatedGroups(undefined, entries).length === 0
  );
  const prompt = computed(() => graphAnalystPrompt(entries, edges));
  const assert_prompt_lists_pieces_and_links = assert(() =>
    prompt.includes("- Groceries: Eggs and flour") &&
    prompt.includes("- Diary → Recipe (remembers cooking)")
  );
  const assert_empty_prompt_says_none = assert(() =>
    graphAnalystPrompt([], []).includes(
      "with summaries):\n(none)\n\nExisting base links (from explicit mentions):\n(none)",
    )
  );

  return {
    [TESTS]: [
      { action: action_mention_groceries },
      { assertion: assert_mention_is_a_link },
      { assertion: assert_name_counts_link },
      { assertion: assert_view_counts_link },
      { assertion: assert_view_offers_build },
      { action: action_build },
      { assertion: assert_build_asks_agent },
      { assertion: assert_offers_rebuild },
      { action: action_rebuild },
      { assertion: assert_rebuild_restarts },
      { assertion: assert_neighbors_split_by_direction },
      { assertion: assert_blank_search_returns_all },
      { assertion: assert_search_matches_edge_fields },
      { assertion: assert_search_matches_group_fields },
      { assertion: assert_annotated_edges_resolve_names },
      { assertion: assert_annotated_groups_resolve_names },
      { assertion: assert_prompt_lists_pieces_and_links },
      { assertion: assert_empty_prompt_says_none },
    ],
    graph,
  };
});
