import { APIConnectionError, APIError, APITimeoutError, TypeSafeError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { isJevOutage } from "../src/jev.js";

const http = (status: number) => APIError.fromResponse(status, { error: "x" }, new Headers());

describe("which Jev failures fall back", () => {
  it("treats connection failures, timeouts, rate limits and server errors as an outage", () => {
    for (const e of [new APIConnectionError("socket closed"), new APITimeoutError(60_000), http(408), http(429), http(500), http(503), http(529)]) {
      expect(isJevOutage(e), e.constructor.name).toBe(true);
    }
  });

  it("treats everything else as a misconfiguration that must fail the step", () => {
    const missingKey = new TypeSafeError("The TYPESAFE_API_KEY environment variable is missing");
    for (const e of [http(400), http(401), http(403), http(404), http(422), missingKey, new TypeError("Cannot read properties of undefined"), "boom"]) {
      expect(isJevOutage(e), String(e)).toBe(false);
    }
  });
});
