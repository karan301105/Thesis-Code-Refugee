// src/similarity.ts
export type JournalEntry = {
  id: string; // solid resource url or your internal id
  date?: string; // ISO date e.g. "2025-09-11"
  location?: string; // e.g. "Budapest, Central Hungary, Hungary"
  counts?: { male?: number; female?: number; kids?: number; total?: number };
  ransom?: number; // numeric currency amount; same currency ideally
  // ...you can add more fields later (e.g., tags, free-text)
};

export type Weights = {
  date?: number;
  location?: number;
  counts?: number;
  ransom?: number;
};

export type SimilarBucket = {
  bucketId: string;
  entryIds: string[];
  size: number;
  similarityEdges: Array<{ a: string; b: string; score: number }>;
  // quick aggregates for the NGO UI:
  dateRange?: { earliest?: string; latest?: string };
  locationTokensTop?: Array<{ token: string; count: number }>;
  countsAvg?: { male: number; female: number; kids: number; total: number };
  ransomAvg?: number | null;
};

// ----------------------------- Utilities --------------------------------

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "to",
  "in",
  "on",
  "at",
  "de",
  "la",
  "el",
  "le",
  "du",
  "von",
  "province",
  "voivodeship",
  "state",
  "county",
  "region",
  "district",
  "city",
  "town",
]);

function safeNum(n?: number): number | null {
  return typeof n === "number" && isFinite(n) ? n : null;
}

function isoToDate(d?: string): Date | null {
  if (!d) return null;
  const dt = new Date(d);
  return isNaN(+dt) ? null : dt;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(+a - +b) / (1000 * 60 * 60 * 24);
}

function tokenizeLocation(s?: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9, ]+/g, " ")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 && nb === 0) return 1;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ----------------------- Per-field similarities --------------------------

/** Date similarity: exponential decay by days difference. Tau controls tolerance. */
function simDate(a?: string, b?: string, tauDays = 7): number {
  const da = isoToDate(a);
  const db = isoToDate(b);
  if (!da || !db) return 0;
  const d = daysBetween(da, db);
  // exp(-d/tau) → 1 when same day, ~0.37 at d=tau
  return Math.exp(-d / tauDays);
}

/** Location similarity: Jaccard over tokens + small bonus for matching last token (often country). */
function simLocation(a?: string, b?: string): number {
  const ta = tokenizeLocation(a);
  const tb = tokenizeLocation(b);
  const sa = new Set(ta);
  const sb = new Set(tb);
  let score = jaccard(sa, sb);
  // country/city heuristic: match on last comma-separated token
  const aLast = a
    ?.toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  const bLast = b
    ?.toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (aLast && bLast && aLast === bLast) {
    score = Math.min(1, score + 0.15);
  }
  return score;
}

/** Counts similarity: cosine over [male,female,kids,total]. If total missing, sum subcounts. */
function simCounts(
  ca?: JournalEntry["counts"],
  cb?: JournalEntry["counts"],
): number {
  if (!ca && !cb) return 0;
  const aMale = safeNum(ca?.male) ?? 0;
  const aFemale = safeNum(ca?.female) ?? 0;
  const aKids = safeNum(ca?.kids) ?? 0;
  const aTotal = safeNum(ca?.total) ?? (aMale + aFemale + aKids || 0);

  const bMale = safeNum(cb?.male) ?? 0;
  const bFemale = safeNum(cb?.female) ?? 0;
  const bKids = safeNum(cb?.kids) ?? 0;
  const bTotal = safeNum(cb?.total) ?? (bMale + bFemale + bKids || 0);

  return cosine(
    [aMale, aFemale, aKids, aTotal],
    [bMale, bFemale, bKids, bTotal],
  );
}

/** Ransom similarity: 1 - |a-b| / max(a,b). Robust to scale; returns 0 if both missing. */
function simRansom(a?: number, b?: number): number {
  const na = safeNum(a),
    nb = safeNum(b);
  if (na === null && nb === null) return 0;
  if (na === null || nb === null) return 0;
  const maxv = Math.max(na, nb, 1);
  const diff = Math.abs(na - nb);
  return Math.max(0, 1 - diff / maxv);
}

// ---------------------- Aggregation & clustering -------------------------

