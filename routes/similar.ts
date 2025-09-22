// src/routes/similar.ts (or routes/similar.js)
import { Router } from "express";
import { groupSimilarEntries } from "../services/similarServices";
import { getConsentedEntries } from "../data/consentedEntries";

const router = Router();

router.get("/api/entries/similar", async (req, res) => {
  const threshold = req.query.threshold
    ? Number(req.query.threshold)
    : undefined;
  let weights: any;
  if (req.query.weights) {
    try {
      weights = JSON.parse(String(req.query.weights));
    } catch {}
  }

  const entries = await getConsentedEntries(/* req */);

  // Build a minimal map by id/link for the frontend to render
  const entryById: Record<
    string,
    { id: string; link: string; date?: string; location?: string }
  > = {};
  for (const r of entries) {
    const id = r.id || r.link || r.url;
    if (!id) continue;
    entryById[id] = {
      id,
      link: r.link || r.url || r.id,
      date: r.date,
      location: r.location,
    };
  }

  const result = groupSimilarEntries(entries, { threshold, weights });
  res.json({ ...result, entryById });
});

export default router;
