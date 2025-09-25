// routes/similar.js
import { Router } from "express";
import { groupSimilarEntries } from "../services/similarServices.js";
import { getConsentedEntries } from "../data/consentedEntries.js";

const router = Router();

// ---------- helpers ----------
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

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const arrify = (v) => (Array.isArray(v) ? v : v != null ? [v] : []);
const allEqual = (arr) => arr.length && arr.every((v) => v === arr[0]);

const fmtDate = (dStr) => dStr; // yyyy-mm-dd already
const fmtMoney = (n) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);

// Fuzzy getter: supports spaced/snake/camel variants, case-insensitive.
function getAny(r, keys) {
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  for (const k of keys) {
    if (own(r, k) && r[k] != null) return r[k];

    // try case-insensitive direct match
    const lowerK = k.toLowerCase();
    for (const kk of Object.keys(r)) {
      if (kk.toLowerCase() === lowerK && r[kk] != null) return r[kk];
    }

    // try "spaced" label variant
    if (!k.includes(" ")) {
      const spaced = k
        .replace(/([A-Z])/g, " $1")
        .replace(/_/g, " ")
        .toLowerCase();
      for (const kk of Object.keys(r)) {
        if (kk.toLowerCase() === spaced && r[kk] != null) return r[kk];
      }
    }
  }
  return null;
}

function normalizeLocation(r) {
  const s =
    r.location_display_name ||
    r.location_name ||
    r.location?.display_name ||
    r.location?.text ||
    r.location?.name ||
    r.location ||
    "";
  const trimmed = String(s).trim();
  return trimmed ? trimmed : null;
}

function normalizeDate(r) {
  const d = getAny(r, [
    "date",
    "date_event",
    "startDate",
    "start Date",
    "createdAt",
    "created",
  ]);
  if (!d) return null;
  const t = new Date(d);
  return isNaN(+t) ? null : t.toISOString().slice(0, 10); // yyyy-mm-dd (UTC)
}

function extractCounts(r) {
  const c = r.counts || r.people || {};
  const val = (x) => (typeof x === "string" ? Number(x) : x);

  const male =
    getAny(r, ["male", "maleCount", "male_Count", "male count"]) ??
    getAny(c, ["male", "males"]);
  const female =
    getAny(r, ["female", "femaleCount", "female_Count", "female count"]) ??
    getAny(c, ["female", "females"]);
  const kids =
    getAny(r, [
      "kids",
      "children",
      "childrenCount",
      "children_Count",
      "children count",
      "child",
    ]) ?? getAny(c, ["kids", "children", "child"]);

  let total =
    getAny(r, ["total", "totalCount", "total_Count", "total count"]) ??
    getAny(c, ["total"]);

  const m = num(val(male)) ?? 0;
  const f = num(val(female)) ?? 0;
  const k = num(val(kids)) ?? 0;

  if (total == null) {
    const sum = m + f + k;
    total = sum || null;
  } else {
    total = num(val(total));
  }

  return {
    male: num(val(male)),
    female: num(val(female)),
    kids: num(val(kids)),
    total,
  };
}

function extractRansom(r) {
  const raw = getAny(r, [
    "ransom",
    "monetaryAmount",
    "monetary_Amount",
    "monetary amount",
    "amount",
  ]);
  if (raw == null) return null;
  const cleaned =
    typeof raw === "string" ? Number(raw.replace(/[^\d.-]/g, "")) : raw;
  return num(cleaned);
}

function extractEventTypes(r) {
  const v = getAny(r, [
    "eventTypes",
    "event_type",
    "event Type",
    "type",
    "types",
  ]);
  const arr = arrify(v)
    .map((s) => String(s).trim())
    .filter(Boolean);
  return arr.length ? arr : [];
}

function extractTransport(r) {
  const raw = getAny(r, ["transport", "vehicle", "mode"]);
  const s = (raw ?? "").toString().trim();
  return s || null;
}

function extractConditions(r) {
  const v = getAny(r, [
    "conditions",
    "condition_list",
    "condition List",
    "needs",
    "healthCondition",
    "health Condition",
  ]);
  const arr = arrify(v)
    .map((s) => String(s).trim())
    .filter(Boolean);
  return arr.length ? arr : [];
}

