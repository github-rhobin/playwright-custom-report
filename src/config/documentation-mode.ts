/**
 * Toggle {@link DOCUMENTATION_MODE} for local runs; CI always behaves like `"off"`.
 */
export const DOCUMENTATION_MODE = "on" as "off" | "on";


/**
 * When `true`, {@link takeScreenshot} attaches PNGs under the current `test.step` for the custom HTML report.
 * In CI this is always `false` so pipelines stay lean.
 */
export function documentationModeEffective(): boolean {
  if (process.env.CI) return false;
  return DOCUMENTATION_MODE.toLowerCase() === "on";
}