import {
  type BuiltInLLMMessage,
  computed,
  type Default,
  equals,
  handler,
  llmDialog,
  NAME,
  pattern,
  Stream,
  toSchema,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { type MentionablePiece } from "./backlinks-index.tsx";

export type GraphEdge = {
  from: Writable<MentionablePiece>;
  to: Writable<MentionablePiece>;
  fromName: string;
  toName: string;
  description: string;
};

export type CompoundNode = {
  [NAME]: string;
  linkedPieces: Writable<MentionablePiece>[];
  summary: string;
};

type Input = Record<string, never>;

/** Query result type for LLM consumption — names for readability, refs for identity. */
type EdgeResult = {
  from: Writable<MentionablePiece>;
  to: Writable<MentionablePiece>;
  fromName: string;
  toName: string;
  description: string;
};

/** Structured result the LLM agent produces. */
type GraphAnnotations = {
  links: Array<{ fromName: string; toName: string; description: string }>;
  groups: Array<{ name: string; pieceNames: string[]; summary: string }>;
};

// --- Module-scope handlers ---

const triggerBuild = handler<
  unknown,
  { addMessage: Stream<BuiltInLLMMessage> }
>((_, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{
      type: "text" as const,
      text: "Analyze the knowledge graph and create annotations.",
    }],
  });
});

const triggerRebuild = handler<
  unknown,
  {
    addMessage: Stream<BuiltInLLMMessage>;
    messages: Writable<BuiltInLLMMessage[]>;
  }
>((_, { addMessage, messages }) => {
  messages.set([]);
  addMessage.send({
    role: "user",
    content: [{
      type: "text" as const,
      text: "Analyze the knowledge graph and create annotations.",
    }],
  });
});

// --- Query sub-patterns ---

/** Query sub-pattern: finds all edges connected to an entity (incoming + outgoing). */
export const getNeighborsPattern = pattern<
  { entity: Writable<MentionablePiece>; edges: GraphEdge[] },
  { incoming: EdgeResult[]; outgoing: EdgeResult[] }
>(({ entity, edges }) => {
  const incoming = computed(() => {
    return edges
      .filter((edge) => equals(edge.to, entity))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        fromName: edge.fromName,
        toName: edge.toName,
        description: edge.description,
      }));
  });

  const outgoing = computed(() => {
    return edges
      .filter((edge) => equals(edge.from, entity))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        fromName: edge.fromName,
        toName: edge.toName,
        description: edge.description,
      }));
  });

  return { incoming, outgoing };
});

/** Query sub-pattern: searches graph by text query. */
export const searchGraphPattern = pattern<
  { query: string; edges: GraphEdge[]; compoundNodes: CompoundNode[] },
  { edges: EdgeResult[]; compoundNodes: CompoundNode[] }
>(({ query, edges, compoundNodes }) => {
  const filteredEdges = computed(() => {
    const matching = !query || query.trim() === "" ? edges : (() => {
      const lowerQuery = query.toLowerCase().trim();
      return edges.filter((edge) =>
        edge.fromName.toLowerCase().includes(lowerQuery) ||
        edge.toName.toLowerCase().includes(lowerQuery) ||
        edge.description.toLowerCase().includes(lowerQuery)
      );
    })();
    return matching.map((edge) => ({
      from: edge.from,
      to: edge.to,
      fromName: edge.fromName,
      toName: edge.toName,
      description: edge.description,
    }));
  });

  const filteredNodes = computed(() => {
    if (!query || query.trim() === "") return compoundNodes;
    const lowerQuery = query.toLowerCase().trim();
    return compoundNodes.filter((node) => {
      const name = (node[NAME] ?? "").toString().toLowerCase();
      const summary = node.summary.toLowerCase();
      return name.includes(lowerQuery) || summary.includes(lowerQuery);
    });
  });

  return { edges: filteredEdges, compoundNodes: filteredNodes };
});

/** Pattern tool: lists the supplied pieces with their summaries. */
const listPiecesPattern = pattern<
  {
    entries: Array<
      { piece: Writable<MentionablePiece>; summary: string; name: string }
    >;
  },
  {
    result: Array<
      { piece: Writable<MentionablePiece>; name: string; summary: string }
    >;
  }
