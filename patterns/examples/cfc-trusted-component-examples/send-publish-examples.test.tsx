import { assert, handler, pattern, TESTS } from "commonfabric";
import {
  ChatThreadSendExample,
  DirectMessageSendExample,
  HostLookalikeControlExample,
  ProjectUpdatePublishExample,
  SEND_PUBLISH_EXAMPLE_COUNT,
  SEND_PUBLISH_RENDERED_EXAMPLE_COUNT,
} from "./send-publish-examples.tsx";

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

  return {
    [TESTS]: [
      { action: runChatThread({ suite: chatThread }) },
      { assertion: assertChatThread },
      { action: runProjectUpdate({ suite: projectUpdate }) },
      { assertion: assertProjectUpdate },
      { action: runLookalike({ lookalike, directMessage }) },
      { assertion: assertLookalike },
      { assertion: assertGalleryRendersCatalog },
    ],
    chatThread,
    projectUpdate,
    lookalike,
    directMessage,
  };
});
