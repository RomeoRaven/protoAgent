import { expect, test } from "@playwright/test";

import { PROMPT_CALL } from "./fixtures.mjs";

// "View prompt" (#2243): a settled assistant turn exposes the EXACT system
// prompt its model calls received (served from /api/prompts/{taskId} — the
// mock stamps every canned turn task-e2e-1), and /prompt drops the last
// captured call into the thread as an ephemeral system note.

async function send(page, prompt: string) {
  const composer = page.getByPlaceholder(/Message protoAgent/i);
  await composer.waitFor({ state: "visible" });
  await composer.fill(prompt);
  await composer.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await expect(page.getByPlaceholder(/Message protoAgent/i)).toBeVisible();
});

test("View prompt opens the captured system prompt for the turn", async ({ page }) => {
  await send(page, "hello there");
  const assistant = page.locator(".pl-message--assistant").last();
  await expect(assistant.locator(".markdown")).toContainText("Done — found 8 results.");

  await assistant.getByRole("button", { name: "View prompt" }).click();

  // The DocumentViewer host opens with the raw captured text — stable prefix
  // AND the volatile tail, i.e. byte-for-byte what the model received.
  const viewer = page.locator(".doc-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("System prompt")).toBeVisible();
  const text = viewer.locator(".prompt-viewer__text");
  await expect(text).toContainText("SOUL: mock stable prefix");
  await expect(text).toContainText("The operator prefers dark mode.");
  // The meta strip carries the call's model + real usage.
  await expect(viewer.getByText(PROMPT_CALL.model)).toBeVisible();
  await expect(viewer.getByText(/cache read 1\.0k/)).toBeVisible();
});

test("/prompt drops the last captured call as an ephemeral system note", async ({ page }) => {
  await send(page, "warm the session up");
  await expect(page.locator(".pl-message--assistant").last().locator(".markdown")).toContainText(
    "Done — found 8 results.",
  );

  await send(page, "/prompt");

  // The note is client-store-only (never a user/assistant bubble): headed by
  // the System prompt label and containing the fenced captured text.
  const note = page.locator(".pl-message--system").last();
  await expect(note).toContainText("System prompt");
  await expect(note).toContainText("SOUL: mock stable prefix");
  await expect(note).toContainText("not saved to the conversation");
});
