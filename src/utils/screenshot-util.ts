import { documentationModeEffective } from "../config/documentation-mode";
import { test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";


function safeAttachFileName(title: string): string {
  const base = title.replace(/[^\w\-]+/g, "_").slice(0, 72);
  return `${base || "screenshot"}-${randomUUID().slice(0, 8)}.png`;
}


/**
 * Attach a viewport PNG to the **current** Playwright test (`test.info().attach`).
 * Use inside `test.step` so the custom HTML reporter shows the image under that step.
 *
 * When {@link documentationModeEffective} is `false` (normal / CI runs), this is a **no-op**.
 * When documentation mode is on locally, each call attaches a PNG.
 *
 * Does not throw if the page is closed or capture fails.
 */
export async function takeScreenshot(
  page: Page,
  label = "screenshot",
): Promise<void> {
  if (!documentationModeEffective()) {
    return;
  }
  try {
    const buffer = await page.screenshot({ fullPage: false });
    await test.info().attach(safeAttachFileName(label), {
      body: buffer,
      contentType: "image/png",
    });
  } catch {
    // Closed page or transient screenshot failure — never fail the test for artifacts
  }
}