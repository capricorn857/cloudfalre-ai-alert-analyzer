import { describe, expect, it } from "vitest";

import { parseEnv } from "../../../src/config/env";

const businessConfig = {
  beforeMinutes: 30,
  settleSeconds: 60,
  sampleLimit: 50,
  requestTimeoutMs: 10_000,
  retryCount: 2,
  displayTimeZone: "Asia/Shanghai",
  rules: {
    ipConcentration: { medium: 30, high: 50 },
    pathConcentration: { medium: 30, high: 50 },
    countryConcentration: { medium: 40, high: 70 },
    asnConcentration: { medium: 40, high: 70 },
    allowRatio: { medium: 50, high: 80 },
    blockRatio: { medium: 50, high: 80 },
    userAgentConcentration: { medium: 50, high: 80 },
    requestRate: { medium: 5, high: 20 },
  },
};

const validEnv = {
  ALERT_QUEUE: { send: () => Promise.resolve() },
  CLOUDFLARE_API_TOKEN: "cf-test-secret",
  LLM_API_KEY: "llm-test-secret",
  WECOM_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
  LLM_BASE_URL: "https://llm.example.test/v1",
  LLM_MODEL: "test-model",
  BUSINESS_CONFIG: businessConfig,
};

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

export { businessConfig, validEnv };
