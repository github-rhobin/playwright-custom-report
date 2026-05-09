import { expect, test, type Page } from "@playwright/test";
import { takeScreenshot } from "../src/utils/screenshot-util";
import { step } from "../src/utils/step-decorator-util";

test(
  "inline test.step() + takeScreenshot()",
  { tag: ["@plain-style"] },
  async ({ page }) => {
    await test.step("Open Playwright site", async () => {
      await page.goto("https://playwright.dev/");
      await takeScreenshot(page, "after_nav");
    });

    await test.step("Check title", async () => {
      await expect(page).toHaveTitle(/Playwright/);
      await takeScreenshot(page, "after_title_assert");
    });
  },
);

/** Page-object style: {@link step} wraps methods in `test.step` for the same report structure. */
class PlaywrightDocsPage {
  constructor(private readonly page: Page) {}

  @step("Open Playwright docs home")
  async openHome() {
    await this.page.goto("https://playwright.dev/");
    await takeScreenshot(this.page, "decorated_after_nav");
  }

  @step("Verify branding in title")
  async expectTitle() {
    await expect(this.page).toHaveTitle(/Playwright/);
    await takeScreenshot(this.page, "decorated_after_assert");
  }
}

test(
  "step() decorator + takeScreenshot() + page object class",
  { tag: ["@page-object-style"] },
  async ({ page }) => {
    const docs = new PlaywrightDocsPage(page);
    await docs.openHome();
    await docs.expectTitle();
  },
);

test(
  "to-fail test + trace.zip",
  { tag: ["@plain-style"] },
  async ({ page }) => {
    await test.step("Open Playwright site", async () => {
      await page.goto("https://playwright.dev/");
      await takeScreenshot(page, "after_nav");
    });

    await test.step("Check title", async () => {
      await expect(page).toHaveTitle(/FailThisTitleAssertion/);
      await takeScreenshot(page, "after_title_assert");
    });
  },
);
