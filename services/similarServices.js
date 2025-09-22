// JS twin of similarServices.ts
import { clusterEntries } from "../similarity.js";

/**
 * Normalize your raw entries into the format expected by clustering
 * and run the clustering with optional weights/threshold overrides.
 */
export function groupSimilarEntries(rawEntries, opts = {}) {
  const entries = (rawEntries || []).map((r) => ({
    id: r.id || r.link || r.url,
    date: r.date,
    location: r.location,
    counts: { male: r.male, female: r.female, kids: r.kids, total: r.total },
    ransom: r.ransom,
  }));

  const weights = {
    date: 0.25,
    location: 0.35,
    counts: 0.25,
    ransom: 0.15,
    ...(opts.weights || {}),
  };

  const threshold = opts.threshold ?? 0.7;
  return clusterEntries(entries, weights, threshold);
}
