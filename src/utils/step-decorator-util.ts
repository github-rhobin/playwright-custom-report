import { test } from "@playwright/test";


/**
 * Wraps the method in {@link test.step} so the action appears as a named step in HTML / trace reports.
 *
 * Pair with {@link takeScreenshot} from `./screenshot-util` inside the method so PNGs nest under that step
 * in the custom HTML report.
 */
export function step(stepName?: string) {
  return function decorator(
    target: Function,
    context: ClassMethodDecoratorContext,
  ) {
    return function replacementMethod(this: object, ...args: unknown[]) {
      const name =
        stepName ??
        `${this.constructor.name}.${String(context.name)}`;
      return test.step(name, async () => target.call(this, ...args));
    };
  };
}