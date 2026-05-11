import { test, expect, APIResponse } from "@playwright/test";
import { attachStepJson, getFullResponse } from "../src/utils/api-util";

test.describe("JSONPlaceholder API Operations", { tag: "@api-test" }, () => {
  const BASE_URL = "https://jsonplaceholder.typicode.com";

  test("GET - retrieve post with id 1", async ({ request }, testInfo) => {
    let response: APIResponse;

    await test.step("GET Request", async () => {
      response = await request.get(`${BASE_URL}/posts/1`);
    });

    await test.step("Full Response", async () => {
      const fullResponse = await getFullResponse(response);
      await attachStepJson(testInfo, "Full Response", fullResponse);
    });

    await test.step("Response Validation", async () => {
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.id).toBe(1);
    });
  });

  test("POST - create a new resource", async ({ request }, testInfo) => {
    const requestData = { title: "foo", body: "bar", userId: 1 };
    let response: APIResponse;

    await test.step("Request Body", async () => {
      await attachStepJson(testInfo, "Request JSON", requestData);
    });

    await test.step("POST Request", async () => {
      response = await request.post(`${BASE_URL}/posts`, { data: requestData });
    });

    await test.step("Full Response", async () => {
      const fullResponse = await getFullResponse(response);
      await attachStepJson(testInfo, "Full Response", fullResponse);
    });

    await test.step("Response Validation", async () => {
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body.id).toBe(101);
    });
  });

  test("PUT - update resource id 1", async ({ request }, testInfo) => {
    const requestData = {
      id: 1,
      title: "foo",
      body: "bar",
      userId: 1,
    };
    let response: APIResponse;

    await test.step("Request Body", async () => {
      await attachStepJson(testInfo, "Request JSON", requestData);
    });

    await test.step("PUT Request", async () => {
      response = await request.put(`${BASE_URL}/posts/1`, {
        data: requestData,
      });
    });

    await test.step("Full Response", async () => {
      const fullResponse = await getFullResponse(response);
      await attachStepJson(testInfo, "Full Response", fullResponse);
    });

    await test.step("Response Validation", async () => {
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.title).toBe("foo");
    });
  });

  test("DELETE - intentional failure for reporting", async ({
    request,
  }, testInfo) => {
    let response: APIResponse;

    await test.step("DELETE Request", async () => {
      response = await request.delete(`${BASE_URL}/posts/1`);
    });

    await test.step("Full Response", async () => {
      const fullResponse = await getFullResponse(response);
      await attachStepJson(testInfo, "Full Response", fullResponse);
    });

    await test.step("Response Validation", async () => {
      // JSONPlaceholder returns 200/OK. Asserting 404 to trigger fail handler.
      expect(
        response.status(),
        "Checking if failed test handler triggers",
      ).toBe(404);
    });
  });
});
