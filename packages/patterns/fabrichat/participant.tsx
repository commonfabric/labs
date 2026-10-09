/** A participant's live profile and their reviewed direct-chat control. */
import {
  type Cell,
  computed,
  pattern,
  principalOf,
  spaceAccess,
  type Stream,
  UI,
  type VNode,
} from "commonfabric";
import type { ChatProfile, ManagerStreamEvent } from "./schemas.tsx";

/** The participant, viewer, and the viewer's own direct-chat writer. */
export interface ParticipantChipInput {
  participant: Cell<ChatProfile>;
  myProfile?: Cell<ChatProfile>;
  startDirect?: Stream<ManagerStreamEvent>;
}

/** Shows the profile while withholding Chat for unreadable or unclaimed people. */
export const ParticipantChip = pattern<ParticipantChipInput, { [UI]: VNode }>(
  ({ participant, myProfile, startDirect }) => {
    const counterpart = computed(() => {
      const access = spaceAccess(participant);
      return access === "READ" || access === "WRITE" || access === "OWNER"
        ? principalOf(participant, "represents-principal")
        : undefined;
    });
    const canStart = computed(() =>
      startDirect !== undefined && counterpart !== undefined &&
      counterpart !== principalOf(myProfile, "represents-principal")
    );
    return {
      [UI]: (
        <cf-hstack gap="1" align="center">
          <cf-profile-badge $profile={participant} variant="chip" />
          <div
            hidden
            data-ui-pattern="ChatStartSurface"
            data-ui-event-integrity="ChatStartSurface"
            style={{ display: canStart ? "inline-flex" : "none" }}
          >
            <cf-button
              data-ui-action="ChatStart"
              $name={participant}
              onClick={startDirect}
            >
              Chat
            </cf-button>
          </div>
        </cf-hstack>
      ),
    };
  },
);
