import { assert, handler, NAME, pattern, TESTS, UI } from "commonfabric";
import Gallery, {
  ChatThreadSendExample,
  DirectMessageSendExample,
  HostLookalikeControlExample,
  ProjectUpdatePublishExample,
  SEND_PUBLISH_EXAMPLE_COUNT,
  SEND_PUBLISH_RENDERED_EXAMPLE_COUNT,
} from "./send-publish-examples.tsx";
import {
  childNodes,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";

/** The text of the gallery's card at `index`: the first introduces the
 * gallery and the second is its catalog. Reached by position, since a search
 * would also walk every example the gallery renders. */
const cardText = (view: unknown, index: number): string =>
  textContent(childNodes(childNodes(view)[0])[index]);

const numbered = (titles: readonly string[]): string =>
  "Catalog" + titles.map((title, index) => `${index + 1}. ${title}`).join("");

type ChatThreadSuite = ReturnType<typeof ChatThreadSendExample>;
type DirectMessageSuite = ReturnType<typeof DirectMessageSendExample>;
type ProjectUpdateSuite = ReturnType<typeof ProjectUpdatePublishExample>;
type LookalikeSuite = ReturnType<typeof HostLookalikeControlExample>;

const runChatThread = handler<void, { suite: ChatThreadSuite }>(
  (_, { suite }) => {
    suite.triggerDecoy.send();
    suite.sendMessage?.send();
  },
);

const runProjectUpdate = handler<void, { suite: ProjectUpdateSuite }>(
  (_, { suite }) => {
    suite.triggerDecoy.send();
    suite.prepareAudiencePublish?.send();
    suite.publishAudiencePost?.send();
  },
);

const runLookalike = handler<void, {
  lookalike: LookalikeSuite;
  directMessage: DirectMessageSuite;
}>((_, { lookalike, directMessage }) => {
  lookalike.triggerDecoy.send();
  directMessage.triggerDecoy.send();
  directMessage.captureCommand?.send();
  directMessage.prepareBrief?.send();
  directMessage.authorizeSend?.send();
});

export default pattern(() => {
  const gallery = Gallery({});
  const chatThread = ChatThreadSendExample({});
  const projectUpdate = ProjectUpdatePublishExample({});
  const lookalike = HostLookalikeControlExample({});
  const directMessage = DirectMessageSendExample({});

  const assertChatThread = assert(() =>
    chatThread.decoyResult ===
      "Host shortcut ignored; only the trusted send surface counts." &&
    chatThread.sentMessage!.includes(
      "Sent in Chat thread: project sync to team thread",
    )
  );

  const assertProjectUpdate = assert(() =>
    projectUpdate.decoyResult ===
      "Project publish banner is only decorative." &&
    projectUpdate.preparedAudiencePublish!.includes("project board") &&
    projectUpdate.publishedAudiencePost ===
      projectUpdate.preparedAudiencePublish
  );

  const assertLookalike = assert(() =>
    lookalike.decoyResult ===
      "Lookalike host control updated, not the protected output." &&
    directMessage.decoyResult ===
      "Untrusted DM button does not authorize sending." &&
    directMessage.capturedCommand ===
      "Send the short summary to the client contact." &&
    directMessage.preparedBrief!.includes("Prepared outbound draft") &&
    directMessage.authorizedSend!.includes("Authorized outbound message")
  );
  const assertGalleryRendersCatalog = assert(() =>
    SEND_PUBLISH_EXAMPLE_COUNT === 30 &&
    SEND_PUBLISH_RENDERED_EXAMPLE_COUNT === SEND_PUBLISH_EXAMPLE_COUNT
  );

  // The catalog lists each example under the name it goes by, so reading it
  // reads every example's name.
  const assert_gallery_catalog = assert(() =>
    gallery[NAME] === "Send / Publish Trusted Component Examples" &&
    gallery.exampleCount === SEND_PUBLISH_EXAMPLE_COUNT &&
    gallery.renderedExampleCount === SEND_PUBLISH_EXAMPLE_COUNT &&
    cardText(gallery[UI], 1) === numbered([
        "Chat Thread Send",
        "Incident Channel Send",
        "Direct Message Send",
        "Support Case Reply",
        "Classroom Announcement",
        "Project Update Publish",
        "Release Notes Publish",
        "Public Status Publish",
        "Internal Repost",
        "Team Digest Publish",
        "Roadmap Update Publish",
        "Incident Summary Publish",
        "Policy Publish",
        "Changelog Publish",
        "Launch Readiness Publish",
        "Embedded Composer Send",
        "Team Digest Context Send",
        "Executive Brief Send",
        "Support Escalation Send",
        "Customer Reply Send",
        "Classroom Digest Send",
        "Internal Only Repost",
        "Public Bulletin",
        "Staged Announcement",
        "Announcement Queue",
        "Visible Queue",
        "Conversation Target Send",
        "Host Lookalike Control",
        "Internal Note Repost",
        "Meeting Recap Publish",
      ])
  );

  return {
    [TESTS]: [
      { action: runChatThread({ suite: chatThread }) },
      { assertion: assertChatThread },
      { action: runProjectUpdate({ suite: projectUpdate }) },
      { assertion: assertProjectUpdate },
      { action: runLookalike({ lookalike, directMessage }) },
      { assertion: assertLookalike },
      { assertion: assertGalleryRendersCatalog },
      { assertion: assert_gallery_catalog },
    ],
    chatThread,
    projectUpdate,
    lookalike,
    directMessage,
  };
});
