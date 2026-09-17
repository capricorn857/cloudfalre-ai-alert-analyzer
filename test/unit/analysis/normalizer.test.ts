import { describe, expect, it } from "vitest";

import { normalizeIncident } from "../../../src/analysis/normalizer";
import { IncidentSchema } from "../../../src/domain/incident";
import { queueMessage, snapshot } from "../../fixtures/domain";

describe("normalizeIncident", () => {
  it("maps a validated snapshot into the Incident contract", () => {
    const incident = normalizeIncident(queueMessage, snapshot);

    expect(IncidentSchema.parse(incident)).toEqual(incident);
    expect(incident.payloadEventsCount).toBe(394);
    expect(incident.totalEvents).toBe(400);
    expect(incident.analysisWindow).toEqual(queueMessage.analysisWindow);
    expect(incident.evidence.actions).toContainEqual({ value: "managed_challenge", count: 20 });
    expect(incident).not.toHaveProperty("rawResponse");
  });
});