>(({ entries }) => {
  const result = entries.map((e) => ({
    piece: e.piece,
    name: e.name,
    summary: e.summary,
  }));
  return { result };
});

// --- Main pattern ---

const KnowledgeGraph = pattern<Input>(() => {
  const mentionable = wish<Writable<MentionablePiece>[] | Default<[]>>({
    query: "#mentionable",
  }).result;

  const baseEdges = computed(() => {
    const result: GraphEdge[] = [];
    for (const piece of (Array.isArray(mentionable) ? mentionable : [])) {
      if (!piece) continue;
      const pieceName = (piece.get()[NAME] ?? "").toString();
      const mentioned = piece.key("mentioned").get() ?? [];
      for (let index = 0; index < mentioned.length; index++) {
        const mentionedItem = mentioned[index];
        if (!mentionedItem) continue;
        const mentionedCell = piece.key("mentioned").key(index);
        const mentionedName = (mentionedItem[NAME] ?? "").toString();
        result.push({
          from: piece,
          to: mentionedCell,
          fromName: pieceName,
          toName: mentionedName,
          description: "mentions",
        });
      }
    }
    return result;
  });

  // Wish for summary index data
  const { entries: summaryEntries } = wish<
    {
      entries: Array<
        { piece: Writable<MentionablePiece>; summary: string; name: string }
      >;
    }
  >({ query: "#summaryIndex" }).result!;

  // LLM agent state
  const messages = new Writable<BuiltInLLMMessage[]>([]);
  const hasBeenBuilt = computed(() => messages.get().length > 0);

  const agentSystemPrompt = computed(() => {
    const entries = summaryEntries ?? [];
    const pieceList = entries.map((e: any) => `- ${e.name}: ${e.summary}`).join(
      "\n",
    );
    const baseEdgeList = baseEdges.map((e) =>
      `- ${e.fromName} → ${e.toName} (${e.description})`
    ).join("\n");

    return `You are a knowledge graph analyst. Your job is to discover and annotate relationships between pieces — both explicit ones and hidden connections the user hasn't linked yet.

Pieces in the space (with summaries):
${pieceList || "(none)"}

Existing base links (from explicit mentions):
${baseEdgeList || "(none)"}

Your tasks:
1. **Enrich existing links** — upgrade generic "mentions" to richer descriptions like "references recipe", "extends idea", "provides context for", "contradicts", "builds upon"
2. **Discover hidden connections** — read the piece names and summaries carefully. Look for pieces that share themes, reference similar concepts, could inform each other, or represent different perspectives on the same topic. These are the MOST VALUABLE links to create — connections the user hasn't made explicitly but that exist semantically.
3. **Create groups** — cluster related pieces that share a theme, project, or domain

When discovering hidden connections, think broadly:
- Pieces about related topics (e.g. a recipe and a grocery list, a meeting note and a project plan)
- Pieces that could inform each other (e.g. research notes and a draft document)
- Pieces with overlapping entities (people, places, concepts mentioned in summaries)
- Temporal or causal relationships (e.g. a decision and its consequences)
- Complementary perspectives on the same subject

Do NOT recreate links that already exist in the base links above.
Use listPieces and getNeighbors to explore, then call presentResult with your annotations.
Use exact piece names from the piece list above for fromName/toName/pieceNames.`;
  });

  const allEdgesFromBase = baseEdges;

  // LLM dialog with resultSchema — agent produces structured annotations
  const dialogOptions = {
    system: agentSystemPrompt,
    messages,
    tools: {
      listPieces: pattern((_input: Record<string, never>) =>
        listPiecesPattern({ entries: summaryEntries })
      ),
      getNeighbors: pattern(
        ({ entity }: { entity: Writable<MentionablePiece> }) =>
          getNeighborsPattern({ entity, edges: allEdgesFromBase }),
      ),
    },
    builtinTools: false,
    resultSchema: toSchema<GraphAnnotations>(),
  };
  const { addMessage, pending, result: annotations } = llmDialog(
    dialogOptions,
  );

  // Resolve annotations into actual GraphEdges by looking up piece refs by name
  const agentEdges = computed(() => {
    if (!annotations) return [] as GraphEdge[];
    const links = annotations.links ?? [];
    const entryList = summaryEntries ?? [];
    return links.flatMap(
      (link: { fromName: string; toName: string; description: string }) => {
        const fromEntry = entryList.find((e: any) => e.name === link.fromName);
        const toEntry = entryList.find((e: any) => e.name === link.toName);
        if (!fromEntry || !toEntry) return [];
        return [{
          from: fromEntry.piece,
          to: toEntry.piece,
          fromName: link.fromName,
          toName: link.toName,
          description: link.description,
        }];
      },
    );
  });

  const compoundNodes = computed(() => {
    if (!annotations) return [] as CompoundNode[];
    const groups = annotations.groups ?? [];
    const entryList = summaryEntries ?? [];
    return groups.map(
      (group: { name: string; pieceNames: string[]; summary: string }) => ({
        [NAME]: group.name,
        linkedPieces: (group.pieceNames ?? []).flatMap((name: string) => {
          const piece = entryList.find((e: any) => e.name === name)?.piece;
          return piece ? [piece] : [];
        }),
        summary: group.summary,
      }),
    );
  });

  const allEdges = computed(() => [
    ...baseEdges,
    ...(agentEdges ?? []),
  ]);

  // Computed counts for UI
  const baseEdgeCount = computed(() => baseEdges.length);
  const agentEdgeCount = computed(() => (agentEdges ?? []).length);
  const compoundNodeCount = computed(() => (compoundNodes ?? []).length);

  return {
    [NAME]: computed(() => {
      const total = baseEdgeCount + agentEdgeCount;
      return `Knowledge Graph (${total} links)`;
    }),
    [UI]: (
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Knowledge Graph</h2>
          <div slot="end">
            {hasBeenBuilt
              ? (
                <cf-button
                  variant="ghost"
                  onClick={triggerRebuild({ addMessage, messages })}
                >
                  Rebuild
                </cf-button>
              )
              : (
                <cf-button
                  variant="primary"
                  onClick={triggerBuild({ addMessage })}
                >
                  Build Graph
                </cf-button>
              )}
          </div>
        </cf-toolbar>
        <cf-vstack gap="4" padding="6">
          <span
            style={{
              fontSize: "13px",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            {baseEdgeCount} base links, {agentEdgeCount} agent links,{" "}
            {compoundNodeCount} groups
          </span>

          <cf-message-beads
            label="graph analysis"
            $messages={messages}
            pending={pending}
          />

          {computed(() => compoundNodes.length > 0)
            ? (
              <div>
                <h3 style={{ margin: "0 0 8px", fontSize: "15px" }}>Groups</h3>
                <cf-table full-width>
                  <tbody>
                    {compoundNodes.map((node: any) => (
                      <tr>
                        <td style={{ fontWeight: "500" }}>{node[NAME]}</td>
                        <td
                          style={{
                            fontSize: "13px",
                            color: "var(--cf-theme-color-text-secondary)",
                          }}
                        >
                          {node.summary}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </cf-table>
              </div>
            )
            : null}

          <h3 style={{ margin: "0", fontSize: "15px" }}>Links</h3>
          <cf-table full-width>
            <tbody>
              {allEdges.map((edge) => (
                <tr>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <cf-cell-link $cell={edge.from} />
                  </td>
                  <td
                    style={{
                      fontSize: "13px",
                      color: "var(--cf-theme-color-text-secondary)",
                      textAlign: "center",
                    }}
                  >
                    {edge.description}
                  </td>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <cf-cell-link $cell={edge.to} />
                  </td>
                </tr>
              ))}
            </tbody>
          </cf-table>
        </cf-vstack>
      </cf-screen>
    ),
    edges: allEdges,
    compoundNodes,
    getNeighbors: pattern(
      ({ entity }: { entity: Writable<MentionablePiece> }) =>
        getNeighborsPattern({ entity, edges: allEdges }),
    ),
    searchGraph: pattern(({ query }: { query: string }) =>
      searchGraphPattern({ query, edges: allEdges, compoundNodes })
    ),
  };
});

export default KnowledgeGraph;