export function overallSimilarity(
  a: JournalEntry,
  b: JournalEntry,
  weights: Weights,
): number {
  const parts: Array<{ w: number; s: number }> = [];

  const add = (w?: number, s?: number) => {
    if (!w || w <= 0 || s === undefined || s === null || isNaN(s)) return;
    parts.push({ w, s });
  };

  add(weights.date, simDate(a.date, b.date));
  add(weights.location, simLocation(a.location, b.location));
  add(weights.counts, simCounts(a.counts, b.counts));
  add(weights.ransom, simRansom(a.ransom, b.ransom));

  const W = parts.reduce((acc, p) => acc + p.w, 0);
  if (W === 0) return 0;
  const num = parts.reduce((acc, p) => acc + p.w * p.s, 0);
  return num / W; // weighted average in [0,1]
}

// Simple Union-Find for connected components
class DSU {
  parent: number[];
  size: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = Array(n).fill(1);
  }
  find(x: number): number {
    return this.parent[x] === x
      ? x
      : (this.parent[x] = this.find(this.parent[x]));
  }
  union(a: number, b: number) {
    let ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
  }
}

/**
 * Cluster entries into buckets where overallSimilarity >= threshold creates an edge.
 * Complexity: O(n^2). For n ~ few thousands it's fine; for larger, consider LSH.
 */
export function clusterEntries(
  entries: JournalEntry[],
  weights: Weights,
  threshold = 0.7,
): {
  buckets: SimilarBucket[];
  pairwise: Array<{ a: string; b: string; score: number }>;
} {
  const n = entries.length;
  const dsu = new DSU(n);
  const edges: Array<{ a: string; b: string; score: number }> = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = overallSimilarity(entries[i], entries[j], weights);
      if (s >= threshold) {
        dsu.union(i, j);
        edges.push({
          a: entries[i].id,
          b: entries[j].id,
          score: +s.toFixed(3),
        });
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }

  const buckets: SimilarBucket[] = [];
  let idx = 1;

  for (const arr of groups.values()) {
    const ids = arr.map((i) => entries[i].id);

    // aggregates
    const dates = arr.map((i) => entries[i].date).filter(Boolean) as string[];
    const sortedDates = dates.slice().sort(); // ISO sorts by time
    const dateRange = dates.length
      ? {
          earliest: sortedDates[0],
          latest: sortedDates[sortedDates.length - 1],
        }
      : undefined;

    const tokenCounts = new Map<string, number>();
    arr.forEach((i) => {
      tokenizeLocation(entries[i].location).forEach((t) => {
        tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
      });
    });
    const locationTokensTop = Array.from(tokenCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([token, count]) => ({ token, count }));

    let male = 0,
      female = 0,
      kids = 0,
      total = 0,
      cntCounts = 0;
    arr.forEach((i) => {
      const c = entries[i].counts;
      if (!c) return;
      male += c.male ?? 0;
      female += c.female ?? 0;
      kids += c.kids ?? 0;
      const t = c.total ?? (c.male ?? 0) + (c.female ?? 0) + (c.kids ?? 0);
      total += t;
      cntCounts++;
    });
    const countsAvg = cntCounts
      ? {
          male: male / cntCounts,
          female: female / cntCounts,
          kids: kids / cntCounts,
          total: total / cntCounts,
        }
      : { male: 0, female: 0, kids: 0, total: 0 };

    let ransomSum = 0,
      ransomN = 0;
    arr.forEach((i) => {
      const r = entries[i].ransom;
      if (typeof r === "number" && isFinite(r)) {
        ransomSum += r;
        ransomN++;
      }
    });
    const ransomAvg = ransomN ? ransomSum / ransomN : null;

    const bucket: SimilarBucket = {
      bucketId: `bucket-${idx++}`,
      entryIds: ids,
      size: ids.length,
      similarityEdges: edges.filter(
        (e) => ids.includes(e.a) && ids.includes(e.b),
      ),
      dateRange,
      locationTokensTop,
      countsAvg: {
        male: +countsAvg.male.toFixed(1),
        female: +countsAvg.female.toFixed(1),
        kids: +countsAvg.kids.toFixed(1),
        total: +countsAvg.total.toFixed(1),
      },
      ransomAvg: ransomAvg === null ? null : +ransomAvg.toFixed(2),
    };

    buckets.push(bucket);
  }

  // Sort: biggest buckets first
  buckets.sort((a, b) => b.size - a.size);
  return { buckets, pairwise: edges };
}