// ---------- route ----------
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
  const minSize = req.query.minSize ? Number(req.query.minSize) : 2;

  // Source rows visible to the NGO
  const rows = await getConsentedEntries();

  // Grouping (uses all 7 aspects inside similarServices)
  const result = groupSimilarEntries(rows, { threshold, weights });

  // Build normalized entryById used by the UI
  const entryById = {};
  for (const r of rows) {
    const id = r.id || r.link || r.url;
    if (!id) continue;

    entryById[id] = {
      id,
      personId: r.personId || r.reporter_email || r.reporter_webId || id,
      date: normalizeDate(r),
      location: normalizeLocation(r),
      ransom: extractRansom(r),
      counts: extractCounts(r),
      eventTypes: extractEventTypes(r),
      transport: extractTransport(r),
      conditions: extractConditions(r),
      link: r.url || r.link || null,
    };
  }

  // Filter out tiny buckets (default: size >= 2)
  let buckets = (result.buckets || []).filter((b) => (b.size || 0) >= minSize);

  // Compute concise summary per bucket (with actual similar aspects)
  buckets = buckets.map((b) => {
    const entries = b.entryIds.map((id) => entryById[id]).filter(Boolean);

    // ----- Date (same or ±1 day => span ≤ 2 days) -----
    let dateRange = null;
    let dateAspect = null;
    if (entries.length && entries.every((e) => e.date)) {
      const times = entries.map((e) =>
        new Date(e.date + "T00:00:00Z").getTime(),
      );
      const min = Math.min(...times);
      const max = Math.max(...times);
      const spanDays = (max - min) / 86400000;
      if (spanDays === 0) {
        const d = new Date(min).toISOString().slice(0, 10);
        dateRange = { earliest: d, latest: d };
        dateAspect = {
          similar: true,
          display: fmtDate(d),
          details: { spanDays: 0 },
        };
      } else if (spanDays <= 2) {
        const earliest = new Date(min).toISOString().slice(0, 10);
        const latest = new Date(max).toISOString().slice(0, 10);
        dateRange = { earliest, latest };
        dateAspect = {
          similar: true,
          display: `${fmtDate(earliest)} – ${fmtDate(latest)}`,
          details: { spanDays },
        };
      }
    }

    // ----- Location (all identical) -----
    let commonLocation = null;
    let locAspect = null;
    if (
      entries.length &&
      entries.every((e) => e.location === entries[0].location) &&
      entries[0].location
    ) {
      commonLocation = entries[0].location;
      locAspect = { similar: true, display: commonLocation };
    }

    // ----- Counts (male/female/kids ±1, total ±3) -----
    const partLabels = ["male", "female", "kids"];
    const countsSimilar = {};
    let anyCountsShown = false;

    // per-part
    partLabels.forEach((label) => {
      const vals = entries
        .map((e) => e.counts?.[label])
        .filter((v) => v != null);
      if (vals.length === entries.length) {
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        if (max - min <= 1) {
          countsSimilar[label] = { min, max };
          anyCountsShown = true;
        }
      }
    });

    // total
    const totals = entries.map((e) => e.counts?.total).filter((v) => v != null);
    if (totals.length === entries.length) {
      const minT = Math.min(...totals);
      const maxT = Math.max(...totals);
      if (maxT - minT <= 3) {
        countsSimilar.total = { min: minT, max: maxT };
        anyCountsShown = true;
      }
    }

    let countsAspect = null;
    if (anyCountsShown) {
      const parts = [];
      for (const label of ["male", "female", "kids"]) {
        const r = countsSimilar[label];
        if (!r) continue;
        parts.push(
          r.min === r.max ? `${label} ${r.min}` : `${label} ${r.min}–${r.max}`,
        );
      }
      if (countsSimilar.total) {
        const r = countsSimilar.total;
        parts.push(
          r.min === r.max ? `total ${r.min}` : `total ${r.min}–${r.max}`,
        );
      }
      countsAspect = {
        similar: true,
        display: parts.join(", "),
        details: countsSimilar,
      };
    }

    // ----- Ransom (all values within ±10% of the MEAN) -----
    let ransomRange = null;
    let ransomAspect = null;
    const ransomVals = entries.map((e) => e.ransom).filter((v) => v != null);
    if (ransomVals.length === entries.length) {
      const mean = ransomVals.reduce((a, b) => a + b, 0) / ransomVals.length;
      const maxAbsPct = Math.max(
        ...ransomVals.map((v) => Math.abs(v - mean) / mean),
      );
      const minR = Math.min(...ransomVals);
      const maxR = Math.max(...ransomVals);
      if (maxAbsPct <= 0.1) {
        ransomRange = { min: minR, max: maxR };
        ransomAspect = {
          similar: true,
          display:
            minR === maxR
              ? fmtMoney(minR)
              : `${fmtMoney(minR)} – ${fmtMoney(maxR)} (±10%)`,
          details: { min: minR, max: maxR, mean },
        };
      }
    }

    // ----- Event Type (all same; case/order-insensitive) -----
    let eventType = null;
    let eventAspect = null;
    if (entries.length) {
      const norm = (v) =>
        Array.isArray(v)
          ? v
              .map((x) => String(x).trim().toLowerCase())
              .sort()
              .join("|")
          : String(v || "")
              .trim()
              .toLowerCase();
      const baseN = norm(entries[0].eventTypes);
      if (baseN && entries.every((e) => norm(e.eventTypes) === baseN)) {
        const pretty = Array.isArray(entries[0].eventTypes)
          ? entries[0].eventTypes.join(", ")
          : String(entries[0].eventTypes);
        eventType = pretty;
        eventAspect = { similar: true, display: pretty };
      }
    }

    // ----- Transport (all same; case-insensitive, trimmed) -----
    let transport = null;
    let transportAspect = null;
    if (entries.length) {
      const base = (entries[0].transport || "").toString().trim();
      if (
        base &&
        entries.every(
          (e) =>
            (e.transport || "").toString().trim().toLowerCase() ===
            base.toLowerCase(),
        )
      ) {
        transport = base;
        transportAspect = { similar: true, display: base };
      }
    }

    // ----- Conditions (all same set) -----
    let conditions = null;
    let conditionsAspect = null;
    if (
      entries.length &&
      entries.every(
        (e) =>
          JSON.stringify(
            (e.conditions || [])
              .map((x) => String(x).trim().toLowerCase())
              .sort(),
          ) ===
          JSON.stringify(
            (entries[0].conditions || [])
              .map((x) => String(x).trim().toLowerCase())
              .sort(),
          ),
      ) &&
      (entries[0].conditions?.length || 0) > 0
    ) {
      conditions = entries[0].conditions;
      conditionsAspect = {
        similar: true,
        display: conditions.join(", "),
        details: { values: conditions },
      };
    }

    // Build similarAspects (only include those that qualified)
    const similarAspects = {};
    if (locAspect) similarAspects.location = locAspect;
    if (dateAspect) similarAspects.date = dateAspect;
    if (countsAspect) similarAspects.headcount = countsAspect;
    if (ransomAspect) similarAspects.ransom = ransomAspect;
    if (eventAspect) similarAspects.eventType = eventAspect;
    if (transportAspect) similarAspects.transport = transportAspect;
    if (conditionsAspect) similarAspects.conditions = conditionsAspect;

    // Plain-text strings for UI
    const dateText = dateAspect?.display || null;
    const headcountText = countsAspect?.display || null;
    const ransomText = ransomAspect?.display || null;
    const eventTypeText = eventAspect?.display || null;
    const transportText = transportAspect?.display || null;
    const conditionsText = conditionsAspect?.display || null;

    return {
      ...b,
      summary: {
        // structured fields (kept)
        dateRange,
        counts: Object.keys(countsSimilar).length ? countsSimilar : null,
        ransom: ransomRange,
        // UI-friendly strings
        date: dateText,
        location: commonLocation,
        headcountText,
        ransomText,
        eventType: eventTypeText,
        transport: transportText,
        conditions: conditionsText,
        // rich detail
        similarAspects,
      },
    };
  });

  res.json({ buckets, entryById, pairwise: result.pairwise });
});

export default router;
