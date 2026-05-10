/** * Custom HTML report: each Playwright {@link TestStep} renders with its own attachments * (e.g. step screenshots) directly underneath — not in a separate gallery. Per-attempt video and trace ZIP * from {@link TestResult} are linked in the attempt header row when present. Client behavior is shipped as * `assets/report-ui.js` and `assets/report-chrome.css` (cache-busted) so VS Code / Cursor Simple Browser * (no inline script; aggressive CSS cache on inline styles) still matches CLI runs. */ import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  FullConfig,
  FullResult,
  Location,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

type ReporterOptions = {
  /**   * Output directory for `index.html` and `assets/`. May be relative to `repositoryRoot` / `configDir`, or   * absolute.   */ outputFolder?: string;
  /**   * Directory containing `playwright.config.ts`. Playwright merges this into reporter options; used when   * `repositoryRoot` is not set.   */ configDir?: string;
  /**   * Absolute path to the repo root (directory containing `playwright.config.*`). **Set this from   * `playwright.config.ts` via `path.dirname(fileURLToPath(import.meta.url))`** so the custom report output path   * matches for `npx playwright test` and for the VS Code / Cursor Playwright extension (test host `cwd`   * differs). When set, on-disk discovery in {@link onBegin} is skipped.   */ repositoryRoot?: string;
};

type StepModel = {
  title: string;
  category: string;
  duration: number;
  failed: boolean;
  errorMessage?: string;
  imageSrcs: string[];
  /** JSON / text attachments shown inline (like screenshots). */
  codeBlocks: { label: string; text: string }[];
  otherAttachments: { label: string; href: string }[];
  children: StepModel[];
  /** Call site from Playwright (when available). */ location?: {
    file: string;
    line: number;
    column: number;
  };
  /** Few lines of source around {@link StepModel.location} for code preview. */ sourceSnippet?: string;
};

type AttemptModel = {
  /** Playwright `result.retry` (0 = first run). */ retry: number;
  status: TestResult["status"];
  duration: number;
  errorSnippet?: string;
  videoRel?: string;
  /** Copied from Playwright's `trace` {@link TestResult} attachment (ZIP), when present. */ traceRel?: string;
  steps: StepModel[];
};

/** One logical test; attempts include retries (Playwright-style tabs). */ type GroupedRunModel =
  {
    suitePath: string;
    title: string;
    location: string;
    project: string;
    /** Final outcome after all retries. */ outcome: ReturnType<
      TestCase["outcome"]
    >;
    /** Status of the last attempt. */ finalStatus: TestResult["status"];
    totalDuration: number;
    tags: string[];
    searchText: string;
    attempts: AttemptModel[];
  };

function projectName(test: TestCase): string {
  let s: Suite | undefined = test.parent;
  while (s) {
    const pr = s.project();
    if (pr?.name) return pr.name;
    s = s.parent;
  }
  return "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strip terminal ANSI codes from Playwright error text so HTML shows plain text (no ☐ / [31m junk). */
function stripAnsi(s: string): string {
  return (
    s
      // CSI sequences (colors, bold, etc.)
      .replace(/\u001b\[[\d;?]*[ -/]*[@-~]/g, "")
      // OSC sequences (e.g. hyperlinks)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // Stray ESC / SS2 / SS3
      .replace(/[\u001b\u009b\u009c\u009d\u009e\u009f]/g, "")
      // Orphaned SGR fragments if ESC was lost or replaced
      .replace(/\[(?:\d{1,4};)*\d{1,4}m/g, "")
  );
}

/** Locale date/time for report header (e.g. `5/7/2026, 11:25:58 AM`). */
function formatReportDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}
/** * Wall-clock duration from Playwright {@link FullResult.duration}. * From 1 minute upward: `1m 52s`; below: whole seconds or one decimal. */ function formatWallClockDuration(
  ms: number,
): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms >= 60_000) {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }
  const sec = ms / 1000;
  const rounded = Math.round(sec * 10) / 10;
  return rounded % 1 === 0 ? `${Math.round(rounded)}s` : `${rounded}s`;
}

/** Step / attempt durations: `ms` under 1 minute; `1m 30s` style from 1 minute up. */ function formatStepDuration(
  ms: number,
): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms >= 60_000) {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }
  return `${Math.round(ms)}ms`;
}

/** Inline SVGs for banner row (match monocart-style calendar + clock metaphor). */ const BANNER_ICON_CALENDAR = `<svg class="banner-svg-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;

const BANNER_ICON_CLOCK = `<svg class="banner-svg-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;

function suitePath(test: TestCase): string {
  const parts: string[] = [];
  let p: Suite | undefined = test.parent;
  while (p) {
    if (p.title) parts.unshift(p.title);
    p = p.parent;
  }
  return parts.join(" › ") || "Tests";
}

function isImageAttachment(contentType: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(contentType);
}

/** Step screenshot: MIME or common file extension (Playwright often omits contentType). */ function isStepScreenshotAttachment(
  contentType: string | undefined,
  name: string,
): boolean {
  if (isVideoAttachment(contentType ?? "", name)) return false;
  if (isImageAttachment(contentType ?? "")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

function isVideoAttachment(contentType: string, name: string): boolean {
  if (contentType && /^video\//i.test(contentType)) return true;
  return /\.(webm|mp4|ogg|ogv)$/i.test(name);
}

/** Playwright attaches the trace as a top-level {@link TestResult} attachment (ZIP). */ function isTraceAttachment(
  contentType: string | undefined,
  name: string,
): boolean {
  const n = name.trim().toLowerCase();
  if (n === "trace") return true;
  if (/^application\/zip/i.test(contentType ?? "") && /\.zip$/i.test(name))
    return true;
  return /(^|[^/])trace[^/]*\.zip$/i.test(name.replace(/\\/g, "/"));
}

/** Inline monospace block for JSON and similar text (not as a separate download link). */
function isInlineCodeAttachment(
  contentType: string | undefined,
  name: string,
): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (/^application\/(.*\+)?json\b/i.test(ct)) return true;
  if (ct.startsWith("text/") && /\.json$/i.test(name)) return true;
  if (/\.json$/i.test(name)) return true;
  return false;
}

const MAX_INLINE_CODE_CHARS = 500_000;

function attachmentBodyToUtf8(body: Buffer | string): string {
  return typeof body === "string" ? body : body.toString("utf8");
}

function prettyJsonIfPossible(raw: string): string {
  const t = raw.trim();
  if (!t) return raw;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return raw;
  }
}

function collectStepTitles(steps: StepModel[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    out.push(s.title);
    out.push(...collectStepTitles(s.children));
  }
  return out;
}

/** Step file paths for search (matches Playwright source locations in nested steps). */ function collectStepLocations(
  steps: StepModel[],
): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.location?.file) {
      out.push(s.location.file);
      out.push(path.basename(s.location.file));
    }
    out.push(...collectStepLocations(s.children));
  }
  return out;
}

function buildSearchText(parts: string[]): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Lines of context above/below the active line (stable max ≈ 3 lines like Playwright’s HTML report). */ const SOURCE_SNIPPET_CONTEXT_BEFORE = 1;
const SOURCE_SNIPPET_CONTEXT_AFTER = 1;
/** Filenames Playwright looks for when resolving a config directory (see Playwright configLoader). */ const PLAYWRIGHT_CONFIG_FILENAMES =
  [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mts",
    "playwright.config.mjs",
    "playwright.config.cts",
    "playwright.config.cjs",
  ] as const;

function directoryContainsPlaywrightConfig(dir: string): boolean {
  const root = path.resolve(dir);
  return PLAYWRIGHT_CONFIG_FILENAMES.some((name) =>
    existsSync(path.join(root, name)),
  );
}

