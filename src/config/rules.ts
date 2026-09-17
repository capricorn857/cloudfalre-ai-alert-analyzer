import { z } from "zod";

export const ThresholdSchema = z
  .object({
    medium: z.number().nonnegative(),
    high: z.number().positive(),
  })
  .refine(({ medium, high }) => medium < high, {
    message: "high threshold must be greater than medium threshold",
  });

export const RulesConfigSchema = z.object({
  ipConcentration: ThresholdSchema,
  pathConcentration: ThresholdSchema,
  countryConcentration: ThresholdSchema,
  asnConcentration: ThresholdSchema,
  allowRatio: ThresholdSchema,
  blockRatio: ThresholdSchema,
  userAgentConcentration: ThresholdSchema,
  requestRate: ThresholdSchema,
});

export type RulesConfig = z.infer<typeof RulesConfigSchema>;
