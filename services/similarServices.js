// services/similarServices.js
import { clusterEntries } from "../similarity.js";

export function groupSimilarEntries(rawEntries, opts = {}) {
  const entries = (rawEntries || []).map((r) => ({
    id: r.id || r.link || r.url,
    date: r.date,
    location: r.location,
    counts: { male: r.male, female: r.female, kids: r.kids, total: r.total },
    ransom: r.ransom,
    eventTypes: Array.isArray(r.eventTypes)
      ? r.eventTypes
      : r.eventTypes
        ? [r.eventTypes]
        : [],
    transport: r.transport || null,
    conditions: Array.isArray(r.conditions)
      ? r.conditions
      : r.conditions
        ? [r.conditions]
        : [],
  }));

  // Equal weights by default across 7 aspects
  const weights = {
    date: 1,
    location: 1,
    counts: 1,
    ransom: 1,
    eventTypes: 1,
    transport: 1,
    conditions: 1,
    ...(opts?.weights || {}),
  };

  const threshold = opts?.threshold ?? 0.7; // e.g., need ≥70% of aspects to match
  return clusterEntries(entries, weights, threshold);
}