export default class CustomReport implements Reporter {
  private readonly outputFolder: string;
  /**   * Directory containing `playwright.config.*` — used for `./custom-report`, `src/reporter/…`, and   * resolving relative test `Location.file` paths. Resolved in {@link onBegin} so VS Code / Cursor runs   * (where `process.cwd()` and even reporter `configDir` can disagree with the repo) still write next to   * the real config when we discover it on disk.   */ private configDir: string;
  /** `configDir` from reporter ctor options (Playwright-injected); anchor for relative `config.configFile`. */ private readonly injectedConfigDir: string;
  /** When set from `playwright.config.ts`, {@link onBegin} does not re-resolve `configDir` from the host. */ private readonly lockRepositoryRoot: boolean;
  private readonly runs: Array<{ test: TestCase; result: TestResult }> = [];

  constructor(options: ReporterOptions = {}) {
    const explicitRoot = options.repositoryRoot?.trim();
    if (explicitRoot) {
      this.lockRepositoryRoot = true;
      this.injectedConfigDir = path.resolve(explicitRoot);
    } else {
      this.lockRepositoryRoot = false;
      this.injectedConfigDir = path.resolve(options.configDir ?? process.cwd());
    }
    this.outputFolder = options.outputFolder ?? "./custom-report";
    this.configDir = this.injectedConfigDir;
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    // Use the resolved config file directory first. The VS Code Playwright extension often runs the
    // test host with a different `process.cwd()` than the terminal; `config.configFile` still points
    // at the real `playwright.config.*`, so output and asset paths match `npx playwright test`.
    const cf = config.configFile?.trim();
    if (cf) {
      try {
        const absCfg = path.isAbsolute(cf)
          ? cf
          : path.resolve(this.injectedConfigDir, cf);
        const cfgDir = path.dirname(absCfg);
        if (directoryContainsPlaywrightConfig(cfgDir)) {
          this.configDir = path.resolve(cfgDir);
          return;
        }
      } catch {
        /* invalid path from test host */
      }
    }
    if (!this.lockRepositoryRoot) {
      this.configDir = this.resolvePlaywrightConfigDirectory(config);
    }
  }

