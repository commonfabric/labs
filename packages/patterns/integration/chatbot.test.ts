import {
  awaitViewSettled,
  createTestSpace,
  env,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForDisabled } from "./cfc-browser-helpers.ts";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { TEST_LLM } from "./flags.ts";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const ignore = !TEST_LLM;

// LLM tests are skipped in CI until we handle live provider calls in CI environments.
// This requires either:
// 1. Adding a flag to enable LLM tests in CI with proper API keys
// 2. Resurrecting the LLM cache functionality from toolshed
describe("Chat pattern test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let pieceId: string;
  let identity: Identity;
  let cc: PiecesController;

  if (!ignore) {
    beforeAll(async () => {
      identity = await Identity.generate({ implementation: "noble" });
      cc = await initializePiecesController({
        space: await createTestSpace(identity),
        apiUrl: new URL(API_URL),
        identity: identity,
      });
      const piece = await cc.create(
        await Deno.readTextFile(
          join(
            import.meta.dirname!,
            "..",
            "chatbot.tsx",
          ),
        ),
        { start: false },
      );
      pieceId = piece.id;
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });
  }

  it({
    name: "should load the Chat test piece and display initial UI",
    ignore,
    fn: async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceDid: cc.getSpace(),
          pieceId,
        },
        identity,
      });

      // Check for the message input
      const messageInput = await page.waitForSelector("cf-prompt-input", {
        strategy: "pierce",
      });
      assert(messageInput, "Should find message input element");

      // Check for clear chat button
      const clearButton = await page.waitForSelector("cf-button", {
        strategy: "pierce",
      });
      assert(clearButton, "Should find clear chat button");

      // Check for empty chat history (ul should exist but be empty initially)
      const chatHistory = await page.waitForSelector("cf-vscroll", {
        strategy: "pierce",
      });
      assert(chatHistory, "Should find chat history container");
    },
  });

  it({
    name: "should handle message input and add to chat history",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Find the message input component
      const messageInput = await page.waitForSelector("cf-prompt-input", {
        strategy: "pierce",
      });
      assert(messageInput, "Should find message input");

      // Look for the actual input element inside the message input component
      const inputElement = await page.waitForSelector("input", {
        strategy: "pierce",
      });
      assert(inputElement, "Should find input element");

      // Click to focus the input, then type the message
      await inputElement.click();
      const testMessage = "Hello, how are you?";
      await inputElement.type(testMessage);

      // The send button stays disabled until the typed value reaches the
      // prompt's state; wait for it to enable before clicking.
      await waitForDisabled(page, "#cf-prompt-input-send-button", false);

      // Click the send button by ID
      const sendButton = await page.waitForSelector(
        "#cf-prompt-input-send-button",
        {
          strategy: "pierce",
        },
      );
      assert(sendButton, "Should find send button");
      await sendButton.click();

      // Wait for the message to appear in chat history
      const chatHistory = await page.waitForSelector("cf-vscroll", {
        strategy: "pierce",
      });
      assert(chatHistory, "Should find chat history container");

      // Wait for user message to appear as cf-chat-message element
      const userMessage = await page.waitForSelector("cf-chat-message", {
        strategy: "pierce",
      });
      assert(userMessage, "Should find user message element");

      const messageText = await userMessage.evaluate((el: any) => el.content);

      assert(messageText, "Should find user message text");
      assert(
        messageText.includes(testMessage),
        `Should contain the user message "${testMessage}", got: "${messageText}"`,
      );
    },
  });

  it({
    name: "should display LLM response in chat history",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Wait for LLM response to appear (this may take some time)
      const chatHistory = await page.waitForSelector("cf-vscroll", {
        strategy: "pierce",
      });
      assert(chatHistory, "Should find chat history container");

      // Wait for assistant response (second cf-chat-message)
      await waitForCondition(
        page,
        (probe) => probe.collect("cf-chat-message").length >= 2,
      );

      // Get all chat messages using pierce strategy
      const allMessages = await page.$$("cf-chat-message", {
        strategy: "pierce",
      });
      assert(allMessages.length >= 2, "Should have at least 2 chat messages");

      // Get the assistant message (second message)
      const assistantText = await allMessages[1].evaluate((el: any) =>
        el.content || ""
      );

      assert(assistantText, "Should have response text");
      assert(
        assistantText.trim().length > 0,
        "Response should not be empty",
      );

      console.log("LLM Response:", assistantText);
    },
  });

  it({
    name: "should handle multiple messages in chat sequence",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Wait for the view to settle after the previous turn.
      await awaitViewSettled(page);

      // Ask a second question - need to refocus the input first
      const inputElement = await page.waitForSelector("input", {
        strategy: "pierce",
      });
      assert(inputElement, "Should find input element");

      // Focus and clear previous input, then type new message
      await inputElement.click(); // Focus the input
      await inputElement.evaluate((el: HTMLInputElement) => {
        el.value = "";
      });

      const secondMessage = "What is the capital of France?";
      await inputElement.type(secondMessage);

      // The send button stays disabled until the typed value reaches the
      // prompt's state; wait for it to enable before clicking.
      await waitForDisabled(page, "#cf-prompt-input-send-button", false);

      // Click the send button by ID
      const sendButton = await page.waitForSelector(
        "#cf-prompt-input-send-button",
        {
          strategy: "pierce",
        },
      );
      assert(sendButton, "Should find send button");
      await sendButton.click();

      // Wait for new assistant response - at least 4 messages total
      await waitForCondition(
        page,
        (probe) => probe.collect("cf-chat-message").length >= 4,
      );

      // Get all chat messages to verify sequence
      const chatMessages = await page.$$("cf-chat-message", {
        strategy: "pierce",
      });
      const messages = await Promise.all(
        chatMessages.map(async (msg) =>
          await msg.evaluate((el: any) => el.content || "")
        ),
      );

      // Should have at least 4 messages (user1, assistant1, user2, assistant2)
      assert(
        messages.length >= 4,
        `Should have at least 4 messages, got ${messages.length}`,
      );

      // Verify the second user message is present
      const hasSecondUserMessage = messages.some((msg: string) =>
        msg.includes(secondMessage)
      );
      assert(
        hasSecondUserMessage,
        "Should find second user message in chat history",
      );

      console.log("Chat history:", messages);
    },
  });

  it({
    name: "should clear chat history when clear button is clicked",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Verify we have messages before clearing
      const messagesBefore = await page.$$("cf-chat-message", {
        strategy: "pierce",
      });
      assert(messagesBefore.length > 0, "Should have messages before clearing");

      // Find and click the clear chat button by its unique ID
      const clearButton = await page.waitForSelector("#clear-chat-button", {
        strategy: "pierce",
      });
      assert(clearButton, "Should find clear chat button");
      await clearButton.click();

      // Wait for chat to clear
      await waitForCondition(
        page,
        (probe) => probe.collect("cf-chat-message").length === 0,
      );

      // Verify chat history is now empty
      const messagesAfter = await page.$$("cf-chat-message", {
        strategy: "pierce",
      });
      assertEquals(
        messagesAfter.length,
        0,
        "Chat history should be empty after clearing",
      );
    },
  });
});
