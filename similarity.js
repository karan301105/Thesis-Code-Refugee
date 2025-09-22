// JS twin of similarity.ts (no types, ESM exports)

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

function safeNum(n) {
  return typeof n === "number" && isFinite(n) ? n : null;
}
function isoToDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  return isNaN(+dt) ? null : dt;
}
function daysBetween(a, b) {
  return Math.abs(+a - +b) / (1000 * 60 * 60 * 24);
}
function tokenizeLocation(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9, ]+/g, " ")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t));
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  const L = Math.max(a.length, b.length);
  for (let i = 0; i < L; i++) {
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

// ---- per-field similarities ----
function simDate(a, b, tauDays = 7) {
  const da = isoToDate(a);
  const db = isoToDate(b);
  if (!da || !db) return 0;
  const d = daysBetween(da, db);
  return Math.exp(-d / tauDays);
}
function simLocation(a, b) {
  const ta = tokenizeLocation(a);
  const tb = tokenizeLocation(b);
  const sa = new Set(ta);
  const sb = new Set(tb);
  let score = jaccard(sa, sb);
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
  if (aLast && bLast && aLast === bLast) score = Math.min(1, score + 0.15);
  return score;
}
function simCounts(ca, cb) {
  if (!ca && !cb) return 0;
  const aMale = safeNum(ca?.male) ?? 0;
  const aFemale = safeNum(ca?.female) ?? 0;
  const aKids = safeNum(ca?.kids) ?? 0;
  const aTotal =
    (safeNum(ca ? ca.total : null) ?? aMale + aFemale + aKids) || 0;

  const bMale = safeNum(cb?.male) ?? 0;
  const bFemale = safeNum(cb?.female) ?? 0;
  const bKids = safeNum(cb?.kids) ?? 0;
  const bTotal =
    (safeNum(cb ? cb.total : null) ?? bMale + bFemale + bKids) || 0;

  return cosine(
    [aMale, aFemale, aKids, aTotal],
    [bMale, bFemale, bKids, bTotal],
  );
}
function simRansom(a, b) {
  const na = safeNum(a),
    nb = safeNum(b);
  if (na === null && nb === null) return 0;
  if (na === null || nb === null) return 0;
  const maxv = Math.max(na, nb, 1);
  const diff = Math.abs(na - nb);
  return Math.max(0, 1 - diff / maxv);
}

export function overallSimilarity(a, b, weights) {
  const parts = [];
  const add = (w, s) => {
    if (!w || w <= 0 || s == null || isNaN(s)) return;
    parts.push({ w, s });
  };
  add(weights?.date, simDate(a.date, b.date));
  add(weights?.location, simLocation(a.location, b.location));
  add(weights?.counts, simCounts(a.counts, b.counts));
  add(weights?.ransom, simRansom(a.ransom, b.ransom));
  const W = parts.reduce((acc, p) => acc + p.w, 0);
  if (W === 0) return 0;
  const num = parts.reduce((acc, p) => acc + p.w * p.s, 0);
  return num / W;
}

// ---- clustering via DSU ----
class DSU {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = Array(n).fill(1);
  }
  find(x) {
    return this.parent[x] === x
      ? x
      : (this.parent[x] = this.find(this.parent[x]));
  }
  union(a, b) {
    let ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
  }
}

export function clusterEntries(entries, weights, threshold = 0.7) {
  const n = entries.length;
  const dsu = new DSU(n);
  const edges = [];

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

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const buckets = [];
  let idx = 1;
  for (const arr of groups.values()) {
    const ids = arr.map((i) => entries[i].id);

    const dates = arr.map((i) => entries[i].date).filter(Boolean);
    const sortedDates = dates.slice().sort();
    const dateRange = dates.length
      ? {
          earliest: sortedDates[0],
          latest: sortedDates[sortedDates.length - 1],
        }
      : undefined;

    const tokenCounts = new Map();
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

    buckets.push({
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
      ransomAvg: ransomAvg == null ? null : +ransomAvg.toFixed(2),
    });
  }

  buckets.sort((a, b) => b.size - a.size);
  return { buckets, pairwise: edges };
}