  /**
   * Resolves the folder that contains `playwright.config.*`. The Playwright VS Code/Cursor extension often
   * runs the test host with a different `process.cwd()` than a repo terminal; reporter `configDir` can still
   * be wrong in edge builds. We therefore prefer an on-disk discovery from several absolute seeds derived
   * from the resolved config (config file path, rootDir, project testDir) before falling back to the
   * injected `configDir`.
   */
  private resolvePlaywrightConfigDirectory(config: FullConfig): string {
    const seeds: string[] = [];
    const push = (p: string | undefined) => {
      if (!p) return;
      try {
        seeds.push(path.resolve(p));
      } catch {
        /* invalid path from host */
      }
    };

    const cf = config.configFile?.trim();
    if (cf) {
      const absCfg = path.isAbsolute(cf)
        ? cf
        : path.resolve(this.injectedConfigDir, cf);
      push(path.dirname(absCfg));
    }

    push(this.injectedConfigDir);

    if (config.rootDir) push(path.dirname(path.resolve(config.rootDir)));

    const p0 = config.projects?.[0];
    if (p0?.testDir) push(path.resolve(p0.testDir));

    for (const seed of seeds) {
      let dir = seed;
      for (let depth = 0; depth < 14; depth++) {
        if (directoryContainsPlaywrightConfig(dir)) return path.resolve(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    return this.injectedConfigDir;
  }

  /**
   * Copies bundled client script next to screenshots/traces. External file loads under viewers that
   * block inline script (e.g. VS Code / Cursor Simple Browser).
   */
  private async copyReportUiBundle(assetsDir: string): Promise<void> {
    const dest = path.join(assetsDir, "report-ui.js");
    const src = path.join(
      this.configDir,
      "src",
      "reporter",
      "custom-report-ui.js",
    );
    try {
      await fs.copyFile(src, dest);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `[custom-report] Could not copy report UI from ${src}; filters/accordions may not work.`,
      );
    }
  }

  /**
   * Status strip + filter chrome as external CSS (cache-busted like report-ui.js) so embedded viewers
   * refresh styles when the Playwright VS Code / Cursor extension opens the report.
   */
  private async copyReportChromeCss(assetsDir: string): Promise<void> {
    const dest = path.join(assetsDir, "report-chrome.css");
    const src = path.join(
      this.configDir,
      "src",
      "reporter",
      "custom-report-chrome.css",
    );
    try {
      await fs.copyFile(src, dest);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `[custom-report] Could not copy report chrome CSS from ${src}; status strip styling may be wrong.`,
      );
    }
  }

  /** Reads surrounding lines from disk for a Playwright {@link Location} (Playwright HTML-style source view). */
  private async readSourceAroundLocation(
    loc: Location | undefined,
  ): Promise<string | undefined> {
    if (!loc?.file || loc.line < 1) return undefined;
    try {
      const abs = path.isAbsolute(loc.file)
        ? loc.file
        : path.resolve(this.configDir, loc.file);
      const raw = await fs.readFile(abs, "utf8");
      const lines = raw.split(/\r?\n/);
      const idx = loc.line - 1;
      if (idx < 0 || idx >= lines.length) return undefined;
      const contextBefore = SOURCE_SNIPPET_CONTEXT_BEFORE;
      const contextAfter = SOURCE_SNIPPET_CONTEXT_AFTER;
      const start = Math.max(0, idx - contextBefore);
      const end = Math.min(lines.length, idx + contextAfter + 1);
      const out: string[] = [];
      for (let i = start; i < end; i++) {
        const mark = i === idx ? ">" : " ";
        const num = String(i + 1).padStart(4, " ");
        out.push(`${mark}${num} | ${lines[i]}`);
      }
      return out.join("\n");
    } catch {
      return undefined;
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.runs.push({ test, result });
  }

  async onEnd(result: FullResult): Promise<void> {
    const outDir = path.isAbsolute(this.outputFolder)
      ? path.normalize(this.outputFolder)
      : path.resolve(this.configDir, this.outputFolder);

    const assetsDir = path.join(outDir, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await this.copyReportUiBundle(assetsDir);
    await this.copyReportChromeCss(assetsDir);

    const byTestId = new Map<
      string,
      { test: TestCase; results: TestResult[] }
    >();
    for (const { test, result: r } of this.runs) {
      let entry = byTestId.get(test.id);
      if (!entry) {
        entry = { test, results: [] };
        byTestId.set(test.id, entry);
      }
      entry.results.push(r);
    }

    const orderedIds: string[] = [];
    const seenId = new Set<string>();
    for (const { test } of this.runs) {
      if (!seenId.has(test.id)) {
        seenId.add(test.id);
        orderedIds.push(test.id);
      }
    }

    const groupedModels = await Promise.all(
      orderedIds.map((id) => {
        const entry = byTestId.get(id)!;
        return this.buildGroupedRunModel(
          entry.test,
          entry.results,
          assetsDir,
          outDir,
        );
      }),
    );

    const bySuite = new Map<string, GroupedRunModel[]>();
    for (const m of groupedModels) {
      const list = bySuite.get(m.suitePath) ?? [];
      list.push(m);
      bySuite.set(m.suitePath, list);
    }

    const suiteKeys = [...bySuite.keys()].sort((a, b) => a.localeCompare(b));

    let passedStable = 0;
    let flaky = 0;
    let failed = 0;
    let skipped = 0;
    let totalDuration = 0;
    for (const m of groupedModels) {
      totalDuration += m.totalDuration;
      if (m.outcome === "flaky") flaky++;
      else if (m.finalStatus === "passed") passedStable++;
      else if (
        m.finalStatus === "failed" ||
        m.finalStatus === "timedOut" ||
        m.finalStatus === "interrupted"
      )
        failed++;
      else if (m.finalStatus === "skipped") skipped++;
    }

    const tagSet = new Set<string>();
    for (const m of groupedModels) {
      for (const t of m.tags) tagSet.add(t);
    }
    const allTags = [...tagSet].sort((a, b) => a.localeCompare(b));

    const reportEndedAt = new Date(
      result.startTime.getTime() + result.duration,
    );
    const executionMs =
      typeof result.duration === "number" && Number.isFinite(result.duration)
        ? result.duration
        : totalDuration;

    const assetCacheBust = String(Date.now());
    const html = this.renderDocument({
      suiteKeys,
      bySuite,
      stats: {
        total: groupedModels.length,
        passedStable,
        failed,
        flaky,
        skipped,
      },
      allTags,
      reportMeta: {
        reportEndedAt,
        executionMs,
      },
      assetCacheBust,
    });

    const indexAbs = path.resolve(outDir, "index.html");
    await fs.writeFile(indexAbs, html, "utf8");

    // eslint-disable-next-line no-console
    //console.log(`\n[custom-report] Wrote custom HTML report (open after each run; Playwright extension does not embed this UI in the Testing panel):`,);

    // eslint-disable-next-line no-console
    //console.log(`[custom-report] Resolved configDir (repo root for sources): ${this.configDir}`,);

    // eslint-disable-next-line no-console
    console.log(
      `[custom-report] > ${outDir}${this.lockRepositoryRoot ? " (locked to playwright.config repositoryRoot)" : ""}`,
    );

    // eslint-disable-next-line no-console
    //console.log(indexAbs);

    // eslint-disable-next-line no-console
    //console.log(`[custom-report] Report assets (cache-bust in index.html): ${path.join(outDir, "assets", "report-ui.js",)}, ${path.join(outDir, "assets", "report-chrome.css")}`,);

  }
  private async buildAttemptModel(
    result: TestResult,
    assetsDir: string,
    outDir: string,
  ): Promise<AttemptModel> {
    let videoRel: string | undefined;
    let traceRel: string | undefined;

    for (const att of result.attachments) {
      const isVid = isVideoAttachment(att.contentType ?? "", att.name);
      const isTr = isTraceAttachment(att.contentType, att.name);
      if (!isVid && !isTr) continue;
      if (isVid && videoRel) continue;
      if (isTr && traceRel) continue;

      const rawBase = sanitizeFileName(att.name);
      const destName = isTr
        ? `${randomUUID().slice(0, 12)}-${
            rawBase.toLowerCase().endsWith(".zip")
              ? rawBase
              : `${rawBase || "trace"}.zip`
          }`
        : `${randomUUID().slice(0, 12)}-${rawBase || "video.webm"}`;

      const destAbs = path.join(assetsDir, destName);

      try {
        if (att.path) {
          await fs.copyFile(att.path, destAbs);
        } else if (att.body) {
          await fs.writeFile(destAbs, att.body);
        } else {
          continue;
        }

        const relFromHtml = path
          .relative(outDir, destAbs)
          .split(path.sep)
          .join("/");
        if (isVid) videoRel = relFromHtml;
        else traceRel = relFromHtml;
      } catch {
        // skip missing artifact file
      }
    }

    const steps = await Promise.all(
      result.steps.map((s) => this.buildStepModel(s, assetsDir, outDir)),
    );

    const rawError =
      result.error?.message ?? result.errors?.[0]?.message ?? undefined;
    const errorSnippet =
      rawError !== undefined ? stripAnsi(rawError) : undefined;

    return {
      retry: result.retry,
      status: result.status,
      duration: result.duration,
      errorSnippet,
      videoRel,
      traceRel,
      steps,
    };
  }

  private async buildGroupedRunModel(
    test: TestCase,
    results: TestResult[],
    assetsDir: string,
    outDir: string,
  ): Promise<GroupedRunModel> {
    const sorted = [...results].sort((a, b) => a.retry - b.retry);
    const attempts = await Promise.all(
      sorted.map((r) => this.buildAttemptModel(r, assetsDir, outDir)),
    );

    const loc = test.location;
    const location = loc
      ? `${path.basename(loc.file)}:${loc.line}:${loc.column}`
      : "";

    const sp = suitePath(test);
    const proj = projectName(test);
    const tags = [...new Set(test.tags)].sort((a, b) => a.localeCompare(b));
    const last = sorted[sorted.length - 1];

    const searchText = buildSearchText([
      sp,
      test.title,
      location,
      proj,
      ...tags,
      ...sorted.flatMap((r) =>
        r.retry > 0 ? [`retry ${r.retry}`, `retry #${r.retry}`] : [],
      ),
      ...attempts.flatMap((a) => [
        ...collectStepTitles(a.steps),
        ...collectStepLocations(a.steps),
        a.errorSnippet ?? "",
      ]),
    ]);

    return {
      suitePath: sp,
      title: test.title,
      location,
      project: proj,
      outcome: test.outcome(),
      finalStatus: last.status,
      totalDuration: sorted.reduce((acc, r) => acc + r.duration, 0),
      tags,
      searchText,
      attempts,
    };
  }

  private async buildStepModel(
    step: TestStep,
    assetsDir: string,
    outDir: string,
  ): Promise<StepModel> {
    const imageSrcs: string[] = [];
    const codeBlocks: { label: string; text: string }[] = [];
    const otherAttachments: { label: string; href: string }[] = [];

    for (const att of step.attachments) {
      if (isInlineCodeAttachment(att.contentType, att.name)) {
        try {
          let raw: string | undefined;
          if (att.body !== undefined && att.body !== null) {
            raw = attachmentBodyToUtf8(att.body);
          } else if (att.path) {
            raw = await fs.readFile(att.path, "utf8");
          }
          if (raw !== undefined) {
            let display = prettyJsonIfPossible(raw);
            if (display.length > MAX_INLINE_CODE_CHARS) {
              display =
                display.slice(0, MAX_INLINE_CODE_CHARS) +
                "\n\n… (truncated for report size)";
            }
            codeBlocks.push({ label: att.name, text: display });
          }
        } catch {
          /* skip unreadable inline attachment */
        }
        continue;
      }

      const destName = `${randomUUID().slice(0, 12)}-${sanitizeFileName(att.name)}`;
      const destAbs = path.join(assetsDir, destName);

      try {
        if (att.path) {
          await fs.copyFile(att.path, destAbs);
        } else if (att.body) {
          await fs.writeFile(destAbs, att.body);
        } else {
          continue;
        }

        const relFromHtml = path
          .relative(outDir, destAbs)
          .split(path.sep)
          .join("/");

        if (isStepScreenshotAttachment(att.contentType, att.name)) {
          imageSrcs.push(relFromHtml);
        } else if (isVideoAttachment(att.contentType ?? "", att.name)) {
          // Recording is surfaced on the test row; skip duplicate step link
          continue;
        } else if (isTraceAttachment(att.contentType, att.name)) {
          // Trace ZIP is on TestResult; skip duplicate step link
          continue;
        } else {
          otherAttachments.push({
            label: att.name,
            href: relFromHtml,
          });
        }
      } catch {
        // Missing source file or IO error — skip attachment
      }
    }

    const children = await Promise.all(
      step.steps.map((s) => this.buildStepModel(s, assetsDir, outDir)),
    );

    const location = step.location
      ? {
          file: step.location.file,
          line: step.location.line,
          column: step.location.column,
        }
      : undefined;

    const sourceSnippet = await this.readSourceAroundLocation(step.location);

    return {
      title: step.title,
      category: step.category,
      duration: step.duration,
      failed: !!step.error,
      errorMessage: step.error?.message
        ? stripAnsi(step.error.message)
        : undefined,
      imageSrcs,
      codeBlocks,
      otherAttachments,
      children,
      location,
      sourceSnippet,
    };
  }

  private renderDocument(opts: {
    suiteKeys: string[];
    bySuite: Map<string, GroupedRunModel[]>;
    stats: {
      total: number;
      passedStable: number;
      failed: number;
      flaky: number;
      skipped: number;
    };
    /** Distinct tags across the run, for the tag filter bar. */ allTags: string[];
    reportMeta: {
      /** When the run finished (start + wall clock), for the header clock. */ reportEndedAt: Date;
      /** Wall-clock run duration from Playwright (ms). */ executionMs: number;
    };
    /** Busts cached `report-ui.js` in Simple Browser / embedded viewers (extension runs). */ assetCacheBust: string;
  }): string {
    const { suiteKeys, bySuite, stats, allTags, reportMeta, assetCacheBust } =
      opts;

    const dateTimeStr = formatReportDateTime(reportMeta.reportEndedAt);
    const execStr = formatWallClockDuration(reportMeta.executionMs);
    const tagFilterBar =
      allTags.length === 0
        ? ""
        : `  <div class="tag-filter-bar" role="group" aria-label="Filter by tag">    <span class="tag-filter-label">Tags</span>    <button type="button" class="tag-pill tag-pill-all is-active" data-tag="" aria-pressed="true">All</button>    ${allTags.map((t) => `<button type="button" class="tag-pill" data-tag="${escapeHtml(t)}" aria-pressed="false">${escapeHtml(t)}</button>`).join("")}  </div>`;

    let cardIndex = 0;
    const suiteBlocks = suiteKeys
      .map((suite) => {
        const runs = bySuite.get(suite) ?? [];
        const cards = runs
          .map((r) => this.renderGroupedTestCard(r, cardIndex++))
          .join("\n");
        return `        <section class="suite">          <h2 class="suite-title">${escapeHtml(suite)}</h2>          ${cards}        </section>`;
      })
      .join("\n");

    return /* HTML */ `<!DOCTYPE html>
      <html lang="en" data-theme="light">
        <!-- custom report ${escapeHtml(
          reportMeta.reportEndedAt.toISOString(),
        )} build=${escapeHtml(assetCacheBust)} --><head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <meta
            http-equiv="Cache-Control"
            content="no-cache, no-store, must-revalidate"
          />
          <meta http-equiv="Pragma" content="no-cache" />
          <title>Custom Test Report</title>
          <script>
            (function () {
              try {
                var k = "custom-report-theme";
                var t = localStorage.getItem(k);
                document.documentElement.setAttribute(
                  "data-theme",
                  t === "dark" ? "dark" : "light",
                );
              } catch (e) {
                document.documentElement.setAttribute("data-theme", "light");
              }
            })();
          </script>
          <style>
            :root,
            [data-theme="dark"] {
              --bg: #0f172a;
              --panel: #1e293b;
              --accent: #10b981;
              --accent-dim: #059669;
              --fail: #ef4444;
              --skip: #94a3b8;
              --text: #f1f5f9;
              --muted: #94a3b8;
              --border: #334155;
              --link: #7dd3fc;
              --step-fail: #fca5a5;
              --err-bg: rgba(239, 68, 68, 0.12);
            }
            [data-theme="light"] {
              --bg: #f1f5f9;
              --panel: #ffffff;
              --accent: #059669;
              --accent-dim: #047857;
              --fail: #dc2626;
              --skip: #64748b;
              --text: #0f172a;
              --muted: #64748b;
              --border: #cbd5e1;
              --link: #0369a1;
              --step-fail: #b91c1c;
              --err-bg: rgba(239, 68, 68, 0.08);
            }
            * {
              box-sizing: border-box;
            }
            body {
              margin: 0;
              font-family:
                ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial,
                sans-serif;
              font-size: 100%;
              background: var(--bg);
              color: var(--text);
              line-height: 1.5;
              font-weight: 400;
            }
            .banner-row {
              display: grid;
              grid-template-columns: 1fr auto 1fr;
              align-items: center;
              gap: 0.75rem;
            }
            .banner-leading {
              min-width: 0;
            }
            .banner-center {
              justify-self: center;
              text-align: center;
              min-width: 0;
              max-width: 100%;
            }
            .banner-trailing {
              justify-self: end;
              display: flex;
              align-items: center;
              min-width: 0;
            }
            .banner {
              background: rgb(
                3,
                92,
                103
              ); /* Slightly less bottom padding + softer shadow — downward shadow was reading as extra bottom space */
              padding: 0.8rem 1.25rem 0.62rem;
              box-shadow: 0 1px 10px rgba(0, 0, 0, 0.22);
              color: #f8fafc;
            }
            .banner h1,
            .banner p,
            .banner code {
              color: #f8fafc;
            }
            .banner-heading {
              margin: 0;
              font-size: 1.0625rem;
              font-weight: 700;
              letter-spacing: 0.02em;
              line-height: 1.15;
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              justify-content: center;
              gap: 0.65rem 1.25rem;
              max-width: 100%;
            }
            .banner-title-main {
              flex: 0 1 auto;
              line-height: 1.15;
            }
            .banner-title-datetime,
            .banner-title-duration {
              font-weight: 600;
              opacity: 0.96;
              font-size: 0.9375rem;
              white-space: nowrap;
              display: inline-flex;
              align-items: center;
              gap: 0.35rem;
            }
            .banner-meta-icon {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
              opacity: 0.92;
              line-height: 0;
              user-select: none;
              color: inherit;
            }
            .banner-svg-icon {
              width: 15px;
              height: 15px;
              display: block;
            }
            .banner p {
              margin: 0.35rem 0 0;
              opacity: 0.95;
              font-size: 0.8125rem;
              font-weight: 400;
              max-width: 52rem;
            }
            .banner code {
              font-size: calc(0.9em - 1px);
              background: rgba(0, 0, 0, 0.18);
              padding: 0.1em 0.35em;
              border-radius: 4px;
            }
            .theme-toggle {
              flex-shrink: 0;
              padding: 0.45rem 0.85rem;
              font-size: 0.75rem;
              font-weight: 600;
              border-radius: 8px;
              cursor: pointer;
              color: #065f46;
              background: #f8fafc;
              border: 2px solid rgba(255, 255, 255, 0.95);
              box-shadow:
                0 2px 8px rgba(0, 0, 0, 0.28),
                0 0 0 1px rgba(6, 95, 70, 0.35),
                inset 0 1px 0 rgba(255, 255, 255, 1);
            }
            .theme-toggle:hover {
              background: #ffffff;
              color: #064e3b;
              box-shadow:
                0 4px 14px rgba(0, 0, 0, 0.32),
                0 0 0 1px rgba(6, 95, 70, 0.45),
                inset 0 1px 0 rgba(255, 255, 255, 1);
            }
            .theme-toggle:focus-visible {
              outline: 2px solid #fbbf24;
              outline-offset: 2px;
            }
            .tag-filter-bar {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.4rem 0.5rem;
              padding: 0.55rem 1.25rem;
              background: var(--panel);
              border-bottom: 1px solid var(--border);
            }
            .tag-filter-label {
              font-size: 0.75rem;
              font-weight: 600;
              color: var(--muted);
              margin-right: 0.15rem;
            }
            .tag-pill {
              cursor: pointer;
              font: inherit;
              font-size: 0.75rem;
              padding: 0.28rem 0.55rem;
              border-radius: 999px;
              border: 1px solid var(--border);
              background: var(--bg);
              color: var(--text);
            }
            .tag-pill:hover {
              border-color: var(--accent);
            }
            .tag-pill.is-active {
              border-color: var(--accent);
              box-shadow: 0 0 0 1px var(--accent);
              background: rgba(16, 185, 129, 0.12);
            }
            [data-theme="light"] .tag-pill.is-active {
              background: rgba(5, 150, 105, 0.12);
            }
            .report-toolbar {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.5rem 0.75rem;
              padding: 0.65rem 1.25rem;
              background: var(--panel);
              border-bottom: 1px solid var(--border);
            }
            .filter-label {
              font-size: 0.75rem;
              font-weight: 600;
              color: var(--muted);
            }
            .report-search {
              flex: 1 1 280px;
              min-width: 0;
              max-width: none;
              padding: 0.45rem 0.65rem;
              font-size: 0.8125rem;
              border-radius: 6px;
              border: 1px solid var(--border);
              background: var(--bg);
              color: var(--text);
            }
            .report-search::placeholder {
              color: var(--muted);
            }
            .report-search:focus {
              outline: 2px solid var(--accent);
              outline-offset: 1px;
            }
            .test-card.report-hidden {
              display: none !important;
            }
            section.suite.suite-empty {
              display: none !important;
            }
            main {
              padding: 0.85rem 0 2rem;
              width: 100%;
              box-sizing: border-box;
            } /** ~15% side gutters, ~70% content (centered) */
            .report-content-column {
              width: 70%;
              max-width: 100%;
              margin-left: auto;
              margin-right: auto;
              box-sizing: border-box;
              padding-left: clamp(0.25rem, 1.5vw, 1rem);
              padding-right: clamp(0.25rem, 1.5vw, 1rem);
            }
            @media (max-width: 960px) {
              .report-content-column {
                width: 100%;
                margin: 0;
                padding-left: clamp(0.5rem, 2vw, 1rem);
                padding-right: clamp(0.5rem, 2vw, 1rem);
              }
            }
            .suite {
              margin-bottom: 1.25rem;
            }
            .suite-title {
              font-size: 0.6875rem;
              color: var(--muted);
              font-weight: 600;
              margin: 0 0 0.5rem;
              text-transform: uppercase;
              letter-spacing: 0.07em;
            }
            .test-card {
              background: var(--panel);
              border: 1px solid var(--border);
              border-radius: 8px;
              margin-bottom: 0.5rem;
              overflow: hidden;
            }
            .test-card-top {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.35rem 0.5rem;
              border-bottom: 1px solid transparent;
            }
            .test-card.is-open .test-card-top {
              border-bottom-color: var(--border);
            }
            .test-title-cluster {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.45rem 0.6rem;
              flex: 1 1 min(0, 100%);
              min-width: 0;
              text-align: left;
            }
            .test-tags-inline {
              display: inline-flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.35rem;
            }
            .attempt-tabs {
              display: flex;
              flex-wrap: wrap;
              gap: 0.25rem;
              padding: 0.4rem 0.65rem 0;
              border-bottom: 1px solid var(--border);
              background: rgba(148, 163, 184, 0.06);
            }
            .attempt-tab {
              font: inherit;
              cursor: pointer;
              padding: 0.35rem 0.65rem 0.5rem;
              border: none;
              border-bottom: 2px solid transparent;
              margin-bottom: -1px;
              background: transparent;
              color: var(--muted);
              font-size: 0.75rem;
              border-radius: 6px 6px 0 0;
            }
            .attempt-tab.attempt-tab-pass:hover {
              color: var(--text);
              background: rgba(16, 185, 129, 0.12);
              box-shadow: 0 0 0 1px var(--accent);
            }
            [data-theme="light"] .attempt-tab.attempt-tab-pass:hover {
              background: rgba(5, 150, 105, 0.12);
            }
            .attempt-tab.attempt-tab-fail:hover {
              color: var(--text);
              background: rgba(239, 68, 68, 0.12);
              box-shadow: 0 0 0 1px var(--fail);
            }
            [data-theme="light"] .attempt-tab.attempt-tab-fail:hover {
              background: rgba(220, 38, 38, 0.1);
            }
            .attempt-tab.attempt-tab-skip:hover {
              color: var(--text);
              background: rgba(148, 163, 184, 0.14);
              box-shadow: 0 0 0 1px var(--skip);
            }
            [data-theme="light"] .attempt-tab.attempt-tab-skip:hover {
              background: rgba(100, 116, 139, 0.12);
              box-shadow: 0 0 0 1px var(--skip);
            }
            .attempt-tab.is-active {
              color: var(--text);
              border-bottom-color: var(--accent);
              background: var(--panel);
              font-weight: 600;
            }
            .attempt-mini {
              font-size: 0.625rem;
              font-weight: 600;
              text-transform: uppercase;
              opacity: 0.9;
            }
            .attempt-mini.attempt-tab-ok {
              color: var(--accent);
            }
            .attempt-mini.attempt-tab-skip {
              color: var(--skip);
            }
            .attempt-mini.attempt-tab-bad {
              color: var(--fail);
            }
            .attempt-panels-wrap.has-tabs .attempt-panel {
              display: none;
              padding: 0 0 0.35rem;
            }
            .attempt-panels-wrap.has-tabs .attempt-panel.is-active {
              display: block;
            }
            .attempt-panels-wrap:not(.has-tabs) .attempt-panel {
              display: block;
              padding: 0 0 0.35rem;
            }
            .attempt-video-bar,
            .attempt-meta-row {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.5rem;
              padding: 0.35rem 0.65rem 0;
            }
            .test-tag-link {
              font-size: 0.6875rem;
              padding: 0.12rem 0.45rem;
              border-radius: 999px;
              border: 1px solid var(--border);
              background: var(--bg);
              color: var(--link);
              cursor: pointer;
              font-family: inherit;
              max-width: 100%;
              word-break: break-word;
            }
            .test-tag-link:hover {
              border-color: var(--accent);
              text-decoration: underline;
            }
            .test-tag-link:focus-visible {
              outline: 2px solid var(--accent);
              outline-offset: 1px;
            }
            .test-video-link,
            .test-trace-link {
              flex: 0 0 auto;
              margin: 0.35rem 0.65rem 0.35rem 0;
              padding: 0.45rem 0.85rem;
              font-size: 0.8125rem;
              font-weight: 600;
              border-radius: 6px;
              text-decoration: none;
              color: var(--link);
              background: var(--bg);
              border: 1px solid var(--border);
              align-self: center;
              white-space: nowrap;
            }
            .test-video-link:hover,
            .test-trace-link:hover {
              text-decoration: underline;
              filter: brightness(1.05);
            }
            .test-card-toggle {
              flex: 1 1 14rem;
              min-width: 0;
              width: auto;
              text-align: left;
              background: var(--panel);
              border: 1px solid transparent;
              border-radius: 6px;
              cursor: pointer;
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.45rem 0.55rem;
              padding: 0.5rem 0.75rem;
              margin: 0.15rem;
              font: inherit;
              color: inherit;
              transition:
                border-color 0.15s ease,
                box-shadow 0.15s ease,
                background 0.15s ease;
            } /* Row hover matches outcome: pass (stable), flaky (amber), fail/red, skip (slate) */
            .test-card-toggle:hover {
              border-color: var(--accent);
              box-shadow: 0 0 0 1px var(--accent);
              background: rgba(16, 185, 129, 0.12);
            }
            [data-theme="light"] .test-card-toggle:hover {
              background: rgba(5, 150, 105, 0.12);
            }
            .test-card[data-outcome="flaky"] .test-card-toggle:hover {
              border-color: #d97706;
              box-shadow: 0 0 0 1px #d97706;
              background: rgba(217, 119, 6, 0.14);
            }
            [data-theme="light"]
              .test-card[data-outcome="flaky"]
              .test-card-toggle:hover {
              background: rgba(217, 119, 6, 0.12);
            }
            .test-card[data-status="failed"] .test-card-toggle:hover,
            .test-card[data-status="timedOut"] .test-card-toggle:hover,
            .test-card[data-status="interrupted"] .test-card-toggle:hover {
              border-color: var(--fail);
              box-shadow: 0 0 0 1px var(--fail);
              background: rgba(239, 68, 68, 0.12);
            }
            [data-theme="light"]
              .test-card[data-status="failed"]
              .test-card-toggle:hover,
            [data-theme="light"]
              .test-card[data-status="timedOut"]
              .test-card-toggle:hover,
            [data-theme="light"]
              .test-card[data-status="interrupted"]
              .test-card-toggle:hover {
              background: rgba(220, 38, 38, 0.1);
            }
            .test-card[data-status="skipped"] .test-card-toggle:hover {
              border-color: var(--skip);
              box-shadow: 0 0 0 1px var(--skip);
              background: rgba(148, 163, 184, 0.14);
            }
            [data-theme="light"]
              .test-card[data-status="skipped"]
              .test-card-toggle:hover {
              background: rgba(100, 116, 139, 0.12);
            }
            .test-card-toggle:focus-visible {
              outline: 2px solid var(--accent);
              outline-offset: 2px;
            }
            .test-card[data-outcome="flaky"] .test-card-toggle:focus-visible {
              outline-color: #d97706;
            }
            .test-card[data-status="failed"] .test-card-toggle:focus-visible,
            .test-card[data-status="timedOut"] .test-card-toggle:focus-visible,
            .test-card[data-status="interrupted"]
              .test-card-toggle:focus-visible {
              outline-color: var(--fail);
            }
            .test-card[data-status="skipped"] .test-card-toggle:focus-visible {
              outline-color: var(--skip);
            }
            .toggle-chevron {
              font-size: 0.4875rem;
              width: 1rem;
              flex-shrink: 0;
              transition: transform 0.15s ease;
              opacity: 0.85;
            }
            .test-card.is-open .toggle-chevron {
              transform: rotate(90deg);
            }
            .test-head-title {
              margin: 0;
              font-size: 0.9375rem;
              font-weight: 700;
              flex: 1 1 auto;
              min-width: 0;
              max-width: 100%;
            }
            .badge {
              font-size: 0.625rem;
              font-weight: 700;
              padding: 0.12rem 0.45rem;
              border-radius: 999px;
              text-transform: uppercase;
              letter-spacing: 0.04em;
            }
            .badge.pass {
              background: rgba(16, 185, 129, 0.22);
              color: var(--accent);
            }
            [data-theme="light"] .badge.pass {
              color: #047857;
            }
            .badge.fail {
              background: rgba(239, 68, 68, 0.22);
              color: var(--fail);
            }
            .badge.skip {
              background: rgba(148, 163, 184, 0.18);
              color: var(--skip);
            }
            .badge.pending {
              background: rgba(251, 191, 36, 0.18);
              color: #b45309;
            }
            .badge.flaky {
              background: rgba(217, 119, 6, 0.22);
              color: #d97706;
            }
            [data-theme="light"] .badge.flaky {
              color: #b45309;
            }
            .meta {
              font-size: 0.75rem;
              color: var(--muted);
              font-weight: 400;
            }
            .test-body {
              display: none;
              padding: 0 0 0.35rem;
            }
            .test-card.is-open .test-body {
              display: block;
            }
            .test-error {
              margin: 0;
              padding: 0.45rem 0.75rem;
              background: var(--err-bg);
              border-left: 3px solid var(--fail);
              font-size: 0.75rem;
              white-space: pre-wrap;
              font-weight: 400;
            }
            .steps {
              padding: 0.35rem 0.55rem 0.55rem 0.55rem;
            }
            .step-meta-loc {
              font-size: 0.6875rem;
              font-family:
                ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
              color: var(--muted);
              margin: 0 0 0.35rem;
            }
            .step-meta-file {
              color: var(--link);
              word-break: break-all;
            }
            .step-meta-pos {
              opacity: 0.85;
            }
            .step-source-code {
              margin: 0 0 0.5rem;
              padding: 0.45rem 0.55rem;
              font-size: 0.6575rem;
              line-height: 1.45;
              font-family:
                ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
              background: var(--bg);
              border: 1px solid var(--border);
              border-radius: 6px;
              overflow-x: auto;
              white-space: pre;
              color: var(--text);
            }
            .step-source-code code {
              font-family: inherit;
              font-size: inherit;
            }
            .step-nested-accordion {
              margin-bottom: 0.3rem;
              padding-left: 0;
            }
            .step-nested-toggle {
              width: 100%;
              display: flex;
              flex-wrap: wrap;
              align-items: baseline;
              gap: 0.35rem 0.45rem;
              padding: 0.28rem 0.35rem;
              border: none;
              background: transparent;
              cursor: pointer;
              font: inherit;
              color: inherit;
              text-align: left;
              border-radius: 4px;
            }
            .step-nested-toggle:hover {
              background: rgba(148, 163, 184, 0.08);
            }
            .step-nested-chevron {
              font-size: 0.4875rem;
              width: 0.85rem;
              flex-shrink: 0;
              transition: transform 0.15s ease;
              opacity: 0.85;
            }
            .step-nested-accordion.is-open
              .step-nested-toggle
              .step-nested-chevron {
              transform: rotate(90deg);
            }
            .step-nested-detail {
              display: none;
              padding: 0.2rem 0 0.35rem 0.5rem;
              margin-left: 0;
            }
            .step-nested-accordion.is-open .step-nested-detail {
              display: block;
            }
            .step-root.step-accordion {
              margin-left: 0;
              margin-bottom: 0.5rem;
              border: 1px solid var(--border);
              border-radius: 8px;
              background: var(--panel);
              overflow: hidden;
            }
            .step-root-toggle {
              width: 100%;
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 0.35rem 0.5rem;
              padding: 0.45rem 0.65rem;
              border: none;
              background: var(--bg);
              cursor: pointer;
              font: inherit;
              color: inherit;
              text-align: left;
              border-bottom: 1px solid transparent;
            }
            .step-root-toggle:hover {
              filter: brightness(1.03);
            }
            .step-accordion.is-open .step-root-toggle {
              border-bottom-color: var(--border);
            }
            .step-accordion.is-open .step-root-toggle .step-chevron {
              transform: rotate(90deg);
            }
            .step-chevron {
              font-size: 0.4875rem;
              width: 0.85rem;
              flex-shrink: 0;
              transition: transform 0.15s ease;
              opacity: 0.85;
            }
            .step-root-body {
              display: none;
              padding: 0.35rem 0.65rem 0.55rem 0.65rem;
              margin-left: 0;
            }
            .step-accordion.is-open .step-root-body {
              display: block;
            }
            .step-inner {
              padding: 0.2rem 0 0.08rem;
            }
            .step-head {
              display: flex;
              flex-wrap: wrap;
              align-items: baseline;
              gap: 0.35rem 0.45rem;
              font-size: 0.8125rem;
              font-weight: 400;
            }
            .step-title {
              font-weight: 400;
              color: var(--text);
            }
            .step-status-chip {
              font-size: 0.625rem;
              font-weight: 600;
              padding: 0.08rem 0.4rem;
              border-radius: 999px;
              text-transform: uppercase;
              letter-spacing: 0.04em;
              flex-shrink: 0;
            }
            .step-status-chip.step-status-pass {
              background: rgba(16, 185, 129, 0.18);
              color: var(--accent);
            }
            .step-status-chip.step-status-fail {
              background: rgba(239, 68, 68, 0.18);
              color: var(--fail);
            }
            .step-cat {
              font-size: 0.625rem;
              color: var(--muted);
              text-transform: uppercase;
              letter-spacing: 0.05em;
              font-weight: 400;
            }
            .step-dur {
              font-size: 0.6875rem;
              color: var(--muted);
              font-weight: 400;
            }
            .step.fail .step-title {
              color: var(--step-fail);
              font-weight: 400;
            }
            .step-error {
              margin: 0.25rem 0 0;
              font-size: 0.75rem;
              color: var(--step-fail);
              white-space: pre-wrap;
              font-weight: 400;
            }
            .shot-block {
              margin: 0.35rem 0 0.45rem;
              padding: 0.35rem;
              background: var(--bg);
              border-radius: 6px;
              border: 1px solid var(--border);
              max-width: 100%;
              overflow: hidden;
              display: flex;
              flex-direction: column;
              align-items: flex-start;
            }
            .shot-block img {
              display: block;
              margin: 0;
              width: auto;
              height: auto;
              max-width: min(100%, 520px);
              max-height: 280px;
              object-fit: contain;
              border-radius: 3px;
              cursor: zoom-in;
              transition:
                opacity 0.15s ease,
                box-shadow 0.15s ease;
            }
            .shot-block img:hover {
              opacity: 0.94;
              box-shadow: 0 0 0 2px
                color-mix(in srgb, var(--link) 45%, transparent);
            }
            .step-code-block {
              margin: 0.35rem 0 0.45rem;
              padding: 0.4rem 0.45rem;
              background: var(--bg);
              border-radius: 6px;
              border: 1px solid var(--border);
              max-width: 100%;
              overflow: hidden;
            }
            .step-code-block-label {
              font-size: 0.6875rem;
              font-weight: 600;
              color: var(--muted);
              margin: 0 0 0.35rem;
              text-transform: uppercase;
              letter-spacing: 0.04em;
            }
            .step-code-block pre {
              margin: 0;
              padding: 0.45rem 0.5rem;
              font-size: 0.6575rem;
              line-height: 1.45;
              font-family:
                ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
              background: var(--panel);
              border: 1px solid var(--border);
              border-radius: 4px;
              overflow-x: auto;
              white-space: pre;
              color: var(--text);
              max-height: 500px;
              overflow-y: auto;
            }
            .step-code-block code {
              font-family: inherit;
              font-size: inherit;
            }
            .shot-lightbox {
              display: none;
              position: fixed;
              inset: 0;
              z-index: 10000;
              align-items: center;
              justify-content: center;
              padding: max(12px, env(safe-area-inset-top))
                max(12px, env(safe-area-inset-right))
                max(12px, env(safe-area-inset-bottom))
                max(12px, env(safe-area-inset-left));
              box-sizing: border-box;
            }
            .shot-lightbox.is-open {
              display: flex;
            }
            .shot-lightbox-backdrop {
              position: absolute;
              inset: 0;
              margin: 0;
              padding: 0;
              border: none;
              background: rgba(15, 23, 42, 0.82);
              cursor: zoom-out;
            }
            .shot-lightbox-dialog {
              position: relative;
              z-index: 1;
              max-width: min(1920px, calc(100vw - 24px));
              max-height: calc(100vh - 24px);
              display: flex;
              flex-direction: column;
              align-items: flex-end;
              gap: 0.35rem;
            }
            .shot-lightbox-close {
              flex-shrink: 0;
              font-size: 1.5rem;
              line-height: 1;
              padding: 0.15rem 0.5rem;
              border: 1px solid var(--border);
              border-radius: 6px;
              background: var(--panel);
              color: var(--text);
              cursor: pointer;
              font-family: inherit;
            }
            .shot-lightbox-close:hover {
              filter: brightness(1.06);
            }
            .shot-lightbox-img {
              display: block;
              max-width: min(1920px, calc(100vw - 24px));
              max-height: calc(100vh - 56px);
              width: auto;
              height: auto;
              object-fit: contain;
              border-radius: 6px;
              box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
            }
            .step-root-body .step-inline-attach-links,
            .step-nested-detail .step-inline-attach-links {
              margin-top: 0.35rem;
            }
            .attach-link {
              font-size: 0.75rem;
              margin-right: 0.5rem;
              color: var(--link);
              font-weight: 400;
            }
            .attach-link:hover {
              text-decoration: underline;
            }
            .hint {
              font-size: 0.75rem;
              color: var(--muted);
              padding: 0 0.75rem 0.75rem;
              font-weight: 400;
            }
            .trace-open-hint {
              padding: 0 0.65rem 0.5rem;
              margin: 0;
              max-width: 100%;
              line-height: 1.35;
              white-space: nowrap;
              overflow-x: auto;
              overflow-y: hidden;
              -webkit-overflow-scrolling: touch;
            }
            .trace-open-hint a {
              font-weight: 600;
              white-space: nowrap;
            }
          </style>
          <link
            rel="stylesheet"
            href="assets/report-chrome.css?${escapeHtml(assetCacheBust)}"
          />
        </head>
        <body data-report-build="${escapeHtml(assetCacheBust)}">
          <header class="banner">
            <div class="banner-row">
              <div class="banner-leading" aria-hidden="true"></div>
              <div class="banner-center">
                <h1 class="banner-heading">
                  <span class="banner-title-main">Custom Test Report</span>
                  <span class="banner-title-datetime"
                    ><span class="banner-meta-icon"
                      >${BANNER_ICON_CALENDAR}</span
                    >${escapeHtml(dateTimeStr)}</span
                  >
                  <span class="banner-title-duration"
                    ><span class="banner-meta-icon">${BANNER_ICON_CLOCK}</span
                    >${escapeHtml(execStr)}</span
                  >
                </h1>
              </div>
              <div class="banner-trailing">
                <button
                  type="button"
                  class="theme-toggle"
                  id="theme-toggle"
                  aria-label="Toggle Light or Dark Theme"
                ></button>
              </div>
            </div>
          </header>
          <div class="report-content-column">
            <div
              class="stats stats-row"
              role="group"
              aria-label="Filter by status"
            >
              <span class="tag-filter-label">Status</span>
              <button
                type="button"
                class="stat stat-filter stat-filter-all is-active"
                data-filter="all"
                aria-pressed="true"
              >
                <strong>${stats.total}</strong> All
              </button>
              <button
                type="button"
                class="stat stat-filter"
                data-filter="passed"
                aria-pressed="false"
              >
                <strong>${stats.passedStable}</strong> Passed
              </button>
              <button
                type="button"
                class="stat stat-filter stat-fail"
                data-filter="failed"
                aria-pressed="false"
              >
                <strong>${stats.failed}</strong> Failed
              </button>
              <button
                type="button"
                class="stat stat-filter stat-flaky"
                data-filter="flaky"
                aria-pressed="false"
              >
                <strong>${stats.flaky}</strong> Flaky
              </button>
              <button
                type="button"
                class="stat stat-filter stat-filter-skipped"
                data-filter="skipped"
                aria-pressed="false"
              >
                <strong>${stats.skipped}</strong> Skipped
              </button>
            </div>
            ${tagFilterBar}
            <div class="report-toolbar">
              <label class="filter-label" for="report-search">Search</label>
              <input
                type="search"
                id="report-search"
                class="report-search"
                placeholder="Filter by title, file, project, step names…"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <main>${suiteBlocks}</main>
          </div>
          <div id="shot-lightbox" class="shot-lightbox" aria-hidden="true">
            <button
              type="button"
              class="shot-lightbox-backdrop"
              id="shot-lightbox-backdrop"
              aria-label="Close full size view"
            ></button>
            <div
              class="shot-lightbox-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Screenshot full size"
            >
              <button
                type="button"
                class="shot-lightbox-close"
                id="shot-lightbox-close"
                aria-label="Close"
              >
                &times;
              </button>
              <img
                class="shot-lightbox-img"
                id="shot-lightbox-img"
                src=""
                alt=""
              />
            </div>
          </div>
          <script
            defer
            src="assets/report-ui.js?${escapeHtml(assetCacheBust)}"
          ></script>
        </body>
      </html>`;
  }

  private renderGroupedTestCard(
    run: GroupedRunModel,
    cardIndex: number,
  ): string {
    const badgeLabel = run.outcome === "flaky" ? "flaky" : run.finalStatus;

    const badgeClass =
      run.outcome === "flaky"
        ? "flaky"
        : run.finalStatus === "passed"
          ? "pass"
          : run.finalStatus === "skipped"
            ? "skip"
            : run.finalStatus === "timedOut"
              ? "pending"
              : "fail";

    const tagsJson = escapeHtml(JSON.stringify(run.tags));
    const tagsInline =
      run.tags.length === 0
        ? ""
        : `<span class="test-tags-inline">${run.tags.map((t) => `<button type="button" class="test-tag-link" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("")}</span>`;

    const hasTabs = run.attempts.length > 1;

    const tabsHtml = hasTabs
      ? `<div class="attempt-tabs" role="tablist" aria-label="Attempts">${run.attempts
          .map((a, i) => {
            const label = a.retry === 0 ? "Run" : `Retry #${a.retry}`;
            const miniClass =
              a.status === "passed"
                ? "attempt-tab-ok"
                : a.status === "skipped"
                  ? "attempt-tab-skip"
                  : "attempt-tab-bad";
            const tabHoverClass =
              a.status === "passed"
                ? "attempt-tab-pass"
                : a.status === "skipped"
                  ? "attempt-tab-skip"
                  : "attempt-tab-fail";
            return `<button type="button" role="tab" class="attempt-tab ${tabHoverClass} ${i === 0 ? "is-active" : ""}" id="att-tab-${cardIndex}-${i}" aria-selected="${i === 0 ? "true" : "false"}" data-attempt="${i}">${escapeHtml(label)} <span class="attempt-mini ${miniClass}">${escapeHtml(a.status)}</span></button>`;
          })
          .join("")}</div>`
      : "";

    const panelsWrapClass = `attempt-panels-wrap${hasTabs ? " has-tabs" : ""}`;
    const panelsHtml = run.attempts
      .map((a, i) => {
        const errorBlock = a.errorSnippet
          ? `<pre class="test-error">${escapeHtml(a.errorSnippet)}</pre>`
          : "";
        const stepsHtml =
          a.steps.length > 0
            ? `<div class="steps">${a.steps.map((s) => this.renderStep(s, 0)).join("")}</div>`
            : `<p class="hint">No steps recorded for this attempt.</p>`;
        const mediaLinks: string[] = [];
        if (a.videoRel) {
          mediaLinks.push(
            `<a class="test-video-link" href="${escapeHtml(a.videoRel)}" target="_blank" rel="noopener"> ▶ Video</a>`,
          );
        }
        if (a.traceRel) {
          mediaLinks.push(
            `<a class="test-trace-link" href="${escapeHtml(a.traceRel)}" download title="Save the Trace (ZIP) file, then drop/upload it to https://trace.playwright.dev/ ">⬇ Trace (ZIP)</a>`,
          );
        }
        const mediaRow =
          mediaLinks.length > 0
            ? `<div class="attempt-video-bar">${mediaLinks.join("")}<span class="meta">${escapeHtml(formatStepDuration(a.duration))}</span></div>`
            : `<div class="attempt-meta-row"><span class="meta">${escapeHtml(formatStepDuration(a.duration))}</span></div>`;
        const traceOpenHint = a.traceRel
          ? `<p class="trace-open-hint hint">NOTE: Save the Trace (ZIP) file, then drop/upload it to <a href="https://trace.playwright.dev/" target="_blank" rel="noopener noreferrer">https://trace.playwright.dev/</a>.</p>`
          : "";
        const panelRole = hasTabs
          ? ` role="tabpanel" aria-labelledby="att-tab-${cardIndex}-${i}"`
          : "";
        return `<div class="attempt-panel ${i === 0 ? "is-active" : ""}"${panelRole} data-attempt="${i}">${mediaRow}${traceOpenHint}${errorBlock}${stepsHtml}</div>`;
      })
      .join("");

    return `    <article class="test-card" data-test-idx="${cardIndex}" data-status="${escapeHtml(run.finalStatus)}" data-outcome="${escapeHtml(run.outcome)}" data-search="${escapeHtml(run.searchText)}" data-tags="${tagsJson}">      <div class="test-card-top">      <button type="button" class="test-card-toggle" aria-expanded="false" id="test-toggle-${cardIndex}">        <span class="toggle-chevron" aria-hidden="true">▶</span>        <span class="test-title-cluster">          <span class="test-head-title">${escapeHtml(run.title)}</span>          ${tagsInline}        </span>        <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>        <span class="meta">${escapeHtml(run.project)} · ${escapeHtml(formatStepDuration(run.totalDuration))}</span>        ${run.location ? `<span class="meta">${escapeHtml(run.location)}</span>` : ""}      </button>      </div>      <div class="test-body" role="region" aria-labelledby="test-toggle-${cardIndex}">      ${tabsHtml}      <div class="${panelsWrapClass}">        ${panelsHtml}      </div>      </div>    </article>`;
  }

