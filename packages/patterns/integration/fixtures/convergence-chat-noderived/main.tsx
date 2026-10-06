import {
  type Cell,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * Convergence-storm fixture — the structural skeleton of
 * `profile-group-chat/main.tsx` with the profile wish removed, for the
 * multi-runtime convergence tests (convergence-storm.test.ts).
 *
 * Keeps exactly the pieces the multiplayer pathology needs:
 *   - a `PerSpace` message array every session appends to (the contended doc);
 *   - message objects that carry a live `Cell` link (`authorProfile`), so each
 *     pushed element is hoisted into its own entity — the durable docs another
 *     session discovers via link and must materialize (the wedge reads these
 *     at seq 0);
 *   - a shared computed over the whole list (`authors`), materialized as a
 *     space-scoped result doc whose commit carries reads of the message docs
 *     (the poison-carrier class);
 *   - a `PerUser` profile cell standing in for the wish result.
 */

export interface StormProfile {
  name?: string;
}

export interface StormMessage {
  /**
   * Live link to the sender's per-user profile cell (forces element→doc).
   * Declared PerUser: a user-scoped link resolves to each READER's own
   * instance (scoped-cell-instances spec). An absent target reads as the
   * profile's declared default, keeping the required property and message
   * valid without exposing the author's private profile. The PerUser
   * declaration also satisfies the scope-isolation write guard.
   */
  authorProfile: PerUser<Cell<StormProfile>>;
  author: string;
  body: string;
  n: number;
}

const DEFAULT_MESSAGES: StormMessage[] = [];
const DEFAULT_PROFILE: StormProfile = { name: "" };

export interface PostEvent {
  author?: string;
  body?: string;
  n?: number;
}

const post = handler<PostEvent, {
  messages: Writable<StormMessage[]>;
  profile: Cell<StormProfile>;
}>((event, { messages, profile }) => {
  messages.push({
    authorProfile: profile,
    author: event?.author ?? "",
    body: event?.body ?? "",
    n: event?.n ?? 0,
  });
});

export interface ConvergenceChatInput {
  messages?: PerSpace<StormMessage[] | Default<typeof DEFAULT_MESSAGES>>;
  profile?: PerUser<StormProfile | Default<typeof DEFAULT_PROFILE>>;
}

export interface ConvergenceChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<StormMessage[] | Default<typeof DEFAULT_MESSAGES>>;
  profile: PerUser<StormProfile | Default<typeof DEFAULT_PROFILE>>;
  post: Stream<PostEvent>;
}

export default pattern<ConvergenceChatInput, ConvergenceChatOutput>(
  ({ messages, profile }) => {
    return {
      [NAME]: "Convergence storm fixture",
      [UI]: (
        <div>
          <span>convergence fixture (no derived readers)</span>
        </div>
      ),
      messages,
      profile,
      post: post({ messages, profile }),
    };
  },
);
