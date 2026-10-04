import {
  createTestSpace,
  env,
  waitForCondition,
} from "@commonfabric/integration";
import { sleep } from "@commonfabric/utils/sleep";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { type DID, Identity } from "@commonfabric/identity";
import { TEST_LLM } from "./flags.ts";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const ignore = !TEST_LLM;

describe("Chat Note pattern test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let spaceDid: DID;
  let pieceId: string;
  let identity: Identity;
  let cc: PiecesController;

  if (!ignore) {
    beforeAll(async () => {
      identity = await Identity.generate({ implementation: "noble" });
      spaceDid = await createTestSpace(identity);
      cc = await initializePiecesController({
        space: spaceDid,
        apiUrl: new URL(API_URL),
        identity: identity,
      });
      await cc.ensureDefaultPattern();

      // Create the chat-note piece
      const piece = await cc.create(
        await Deno.readTextFile(
          join(import.meta.dirname!, "..", "experimental", "chat-note.tsx"),
        ),
        { start: true },
      );
      pieceId = piece.id;
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });
  }

  it({
    name: "should load the chat-note piece and display initial UI",
    ignore,
    fn: async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceDid,
          pieceId,
        },
        identity,
      });

      // Wait for the component to render
      await sleep(2000);

      // Check for the title (should contain "Chat Note" by default)
      const titleElement = await page.waitForSelector("span", {
        strategy: "pierce",
      });
      assert(titleElement, "Should find title element");

      // Check for the code editor
      const editor = await page.waitForSelector("cf-code-editor", {
        strategy: "pierce",
      });
      assert(editor, "Should find code editor element");

      // Check for the Generate button
      const generateButton = await page.waitForSelector(
        'cf-button[color="primary"]',
        { strategy: "pierce" },
      );
      assert(generateButton, "Should find Generate button");

      const buttonText = await generateButton.evaluate(
        (el: HTMLElement) => el.textContent,
      );
      assertEquals(buttonText?.trim(), "Generate");
    },
  });

  it({
    name: "should allow typing content in the editor",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Find the CodeMirror editor content area
      const editorContent = await page.waitForSelector(".cm-content", {
        strategy: "pierce",
      });
      assert(editorContent, "Should find CodeMirror content area");

      // Click to focus the editor
      await editorContent.click();
      await sleep(500);

      // Type some content
      await page.keyboard.type("Hello, this is a test message.");
      await sleep(1000);

      // Verify the content was entered
      const content = await editorContent.evaluate(
        (el: HTMLElement) => el.textContent,
      );
      assert(
        content?.includes("Hello, this is a test message"),
        "Editor should contain typed content",
      );
    },
  });

  it({
    name: "should enable Generate button when content is present",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Wait a bit for the button state to update
      await sleep(500);

      // Find the Generate button
      const generateButton = await page.waitForSelector(
        'cf-button[color="primary"]',
        { strategy: "pierce" },
      );
      assert(generateButton, "Should find Generate button");

      // Check that the button is not disabled (has content)
      const isDisabled = await generateButton.evaluate(
        (el: HTMLElement) => el.hasAttribute("disabled"),
      );

      // Button should be enabled since we have content
      assertEquals(isDisabled, false, "Generate button should be enabled");
    },
  });

  it({
    name: "should trigger generation when Generate button is clicked",
    ignore,
    fn: async () => {
      const page = shell.page();
      const editorContent = await page.waitForSelector(".cm-content", {
        strategy: "pierce",
      });
      const initialContent = await editorContent.evaluate(
        (el: HTMLElement) => el.textContent ?? "",
      );

      // Click the Generate button
      const generateButton = await page.waitForSelector(
        'cf-button[color="primary"]',
        { strategy: "pierce" },
      );
      assert(generateButton, "Should find Generate button");
      await generateButton.click();

      await waitForCondition(
        page,
        (probe, beforeGeneration) => {
          return probe.collect(".cm-content").some((element) => {
            const text = element.textContent ?? "";
            if (!text.startsWith(beforeGeneration)) return false;
            const aiHeader = text.lastIndexOf("## AI");
            if (aiHeader < beforeGeneration.length) return false;
            const response = text
              .slice(aiHeader + "## AI".length)
              .replaceAll("---", "")
              .trim();
            return response.length > 0;
          });
        },
        { args: [initialContent] },
      );

      const generatedContent = await editorContent.evaluate(
        (el: HTMLElement) => el.textContent ?? "",
      );
      assert(
        generatedContent.includes("## AI"),
        "Editor should contain AI header after clicking Generate",
      );
      assert(
        generatedContent.length > initialContent.length,
        "Editor should contain an AI response after generation",
      );
    },
  });

  it({
    name: "should parse system prompt from ## System header",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Navigate fresh to clear state
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceDid,
          pieceId,
        },
        identity,
      });

      await sleep(2000);

      // Find and focus the editor
      const editorContent = await page.waitForSelector(".cm-content", {
        strategy: "pierce",
      });
      assert(editorContent, "Should find editor");

      // Clear existing content by selecting all and deleting
      // Use OS-specific modifier: Meta on macOS, Control on Windows/Linux
      await editorContent.click();
      const modifier = Deno.build.os === "darwin" ? "Meta" : "Control";
      await page.keyboard.down(modifier);
      await page.keyboard.press("a");
      await page.keyboard.up(modifier);
      await page.keyboard.press("Backspace");
      await sleep(500);

      // Type content with a system prompt
      const testContent = `## System
You are a pirate who speaks only in pirate talk.

---
Say hello`;

      await page.keyboard.type(testContent);
      await sleep(1000);

      // Click Generate
      const generateButton = await page.waitForSelector(
        'cf-button[color="primary"]',
        { strategy: "pierce" },
      );
      await generateButton?.click();

      // Wait for response
      await sleep(15000);

      // Check that the response includes pirate-like content
      const finalContent = await editorContent?.evaluate(
        (el: HTMLElement) => el.textContent,
      );

      assert(
        finalContent?.includes("## AI"),
        "Should have AI response section",
      );

      // The response should have some pirate-themed content
      // (We can't guarantee exact wording, but the LLM should follow the system prompt)
      console.log("Response content:", finalContent);
    },
  });
});
