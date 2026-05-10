import { test, expect } from "@playwright/test";
import { attachApiRequestBody, attachApiResponse } from "../src/utils/api-util";

test(
  "API test - POST request",
  { tag: "@api-test" },
  async ({ request }, testInfo) => {
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

    // test.step("Attach API POST Request", async (step) => {
    //   await step.attach("Request Body", {
    //     body: JSON.stringify(requestData, null, 2),
    //     contentType: "application/json",
    //   });
    // });

    test.step("Attach API Request Body", async (step) => {
      await attachApiRequestBody("Request Body", requestData, testInfo);
    });


    const response = await request.post(
      "https://restful-booker.herokuapp.com/booking",
      {
        data: requestData,
        timeout: 10_000, // allotted response time 10s
      },
    );

    const responseBody = await response.json();
    const stringifiedResponseBody = JSON.stringify(responseBody, null, 2);

    test.step("Attach API Response", async (step) => {
      await attachApiResponse("Response", response, testInfo);
    });

    test.step("Validate Response Status", async () => {
      // Test Response Status
      // Strict check for a specific code
      expect(response.status()).toBe(200);
      // Flexible check for any success code (200-299)
      expect(response).toBeOK();
    });

    test.step("Validate Response Body", async () => {
      // responseBody validation - single properties
      expect(responseBody.booking.firstname).toBe("John");
      expect(responseBody.booking.totalprice).toBe(1000);
      expect(responseBody.booking.depositpaid).toBe(true);

      // responseBody validation - using .toMAtchObject({<property:value> orders does not matter})
      expect(responseBody).toMatchObject({
        bookingid: expect.any(Number), // this is auto generated so just check the type
        booking: {
          firstname: "John",
          lastname: "Doe",
          totalprice: 1000,
          depositpaid: true,

          // Partial Contents Validation
          // expect.arrayContaining([])
          // expect.objectContaining({})
          bookingdates: expect.objectContaining({
            checkin: "2026-12-31",
            // checkout valiadtion can be included
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
