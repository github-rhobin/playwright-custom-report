import type { TestStepInfo, APIResponse } from "@playwright/test";

function serializeJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Attach pretty-printed JSON to the **current** `test.step` (use {@link TestStepInfo.attach}).
 * Skips attaching when `data` is `null` or `undefined` (e.g. no request body for GET).
 *
 * The custom HTML reporter inlines `application/json` attachments as a code block under the step,
 * similar to step screenshots.
 */
export async function attachStepJson(
  step: TestStepInfo,
  name: string,
  data: unknown,
): Promise<void> {
  if (data === null || data === undefined) {
    return;
  }
  await step.attach(name, {
    body: serializeJson(data),
    contentType: "application/json",
  });
}

/**
 * Extracts and formats status, headers, and body from an APIResponse.
 */
export async function getFullResponse(response: APIResponse) {
  return {
    status: response.status(),
    statusText: response.statusText(),
    headers: response.headers(),
    body: await response.json(),
  };
}