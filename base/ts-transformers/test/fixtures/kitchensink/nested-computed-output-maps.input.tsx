/**
 * FIXTURE: nested-computed-output-maps
 * Verifies: nested computed outputs can flow back into later pattern-owned
 * maps while their inner compute-owned array maps stay plain, and callback
 * captures survive across multiple cloned callbacks.
 * Expected transform:
 * - laneLabels.map(...) lowers after calling a module-scope lift in pattern context
 * - visibleThreads.map(...), visibleComments.map(...), comment.reactions.map(...),
 *   and plainSeparators.map(...) remain plain Array.map() calls inside computed()
 * - liftedSeparators.map(...) lowers after calling that same module-scope lift
 *   inside the current compute callback
 * - reboundComments.map(...) lowers because a nested computed() re-wraps the
 *   local array inside the current compute callback
 * - threadRows.map(...) lowers once the flow re-enters pattern-owned UI
 * - closures preserve thread/comment indices, state.lane, and local Writables
 */

import {
  computed,
  handler,
  ifElse,
  lift,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface Comment {
  id: string;
  text: string;
  flagged: boolean;
  reactions: string[];
}

interface Thread {
  id: string;
  title: string;
  muted: boolean;
  comments: Comment[];
}

// [TRANSFORM] handler: event schema (true=unknown) and state schema injected
const jumpToComment = handler<unknown, {
  selectedCommentId: string | undefined;
  threadId: string;
  commentId: string;
  lane: string;
  outerIndex: number;
  innerIndex: number;
}>((_event, state) => state);

// [TRANSFORM] lift: input and output schemas injected
const passthroughLabels = lift((labels: string[]) => labels);

// [TRANSFORM] pattern: type param stripped; input+output schemas appended after callback
export default pattern<{
  threads: Thread[];
  lane: string;
  showFlagged: boolean;
}>((state) => {
  // [TRANSFORM] new Writable: schema arg injected; undefined default added for optional type
  const selectedCommentId = new Writable<string | undefined>();
  const laneLabels = passthroughLabels(["lane", "detail", "summary"]);

  // [TRANSFORM] computed() → lift(): captures state.threads, state.showFlagged
  const visibleThreads = computed(() =>
    // [TRANSFORM] .map() stays plain: state.threads is a captured input, plain inside this computed
    state.threads.map((thread, outerIndex) => ({
      thread,
      outerIndex,
      visibleComments: state.showFlagged
        ? thread.comments.filter((comment) => comment.flagged)
        : thread.comments,
    }))
  );

  // [TRANSFORM] computed() → lift(): captures visibleThreads (asOpaque), selectedCommentId (asCell — Writable), state.lane
  const threadRows = computed(() =>
    // [TRANSFORM] .map() stays plain: visibleThreads is a captured input, plain inside this computed
    visibleThreads.map(({ thread, outerIndex, visibleComments }) => {
      // [TRANSFORM] .map() stays plain: ["top","bottom"] is a literal array
      const plainSeparators = ["top", "bottom"].map((edge) =>
        `${thread.title}-${edge}`
      );
      const liftedSeparators = passthroughLabels(plainSeparators);
      // [TRANSFORM] computed() → lift() (nested): captures visibleComments from outer computed scope
      const reboundComments = computed(() => visibleComments);

      return (
        <article>
          <h2>{thread.title}</h2>
          {/* [TRANSFORM] .map() stays plain: visibleComments is destructured from captured computed input */}
          {visibleComments.map((comment, innerIndex) => (
            <div>
              <button
                type="button"
                onClick={jumpToComment({
                  selectedCommentId,
                  threadId: thread.id,
                  commentId: comment.id,
                  lane: state.lane,
                  outerIndex,
                  innerIndex,
                })}
              >
                {comment.flagged
                  ? <strong>{comment.text}</strong>
                  : /* [TRANSFORM] ifElse: schema-injected authored ifElse(thread.muted, ..., ...) */
                  ifElse(
                    thread.muted,
                    <em>{comment.text}</em>,
                    <span>{comment.text}</span>,
                  )}
              </button>
              {/* [TRANSFORM] .map() stays plain: comment.reactions is compute-owned nested array data */}
              {comment.reactions.map((reaction, reactionIndex) => (
                <span>
                  {reactionIndex === innerIndex
                    ? `${state.lane}:${reaction}`
                    : reaction}
                </span>
              ))}
            </div>
          ))}
          {/* [TRANSFORM] .map() → mapWithPattern: reboundComments is output of nested computed() — reactive even inside outer computed */}
          {/* [TRANSFORM] closure captures: outerIndex (via params opaque), state.lane (via params reactive .key()) */}
          {reboundComments.map((comment, reboundIndex) => (
            <aside>
              {reboundIndex === outerIndex
                ? `${state.lane}:${comment.id}`
                : comment.text}
            </aside>
          ))}
          {/* [TRANSFORM] .map() → mapWithPattern: liftedSeparators is output of lift() — reactive even inside outer computed */}
          {/* [TRANSFORM] closure captures: outerIndex (via params opaque), state.lane (via params reactive .key()) */}
          {liftedSeparators.map((edge, edgeIndex) => (
            <small>
              {edgeIndex === outerIndex ? `${state.lane}:${edge}` : edge}
            </small>
          ))}
          {/* [TRANSFORM] .map() stays plain: plainSeparators is a local literal array */}
          {plainSeparators.map((edge) => <small>{edge}</small>)}
        </article>
      );
    })
  );

  return {
    [UI]: (
      <div>
        {/* [TRANSFORM] .map() → mapWithPattern: laneLabels is output of lift() in pattern context — reactive */}
        {/* [TRANSFORM] ternary lowered: labelIndex===0 ? `${state.lane}:${label}` : label → ifElse(lift(cond), lift(true-branch), label) */}
        {laneLabels.map((label, labelIndex) => (
          <header data-lane-label={labelIndex}>
            {labelIndex === 0 ? `${state.lane}:${label}` : label}
          </header>
        ))}
        {/* [TRANSFORM] .map() → mapWithPattern: threadRows is output of computed() — reactive, back in pattern-owned UI */}
        {threadRows.map((row, rowIndex) => (
          <section data-row={rowIndex}>{row}</section>
        ))}
      </div>
    ),
  };
});
