// src/services/similarService.ts
import { clusterEntries, Weights, JournalEntry } from "../similarity";

export function groupSimilarEntries(
  rawEntries: any[], // whatever your DB/Solid fetch returns
  opts?: { weights?: Weights; threshold?: number },
) {
  const entries: JournalEntry[] = rawEntries.map((r: any) => ({
    id: r.id || r.link || r.url,
    date: r.date, // ensure ISO
    location: r.location,
    counts: { male: r.male, female: r.female, kids: r.kids, total: r.total },
    ransom: r.ransom,
  }));

  const weights: Weights = {
    date: 0.25,
    location: 0.35,
    counts: 0.25,
    ransom: 0.15,
    ...(opts?.weights || {}),
  };

  const threshold = opts?.threshold ?? 0.7;

  return clusterEntries(entries, weights, threshold);
}