  /** File:line and source snippet (Playwright HTML report–style) when location exists. */ private renderStepMeta(
    step: StepModel,
  ): string {
    const parts: string[] = [];
    if (step.location) {
      const fp = escapeHtml(step.location.file);
      const base = escapeHtml(path.basename(step.location.file));
      parts.push(
        `<div class="step-meta-loc"><span class="step-meta-file" title="${fp}">${base}</span><span class="step-meta-pos">:${step.location.line}:${step.location.column}</span></div>`,
      );
    }
    if (step.sourceSnippet) {
      parts.push(
        `<pre class="step-source-code"><code>${escapeHtml(step.sourceSnippet)}</code></pre>`,
      );
    }
    return parts.join("");
  }

  private renderStep(step: StepModel, depth: number): string {
    const pad = Math.min(depth, 8);
    const failClass = step.failed ? "fail" : "";
    const meta = this.renderStepMeta(step);
    const imgs =
      step.imageSrcs.length > 0
        ? step.imageSrcs
            .map(
              (src) =>
                `<div class="shot-block"><img src="${escapeHtml(src)}" alt="" title="Click to view full size" loading="eager" /></div>`,
            )
            .join("")
        : "";

    const code =
      step.codeBlocks.length > 0
        ? step.codeBlocks
            .map(
              (b) =>
                `<div class="step-code-block"><div class="step-code-block-label">${escapeHtml(b.label)}</div><pre><code>${escapeHtml(b.text)}</code></pre></div>`,
            )
            .join("")
        : "";

    const others =
      step.otherAttachments.length > 0
        ? `<div class="step-inline-attach-links">${step.otherAttachments.map((o) => `<a class="attach-link" href="${escapeHtml(o.href)}">${escapeHtml(o.label)}</a>`).join("")}</div>`
        : "";

    const err = step.errorMessage
      ? `<pre class="step-error">${escapeHtml(step.errorMessage)}</pre>`
      : "";

    const kids =
      step.children.length > 0
        ? step.children.map((c) => this.renderStep(c, depth + 1)).join("")
        : "";

    /** Screenshots and inline JSON first so expanding a step shows artifacts immediately. */ const bodyInner = `${imgs}${code}${meta}${err}${others}${kids}`;

    if (depth === 0) {
      const rid = randomUUID().slice(0, 12);
      const chipClass = step.failed ? "step-status-fail" : "step-status-pass";
      const chipLabel = step.failed ? "Failed" : "Passed";
      return `    <div class="step step-root step-accordion ${failClass}">      <button type="button" class="step-root-toggle" id="step-root-btn-${rid}" aria-expanded="false">        <span class="step-chevron" aria-hidden="true">▶</span>        <span class="step-title">${escapeHtml(step.title)}</span>        <span class="step-status-chip ${chipClass}">${chipLabel}</span>        <span class="step-cat">${escapeHtml(step.category)}</span>        <span class="step-dur">${escapeHtml(formatStepDuration(step.duration))}</span>      </button>      <div class="step-root-body" id="step-root-panel-${rid}" role="region" aria-labelledby="step-root-btn-${rid}">        ${bodyInner}      </div>    </div>`;
    }

    const nid = randomUUID().slice(0, 12);
    return `    <div class="step step-nested step-nested-accordion ${failClass}" style="margin-left:${pad * 6}px">      <button type="button" class="step-nested-toggle" id="step-nested-btn-${nid}" aria-expanded="false">        <span class="step-nested-chevron" aria-hidden="true">▶</span>        <span class="step-title">${escapeHtml(step.title)}</span>        <span class="step-cat">${escapeHtml(step.category)}</span>        <span class="step-dur">${escapeHtml(formatStepDuration(step.duration))}</span>      </button>      <div class="step-nested-detail" id="step-nested-panel-${nid}" role="region" aria-labelledby="step-nested-btn-${nid}">        ${bodyInner}      </div>    </div>`;
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "attachment";
}
