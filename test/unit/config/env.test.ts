import { describe, expect, it } from "vitest";

import { parseEnv } from "../../../src/config/env";
import { businessConfig, validEnv } from "../../fixtures/config";

describe("parseEnv", () => {
  it("parses complete bindings and freezes business configuration", () => {
    const result = parseEnv(validEnv);

    expect(result.business.beforeMinutes).toBe(30);
    expect(Object.isFrozen(result.business)).toBe(true);
  });

  it("accepts BUSINESS_CONFIG as JSON text", () => {
    const result = parseEnv({ ...validEnv, BUSINESS_CONFIG: JSON.stringify(businessConfig) });

    expect(result.business.sampleLimit).toBe(50);
  });

  it("defaults the LLM timeout to 30 seconds", () => {
    const result = parseEnv(validEnv);

    expect(result.business.llmTimeoutMs).toBe(30_000);
  });

  it.each([1_000, 60_000, 120_000])(
    "accepts an explicit LLM timeout override of %i milliseconds",
    (llmTimeoutMs) => {
      const result = parseEnv({
        ...validEnv,
        BUSINESS_CONFIG: { ...businessConfig, llmTimeoutMs },
      });

      expect(result.business.llmTimeoutMs).toBe(llmTimeoutMs);
    },
  );

  it.each([999, 120_001, 1_500.5, "30000"])(
    "rejects an invalid LLM timeout override of %j",
    (llmTimeoutMs) => {
      expect(() =>
        parseEnv({
          ...validEnv,
          BUSINESS_CONFIG: { ...businessConfig, llmTimeoutMs },
        }),
      ).toThrow(/BUSINESS_CONFIG\.llmTimeoutMs/u);
    },
  );

  it("rejects missing secrets without including other secret values", () => {
    const missing: Record<string, unknown> = { ...validEnv };
    delete missing.LLM_API_KEY;

    expect(() => parseEnv(missing)).toThrow(/LLM_API_KEY/u);
    try {
      parseEnv(missing);
    } catch (error) {
      expect(String(error)).not.toContain(validEnv.CLOUDFLARE_API_TOKEN);
    }
  });

  it("rejects unsafe parameters and non-increasing thresholds", () => {
    expect(() =>
      parseEnv({ ...validEnv, BUSINESS_CONFIG: { ...businessConfig, retryCount: 3 } }),
    ).toThrow();
    expect(() =>
      parseEnv({
        ...validEnv,
        BUSINESS_CONFIG: {
          ...businessConfig,
          rules: {
            ...businessConfig.rules,
            allowRatio: { medium: 90, high: 80 },
          },
        },
      }),
    ).toThrow();
  });
});
