"use strict";
/**
 * Repo root (directory containing this file). Used from `playwright.config.ts` so paths stay identical for
 * `npx playwright test` and the VS Code / Cursor Playwright extension — unlike `process.cwd()`, `__dirname`
 * here does not depend on the test host working directory.
 */
const path = require("node:path");
module.exports = path.dirname(path.resolve(__filename));