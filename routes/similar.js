// routes/similar.js
import { Router } from "express";
import { groupSimilarEntries } from "../services/similarServices.js";
import { getConsentedEntries } from "../data/consentedEntries.js";

const router = Router();

// helper for stats
function stats(nums) {
  const arr = nums.filter((x) => typeof x === "number" && isFinite(x));
  if (!arr.length) return null;
  arr.sort((a, b) => a - b);
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? arr[(n - 1) / 2] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
  const min = arr[0],
    max = arr[n - 1];
  return { n, mean, median, min, max };
}

router.get("/api/entries/similar", async (req, res) => {
  const threshold = req.query.threshold
    ? Number(req.query.threshold)
    : undefined;
  let weights;
  if (req.query.weights) {
    try {
      weights = JSON.parse(String(req.query.weights));
    } catch {}
  }

  const rows = await getConsentedEntries();
  const result = groupSimilarEntries(rows, { threshold, weights });

  // Build entryById with identity + display fields
  const entryById = {};
  for (const r of rows) {
    const id = r.id || r.link || r.url;
    if (!id) continue;
    entryById[id] = {
      id,
      personId: r.personId || id,
      date: r.date || null,
      location: r.location || null,
      ransom: r.ransom ?? null,
      counts: {
        male: r.male ?? null,
        female: r.female ?? null,
        kids: r.kids ?? null,
        total: r.total ?? null,
      },
      link: r.link || r.url || r.id,
    };
  }

  // Compute a concise summary per bucket (what’s common/similar)
  const buckets = result.buckets.map((b) => {
    // ransom stats
    const ransomVals = b.entryIds
      .map((id) => entryById[id]?.ransom)
      .filter((v) => typeof v === "number" && isFinite(v));
    const ransomStats = stats(ransomVals);

    // avg counts
    let male = 0,
      female = 0,
      kids = 0,
      total = 0,
      cnt = 0;
    b.entryIds.forEach((id) => {
      const c = entryById[id]?.counts;
      if (!c) return;
      male += Number(c.male || 0);
      female += Number(c.female || 0);
      kids += Number(c.kids || 0);
      total += Number(
        c.total != null
          ? c.total
          : (c.male || 0) + (c.female || 0) + (c.kids || 0),
      );
      cnt++;
    });
    const countsAvg = cnt
      ? {
          male: +(male / cnt).toFixed(1),
          female: +(female / cnt).toFixed(1),
          kids: +(kids / cnt).toFixed(1),
          total: +(total / cnt).toFixed(1),
        }
      : null;

    // most common full location string (not just tokens)
    const locCount = new Map();
    b.entryIds.forEach((id) => {
      const loc = (entryById[id]?.location || "").trim().toLowerCase();
      if (!loc) return;
      locCount.set(loc, (locCount.get(loc) || 0) + 1);
    });
    const commonLocations = Array.from(locCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([loc, count]) => ({ location: loc, count }));

    return {
      ...b,
      summary: {
        dateRange: b.dateRange || null,
        ransom: ransomStats
          ? {
              mean: +ransomStats.mean.toFixed(2),
              median: +ransomStats.median.toFixed(2),
              min: ransomStats.min,
              max: ransomStats.max,
              n: ransomStats.n,
            }
          : null,
        countsAvg,
        commonLocations, // lowercase; UI can prettify
        topLocationTokens: b.locationTokensTop || [],
      },
    };
  });

  res.json({ buckets, entryById, pairwise: result.pairwise });
});

export default router;
