import { APIResponse, TestInfo } from "@playwright/test";

export async function attachApiResponse(
  name: string,
  response: APIResponse,
  testInfo: TestInfo,
) {
  const body = await response.json().catch(() => response.text());
  const status = response.status();
  const headers = response.headers();

  const reportData = {
    url: response.url(),
    status,
    headers,
    body,
  };

  await testInfo.attach(name, {
    body: JSON.stringify(reportData, null, 2),
    contentType: "application/json",
  });
}

export async function attachApiRequestBody(
  name: string,
  data: any,
  testInfo: TestInfo,
) {
  await testInfo.attach(name, {
    body: JSON.stringify(data, null, 2),
    contentType: "application/json",
  });
}
