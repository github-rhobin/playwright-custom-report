import { test, expect } from "@playwright/test";
import { attachStepJson } from "../src/utils/api-util";

test(
  "API test - POST request",
  { tag: "@api-test" },
  async ({ request }) => {
    const requestData = {
      firstname: "John",
      lastname: "Doe",
      totalprice: 1000,
      depositpaid: true,
      bookingdates: {
        checkin: "2026-12-31",
        checkout: "2027-01-01",
      },
      additionalneeds: "Playwright API Test",
    };

    await test.step("Attach API request body", async (step) => {
      await attachStepJson(step, "Request body", requestData);
    });

    const response = await request.post(
      "https://restful-booker.herokuapp.com/booking",
      {
        data: requestData,
        timeout: 10_000,
      },
    );

    const status = response.status();
    const statusText = response.statusText();
    const headers = response.headers();
    const responseBody = await response.json();

    const fullResponse = {
      status, statusText, headers, responseBody,
    }


    await test.step("Attach API response body", async (step) => {
      await attachStepJson(step, "Response body", fullResponse);
    });

    await test.step("Validate Response Status", async () => {
      expect(response.status()).toBe(200);
      expect(response).toBeOK();
    });

    await test.step("Validate Response Body", async () => {
      expect(responseBody.booking.firstname).toBe("John");
      expect(responseBody.booking.totalprice).toBe(1000);
      expect(responseBody.booking.depositpaid).toBe(true);

      expect(responseBody).toMatchObject({
        bookingid: expect.any(Number),
        booking: {
          firstname: "John",
          lastname: "Doe",
          totalprice: 1000,
          depositpaid: true,
          bookingdates: expect.objectContaining({
            checkin: "2026-12-31",
          }),
          additionalneeds: "Playwright API Test",
        },
      });
    });

    /**
     * ASSERTION SUMMARY REFERENCE
     * ----------------------------------------------------------------------------------------------------------------------------------------------------
     * | Assertion                | Best Used For                        | Comparison Type                                                                |
     * |--------------------------|--------------------------------------|--------------------------------------------------------------------------------|
     * | .toBe()                  | Status codes, booleans, exact strings| Identity/Strict (===) - Checks if they are the exact same instance in memory.  |
     * | .toEqual()               | Full JSON objects or Arrays          | Deep Equality -  Recursively checks if all fields and values inside match.     |
     * | .toMatchObject()         | Checking specific fields in a JSON   | Partial Match                                                                  |
     * | .toBeOK()                | Quick 200-299 status check           | Range check                                                                    |
     * | expect.objectContaining()| Partial matches inside Arrays/Objects| Asymmetric Matcher                                                             |
     * ----------------------------------------------------------------------------------------------------------------------------------------------------
     */
  },
);
