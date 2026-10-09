import { z } from "zod";

export const ATTENTION_SCOPE = { policyId: "exclude-exact-block-v1", eventScope: "attention" } as const;
export const EventScopeSchema = z.object({
  policyId: z.literal(ATTENTION_SCOPE.policyId), eventScope: z.literal(ATTENTION_SCOPE.eventScope),
});
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ScopedDiscoverySchema = EventScopeSchema.extend({
  rawTotalEvents: CountSchema,
  // This is the Zone denominator AFTER filtering, never the raw snapshot total.
  zoneTotalEvents: CountSchema,
  blockedTotalEvents: CountSchema.nullable(),
  rawActions: z.array(z.object({ action: z.string().nullable(), count: CountSchema })).max(20),
  countQuality: z.literal("estimated"),
  topHosts: z.array(z.object({ host: z.string().nullable(), count: CountSchema })).max(10),
}).superRefine((value, context) => {
  if (new Set(value.topHosts.map((host) => host.host)).size !== value.topHosts.length) {
    context.addIssue({ code: "custom", message: "duplicate host" });
  }
});
export const SuppressionDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suppress"), reason: z.literal("no_attention_events_observed") }),
  z.object({ kind: z.literal("raw_empty"), reason: z.literal("raw_window_empty") }),
  z.object({ kind: z.literal("continue") }),
  z.object({ kind: z.literal("degrade"), reason: z.enum(["aggregate_inconsistent", "action_unknown", "action_distribution_incomplete"]) }),
]);
export type ScopedDiscovery = z.infer<typeof ScopedDiscoverySchema>;
export type SuppressionDecision = z.infer<typeof SuppressionDecisionSchema>;
