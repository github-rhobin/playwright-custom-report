# playwright-custom-report — custom HTML reporter

The report is written to `custom-report/index.html` (with `assets/`), designed to work when tests are started from the **VS Code / Cursor Playwright extension** as well as from the CLI.

## What is in this folder

| Path                                     | Purpose                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/reporter/custom-report.ts`         | Reporter implementation                                                                 |
| `src/reporter/custom-report-ui.js`      | Client script (copied into report `assets/` at run end)                                 |
| `src/reporter/custom-report-chrome.css` | Status strip / chrome styles for embedded viewers                                       |
| `playwright-repo-root.cjs`               | Stable repo root (`__dirname` of the shim; not `process.cwd()`)                         |
| `playwright.config.ts`                   | Registers the reporter with `repositoryRoot: PLAYWRIGHT_CONFIG_DIR`                     |
| `src/config/documentation-mode.ts`       | Local **documentation** toggle; when on, `takeScreenshot` attaches PNGs (CI always off) |
| `src/utils/screenshot-util.ts`           | `takeScreenshot(page, label)` — attach viewport PNG under the **current** `test.step`   |
| `src/utils/step-decorator-util.ts`       | `@step("Name")` — wraps page-object methods in `test.step` for the same hierarchy       |
| `tests/example.spec.ts`                  | Examples: inline `test.step` + screenshots, and `@step` on a small page class           |

### Step screenshots in the custom HTML report

Playwright nests **attachments** under the **step** that was active when `test.info().attach` ran. Use **`test.step`** (or the **`@step`** decorator) around actions, and call **`takeScreenshot`** inside that step so PNGs appear inline under it in `custom-report/index.html`.

Set **`DOCUMENTATION_MODE`** in `src/config/documentation-mode.ts` to `"on"` locally to record step PNGs; set to `"off"` for faster local runs. **`CI`** always disables documentation attachments regardless of that flag.

## Quick start

1. After cloning the repo, open it in your favorite IDE.
2. `npm install` (npm dependencies)
3. `npx playwright install` (plawright browsers)
4. `npm test` (run playwright test)
5. After the run finishes, open **`custom-report/index.html`** (absolute path is also printed in Test Output / terminal under `[custom-report]`).

Optional: `npm run report:custom` opens Playwright’s viewer for that folder (same as `playwright show-report custom-report`).

## Adopting into an existing project

1. Copy `src/reporter/` (all three reporter files), optionally **`src/utils/screenshot-util.ts`**, **`src/utils/step-decorator-util.ts`**, and a documentation toggle (here: **`src/config/documentation-mode.ts`**, or wire `takeScreenshot` to your own `base-config`).
2. Copy `playwright-repo-root.cjs` and merge the **reporter block** from `playwright.config.ts` into your config.
3. Add the `verify:custom-report-root` script from `package.json` (catches missing `repositoryRoot` wiring, reporter path, and `outputFolder` — same checks matter for **CLI** and **VS Code / Cursor Playwright extension** runs).
4. Add `custom-report/` to `.gitignore` if you do not want generated HTML committed.
5. Run `npm run verify:custom-report-root` after editing `playwright.config.ts`.

## Why `playwright-repo-root.cjs`?

The Playwright extension’s test host can use a **different `process.cwd()`** than a terminal run. Passing `repositoryRoot` from this file keeps output paths and asset resolution consistent.

**CLI and extension** both load the same `playwright.config.ts`, so the reporter entry `./src/reporter/custom-report.ts` and `outputFolder: "custom-report"` apply to terminal runs and to runs started from the VS Code / Cursor Testing panel.

## Troubleshooting

- **Report looks stale (old CSS/JS)** — Embedded viewers cache `report-ui.js` / `report-chrome.css` aggressively; hard-refresh or reopen `index.html`. Each run uses a cache-bust query on those assets.
- **Wrong folder / empty report** — Confirm `repositoryRoot: PLAYWRIGHT_CONFIG_DIR` is set and `playwright-repo-root.cjs` lives next to `playwright.config.ts`.
- **Do not confuse** Playwright’s default **`playwright-report/`** (Show HTML Report) with **`custom-report/`** — they are separate outputs.
