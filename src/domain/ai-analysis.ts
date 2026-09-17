import { z } from "zod";

export const AttackTypeSchema = z.enum([
  "Scanning",
  "Brute Force",
  "Credential Stuffing",
  "API Abuse",
  "Bot",
  "Vulnerability Scanning",
  "Unknown",
]);

export const AIAnalysisSchema = z.object({
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  attackType: AttackTypeSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(1000),
  evidence: z.array(z.string().min(1).max(500)).max(10),
  recommendations: z.array(z.string().min(1).max(500)).max(3),
});

export const AIUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.string().min(1),
});

export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;
export type AIUnavailable = z.infer<typeof AIUnavailableSchema>;
