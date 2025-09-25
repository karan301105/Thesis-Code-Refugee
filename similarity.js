// similarity.js — 7-aspect rule-based similarity & clustering

// ---- helpers ----
function daysBetween(a, b) {
  return Math.abs(+a - +b) / (1000 * 60 * 60 * 24);
}
function iso(d) {
  const t = d ? new Date(d) : null;
  return t && !isNaN(+t) ? t : null;
}
function safeNum(n) {
  return typeof n === "number" && isFinite(n) ? n : null;
}
function arrEqual(a, b) {
  const A = Array.isArray(a) ? a.slice().sort() : [];
  const B = Array.isArray(b) ? b.slice().sort() : [];
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++)
    if (String(A[i]) !== String(B[i])) return false;
  return true;
}

// ---- your 7 rules (pairwise) ----
function simDateStrict(a, b) {
  const da = iso(a),
    db = iso(b);
  if (!da || !db) return 0; // missing => not similar
  return daysBetween(da, db) <= 1 ? 1 : 0; // same or ±1 day
}
function simLocationExact(a, b) {
  const s1 = (a || "").trim().toLowerCase();
  const s2 = (b || "").trim().toLowerCase();
  if (!s1 || !s2) return 0;
  return s1 === s2 ? 1 : 0;
}
function simCountsTolerant(ca, cb) {
  const m1 = safeNum(ca?.male),
    m2 = safeNum(cb?.male);
  const f1 = safeNum(ca?.female),
    f2 = safeNum(cb?.female);
  const k1 = safeNum(ca?.kids),
    k2 = safeNum(cb?.kids);
  const t1 = safeNum(ca?.total ?? (m1 || 0) + (f1 || 0) + (k1 || 0));
  const t2 = safeNum(cb?.total ?? (m2 || 0) + (f2 || 0) + (k2 || 0));
  const okMale = m1 != null && m2 != null ? Math.abs(m1 - m2) <= 1 : false;
  const okFemale = f1 != null && f2 != null ? Math.abs(f1 - f2) <= 1 : false;
  const okKids = k1 != null && k2 != null ? Math.abs(k1 - k2) <= 1 : false;
  const okTotal = t1 != null && t2 != null ? Math.abs(t1 - t2) <= 3 : false;
  // Headcount is "similar" if ALL subrules that are present are satisfied.
  // If none present, return 0.
  const checks = [];
  if (m1 != null && m2 != null) checks.push(okMale);
  if (f1 != null && f2 != null) checks.push(okFemale);
  if (k1 != null && k2 != null) checks.push(okKids);
  if (t1 != null && t2 != null) checks.push(okTotal);
  if (!checks.length) return 0;
  return checks.every(Boolean) ? 1 : 0;
}
function simRansomPct(a, b) {
  const x = safeNum(a),
    y = safeNum(b);
  if (x == null || y == null) return 0;
  const maxv = Math.max(x, y, 1);
  const rel = Math.abs(x - y) / maxv;
  return rel <= 0.1 ? 1 : 0; // ±10%
}
function simEventEqual(a, b) {
  return arrEqual(a, b) ? 1 : 0;
}
function simTransportEqual(a, b) {
  const s1 = (a || "").trim().toLowerCase();
  const s2 = (b || "").trim().toLowerCase();
  if (!s1 || !s2) return 0;
  return s1 === s2 ? 1 : 0;
}
function simConditionsEqual(a, b) {
  return arrEqual(a, b) ? 1 : 0;
}

// overall similarity = weighted average of aspect booleans in {0,1}
export function overallSimilarity(a, b, weights) {
  const parts = [];
  const add = (w, s) => {
    if (!w || w <= 0) return;
    parts.push({ w, s });
  };

  add(weights?.date, simDateStrict(a.date, b.date));
  add(weights?.location, simLocationExact(a.location, b.location));
  add(weights?.counts, simCountsTolerant(a.counts, b.counts));
  add(weights?.ransom, simRansomPct(a.ransom, b.ransom));
  add(weights?.eventTypes, simEventEqual(a.eventTypes, b.eventTypes));
  add(weights?.transport, simTransportEqual(a.transport, b.transport));
  add(weights?.conditions, simConditionsEqual(a.conditions, b.conditions));

  const W = parts.reduce((s, p) => s + p.w, 0);
  if (W === 0) return 0;
  const score = parts.reduce((s, p) => s + p.w * p.s, 0) / W;
  return score; // 0..1
}

// DSU clustering on thresholded pair-wise similarity
class DSU {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.sz = Array(n).fill(1);
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
    if (this.sz[ra] < this.sz[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.sz[ra] += this.sz[rb];
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
    buckets.push({
      bucketId: `bucket-${idx++}`,
      entryIds: ids,
      size: ids.length,
    });
  }
  buckets.sort((a, b) => b.size - a.size);
  return { buckets, pairwise: edges };
}
