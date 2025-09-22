(async function () {
  const $ = (id) => document.getElementById(id);
  const resultsEl = $("results");
  const runBtn = $("runBtn");

  // ---- similarity display thresholds (tweak if you like) ----
  const DATE_RANGE_DAYS = 7;
  const LOCATION_MAJORITY = 0.5; // <= changed from 0.6
  const TOKEN_MAJORITY = 0.5; // new: token-level majority
  const MIN_SUPPORT = 3; // new: show if at least 3 entries share it
  const RANSOM_REL_RANGE = 0.25;
  const COUNT_CV_MAX = 0.25;

  async function fetchBuckets() {
    runBtn.disabled = true;
    resultsEl.innerHTML = `<div class="card">Running similarity…</div>`;

    const threshold = Number($("threshold").value || 0.7);
    const weights = {
      date: Number($("wDate").value),
      location: Number($("wLocation").value),
      counts: Number($("wCounts").value),
      ransom: Number($("wRansom").value),
    };
    const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    for (const k in weights) weights[k] = +(weights[k] / sum).toFixed(3);

    const qs = new URLSearchParams({
      threshold: String(threshold),
      weights: JSON.stringify(weights),
    });
    const res = await fetch(`/api/entries/similar?${qs.toString()}`);
    if (!res.ok) {
      resultsEl.innerHTML = `<div class="card">Error: ${res.status} ${res.statusText}</div>`;
      runBtn.disabled = false;
      return;
    }
    const data = await res.json();
    renderBuckets(data);
    runBtn.disabled = false;
  }

  // ---------- helpers ----------
  function daysBetween(a, b) {
    return Math.abs(+a - +b) / (1000 * 60 * 60 * 24);
  }
  function prettyLoc(s) {
    if (!s) return "";
    return s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
      .join(", ");
  }
  const STOP = new Set([
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
  function tokenizeLocation(s) {
    if (!s) return [];
    return s
      .toLowerCase()
      .replace(/[^a-z0-9, ]+/g, " ")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t && !STOP.has(t));
  }
  function mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  function std(arr, m) {
    const mm = m ?? mean(arr);
    return Math.sqrt(
      arr.reduce((a, x) => a + (x - mm) * (x - mm), 0) / arr.length,
    );
  }

  function computeSimilarSignals(bucket, entryById) {
    const n = bucket.entryIds.length;
    const entries = bucket.entryIds.map((id) => entryById[id]).filter(Boolean);

    const signals = [];

    // ----- DATE (range within DATE_RANGE_DAYS) -----
    const dateObjs = entries
      .map((e) => (e.date ? new Date(e.date) : null))
      .filter((d) => d && !isNaN(+d));
    if (dateObjs.length) {
      const earliest = new Date(Math.min(...dateObjs.map((d) => +d)));
      const latest = new Date(Math.max(...dateObjs.map((d) => +d)));
      if (daysBetween(earliest, latest) <= DATE_RANGE_DAYS) {
        signals.push({
          label: "date",
          value: `${earliest.toISOString().slice(0, 10)} → ${latest.toISOString().slice(0, 10)}`,
        });
      }
    }

    // ----- LOCATION (full string majority OR common tokens) -----
    const locs = entries
      .map((e) => (e.location || "").trim().toLowerCase())
      .filter(Boolean);
    if (locs.length) {
      const counts = new Map();
      for (const L of locs) counts.set(L, (counts.get(L) || 0) + 1);
      const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];

      if (top) {
        const topShare = top[1] / n;
        if (topShare >= LOCATION_MAJORITY || top[1] >= MIN_SUPPORT) {
          signals.push({ label: "location", value: prettyLoc(top[0]) });
        } else {
          // fall back to tokens majority / support
          const tokenCounts = new Map();
          for (const L of locs) {
            for (const t of tokenizeLocation(L)) {
              tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
            }
          }
          const commonTokens = Array.from(tokenCounts.entries())
            .filter(([_, c]) => c / n >= TOKEN_MAJORITY || c >= MIN_SUPPORT)
            .sort((a, b) => b[1] - a[1])
            .map(([t]) => t);

          if (commonTokens.length) {
            signals.push({
              label: "location tokens",
              value: commonTokens.join(", "),
            });
          }
        }
      }
    }

    // ----- RANSOM (small relative range) -----
    const ransoms = entries
      .map((e) =>
        typeof e.ransom === "number" && isFinite(e.ransom) ? e.ransom : null,
      )
      .filter((x) => x !== null);
    if (ransoms.length >= 2) {
      const rMin = Math.min(...ransoms);
      const rMax = Math.max(...ransoms);
      const relRange = (rMax - rMin) / Math.max(rMax, 1);
      if (relRange <= RANSOM_REL_RANGE) {
        const rMean = mean(ransoms);
        signals.push({
          label: "ransom",
          value: `≈ ${rMean.toFixed(2)} (range ${rMin}–${rMax})`,
        });
      }
    } else if (ransoms.length === 1) {
      signals.push({ label: "ransom", value: String(ransoms[0]) });
    }

    // ----- HEADCOUNT (total, low variability) -----
    const totals = entries
      .map((e) => {
        const c = e.counts || {};
        const m = Number(c.male || 0),
          f = Number(c.female || 0),
          k = Number(c.kids || 0);
        const t = c.total != null ? Number(c.total) : m + f + k;
        return isFinite(t) ? t : null;
      })
      .filter((x) => x !== null);
    if (totals.length >= 2) {
      const m = mean(totals);
      if (m > 0) {
        const s = std(totals, m);
        const cv = s / m;
        if (cv <= COUNT_CV_MAX) {
          // also show rough avg composition if available
          let male = 0,
            female = 0,
            kids = 0,
            count = 0;
          for (const e of entries) {
            const c = e.counts || {};
            male += Number(c.male || 0);
            female += Number(c.female || 0);
            kids += Number(c.kids || 0);
            count++;
          }
          const avg = count
            ? {
                male: (male / count).toFixed(1),
                female: (female / count).toFixed(1),
                kids: (kids / count).toFixed(1),
                total: m.toFixed(1),
              }
            : { total: m.toFixed(1) };
          signals.push({
            label: "headcount",
            value:
              `total ≈ ${avg.total}` +
              (avg.male
                ? ` (m ${avg.male}, f ${avg.female}, k ${avg.kids})`
                : ""),
          });
        }
      }
    } else if (totals.length === 1) {
      signals.push({ label: "headcount", value: `total ${totals[0]}` });
    }

    return signals;
  }

  function renderBuckets(data) {
    const { buckets = [], entryById = {} } = data;
    if (!buckets.length) {
      resultsEl.innerHTML = `<div class="card">No groups found with the current threshold.</div>`;
      return;
    }

    const container = document.createElement("div");

    buckets.forEach((b, idx) => {
      const card = document.createElement("div");
      card.className = "card bucket";

      const header = document.createElement("div");
      header.className = "bucket-header";
      header.innerHTML = `
        <div>
          <strong>Bucket ${idx + 1}</strong>
          <span class="tag">size: ${b.size}</span>
        </div>
        <div class="muted small">click to expand</div>
      `;

      const body = document.createElement("div");
      body.style.display = "none";

      const signals = computeSimilarSignals(b, entryById);

      const signalsHTML = signals.length
        ? signals
            .map(
              (s) => `
            <div class="row" style="margin-bottom:6px">
              <span class="muted small" style="min-width:120px">${s.label}</span>
              <span class="tag">${s.value}</span>
            </div>
          `,
            )
            .join("")
        : `<div class="muted small">No strong common signals detected for this bucket. Try adjusting weights or threshold.</div>`;

      body.innerHTML = `
        <div class="muted small" style="margin:4px 0 8px">Similar signals in this bucket</div>
        ${signalsHTML}
      `;

      header.addEventListener("click", () => {
        body.style.display = body.style.display === "none" ? "block" : "none";
      });

      card.appendChild(header);
      card.appendChild(body);
      container.appendChild(card);
    });

    resultsEl.innerHTML = "";
    resultsEl.appendChild(container);
  }

  runBtn.addEventListener("click", fetchBuckets);
  fetchBuckets();
})();
