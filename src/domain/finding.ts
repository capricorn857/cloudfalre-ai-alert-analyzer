import { z } from "zod";

export const FindingTypeSchema = z.enum([
  "ip_concentration",
  "path_concentration",
  "country_concentration",
  "asn_concentration",
  "allow_ratio",
  "block_ratio",
  "user_agent_concentration",
  "request_rate",
]);

export const FindingSchema = z.object({
  type: FindingTypeSchema,
  level: z.enum(["medium", "high", "unknown"]),
  value: z.number().nonnegative().nullable(),
  threshold: z.number().nonnegative().nullable(),
  evidence: z.string().min(1),
});

export type Finding = z.infer<typeof FindingSchema>;
export type FindingType = z.infer<typeof FindingTypeSchema>;
