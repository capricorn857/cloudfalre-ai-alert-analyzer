export const businessConfig = {
  beforeMinutes: 30,
  settleSeconds: 60,
  sampleLimit: 50,
  requestTimeoutMs: 10_000,
  llmMaxOutputTokens: 2048,
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

export const validEnv = {
  ALERT_QUEUE: { send: () => Promise.resolve() },
  CLOUDFLARE_API_TOKEN: "cf-test-secret",
  LLM_API_KEY: "llm-test-secret",
  WECOM_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
  LLM_BASE_URL: "https://llm.example.test/v1",
  LLM_MODEL: "test-model",
  BUSINESS_CONFIG: businessConfig,
};
