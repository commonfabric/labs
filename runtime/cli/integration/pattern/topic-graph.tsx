import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

/** One topic on the board. Plain data rather than a sub-piece: this fixture
 * proves the invocation protocol end to end (verb contract D4, integration
 * half), and a path into this piece's own result tree is the reference shape
 * the CLI can resolve against an isolated toolshed — the live board's
 * fid-rendering half of D4 stays open. */
interface TopicEntry {
  id: string;
  title: string;
  body: string;

  /** Attribution, interim `agentName` style (verb contract decision 5). */
  createdBy: string;

  /** "" until the body is revised. */
  bodyUpdatedBy: string;

  /** Ids of sibling topics this topic's body references. */
  references: string[];
}

interface CreateTopicEvent {
  title: string;

  /** The topic's initial body, part of the create's atomic unit. */
  body: string;

  agentName: string;

  /** Ids the body references, recorded as explicit edges. */
  references?: string[];
}

interface ReviseBodyEvent {
  id: string;
  body: string;
  agentName: string;
  references: string[];
}

/** The created (or revised) child's reference: its minted id plus the path
 * that opens the canonical child on this piece's result — decision 6:
 * patterns return references, clients render identity. */
interface TopicRef {
  id: string;
  path: string;
}

interface CreateTopicResult {
  topic: TopicRef;
}

interface ReviseBodyResult {
  topic: TopicRef;
}

interface TopicGraphInput {
  topics?: Writable<TopicEntry[] | Default<[]>>;
}

interface TopicGraphOutput {
  [NAME]: string;
  topics: TopicEntry[];
  topicCount: number;

  /** Reciprocal edges, derived at read time and never persisted — topic id →
   * ids of the topics whose `references` name it. A derived result over a list
   * of children, which is what this fixture exercises the CLI against. */
  referencedBy: Record<string, string[]>;

  createTopic: Stream<CreateTopicEvent, CreateTopicResult>;
  reviseBody: Stream<ReviseBodyEvent, ReviseBodyResult>;
}

/** A topics-like board whose verbs DECLARE results (verb contract C1
 * surface): `createTopic` returns the created child's reference and
 * `reviseBody` returns the revised topic's. Results flow schema-free
 * through the handling's receipt (the C3 deferral), where `cf piece call`
 * reads them back under `plainResultReceipts`. */
export default pattern<TopicGraphInput, TopicGraphOutput>(({ topics }) => {
  const createTopic = action<CreateTopicEvent, CreateTopicResult>(
    ({ title, body, agentName, references }) => {
      const trimmed = (title ?? "").trim();
      if (!trimmed) throw new Error("createTopic: title must be non-empty");
      if (!(agentName ?? "").trim()) {
        throw new Error("createTopic: agentName must be non-blank");
      }
      const list = topics.get() ?? [];
      // Captured before the push so the derivation cannot depend on whether
      // `list` is a live view or a snapshot of the cell's value.
      const index = list.length;
      const id = `topic-${index + 1}`;
      topics.push({
        id,
        title: trimmed,
        body,
        createdBy: agentName,
        bodyUpdatedBy: "",
        references: references ?? [],
      });
      return { topic: { id, path: `topics/${index}` } };
    },
  );

  const reviseBody = action<ReviseBodyEvent, ReviseBodyResult>(
    ({ id, body, agentName, references }) => {
      if (!(agentName ?? "").trim()) {
        throw new Error("reviseBody: agentName must be non-blank");
      }
      const list = topics.get() ?? [];
      const index = list.findIndex((entry) => entry?.id === id);
      if (index < 0) {
        throw new Error(`reviseBody: no topic with id "${id}"`);
      }
      const entry = topics.key(index);
      entry.key("body").set(body);
      entry.key("bodyUpdatedBy").set(agentName);
      entry.key("references").set(references);
      return { topic: { id, path: `topics/${index}` } };
    },
  );

  const topicCount = computed(() => (topics.get() ?? []).length);

  const referencedBy = computed(() => {
    const list = topics.get() ?? [];
    const edges: Record<string, string[]> = {};
    for (const entry of list) {
      if (entry) edges[entry.id] = [];
    }
    for (const entry of list) {
      if (!entry) continue;
      for (const ref of entry.references ?? []) {
        (edges[ref] ??= []).push(entry.id);
      }
    }
    return edges;
  });

  return {
    [NAME]: computed(() => `Topic graph (${(topics.get() ?? []).length})`),
    topics,
    topicCount,
    referencedBy,
    createTopic,
    reviseBody,
  };
});
