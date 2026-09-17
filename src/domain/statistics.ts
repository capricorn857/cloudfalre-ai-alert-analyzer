import { z } from "zod";

export const ConcentrationSchema = z.object({
  value: z.string().min(1),
  count: z.number().int().nonnegative(),
  ratio: z.number().min(0).max(100),
});

export const StatisticsSchema = z.object({
  totalEvents: z.number().int().nonnegative(),
  topIp: ConcentrationSchema.nullable(),
  topPath: ConcentrationSchema.nullable(),
  topCountry: ConcentrationSchema.nullable(),
  topAsn: ConcentrationSchema.nullable(),
  allowRatio: z.number().min(0).max(100).nullable(),
  blockRatio: z.number().min(0).max(100).nullable(),
  challengeRatio: z.number().min(0).max(100).nullable(),
  userAgentConcentration: ConcentrationSchema.nullable(),
  requestRatePerSecond: z.number().nonnegative().nullable(),
  dataSufficient: z.boolean(),
});

export type Concentration = z.infer<typeof ConcentrationSchema>;
export type Statistics = z.infer<typeof StatisticsSchema>;
