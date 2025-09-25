(async function () {
  const $ = (id) => document.getElementById(id);
  const resultsEl = $("results");
  const runBtn = $("runBtn");

  async function fetchBuckets() {
    runBtn.disabled = true;
    resultsEl.innerHTML = `<div class="card">Running similarity…</div>`;

    const threshold = Number($("threshold").value || 0.7);
    const weights = {
      date: Number($("wDate").value),
      location: Number($("wLocation").value),
      counts: Number($("wCounts").value),
      ransom: Number($("wRansom").value),
      eventTypes: Number($("wEvent").value),
      transport: Number($("wTransport").value),
      conditions: Number($("wConditions").value),
    };

    // normalize weights to sum to 1 (keeps UI intuitive)
    const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    for (const k in weights) weights[k] = +(weights[k] / sum).toFixed(3);

    // call API with all 7 weights
    const qs = new URLSearchParams({
      threshold: String(threshold),
      weights: JSON.stringify(weights),
      minsize: "2",
    });
    const res = await fetch(`/api/entries/similar?${qs.toString()}`);
    if (!res.ok) {
      resultsEl.innerHTML = `<div class="card">Error: ${res.status} ${res.statusText}</div>`;
      runBtn.disabled = false;
      return;
    }
    const data = await res.json();
    data.buckets = (data.buckets || []).filter((b) => (b.size || 0) >= 2);
    renderBuckets(data);
    runBtn.disabled = false;
  }

  // ---- helper funcs matching backend rules ----
  function daysBetween(a, b) {
    return Math.abs(+a - +b) / (1000 * 60 * 60 * 24);
  }
  function iso(d) {
    const t = d ? new Date(d) : null;
    return t && !isNaN(+t) ? t : null;
  }
  function allSame(arr) {
    return arr.every((v) => String(v) === String(arr[0]));
  }
  function arrEq(a, b) {
    const A = Array.isArray(a) ? a.slice().sort() : [];
    const B = Array.isArray(b) ? b.slice().sort() : [];
    if (A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++)
      if (String(A[i]) !== String(B[i])) return false;
    return true;
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

  function computeCommonAspects(bucket, entryById) {
    const entries = bucket.entryIds.map((id) => entryById[id]).filter(Boolean);
    const n = entries.length;
    const out = [];

    const daysBetween = (a, b) => Math.abs(+a - +b) / (1000 * 60 * 60 * 24);
    const iso = (d) => {
      const t = d ? new Date(d) : null;
      return t && !isNaN(+t) ? t : null;
    };
    const prettyLoc = (s) =>
      (s || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
        .join(", ");
    const getNum = (x) => (typeof x === "number" && isFinite(x) ? x : null);

    // DATE: all within ±1 day
    const dateObjs = entries.map((e) => iso(e.date)).filter(Boolean);
    if (dateObjs.length === n) {
      const minD = new Date(Math.min(...dateObjs.map((d) => +d)));
      const maxD = new Date(Math.max(...dateObjs.map((d) => +d)));
      if (daysBetween(minD, maxD) <= 1) {
        out.push({
          label: "date",
          value: `${minD.toISOString().slice(0, 10)} → ${maxD.toISOString().slice(0, 10)}`,
        });
      }
    }

    // LOCATION: exact
    const locs = entries.map((e) => (e.location || "").trim().toLowerCase());
    if (locs.every((l) => l) && locs.every((l) => l === locs[0])) {
      out.push({ label: "location", value: prettyLoc(locs[0]) });
    }

    // HEADCOUNT: show the subfields that meet tolerance across all entries
    const males = entries
      .map((e) => getNum(e.counts?.male))
      .filter((v) => v != null);
    const females = entries
      .map((e) => getNum(e.counts?.female))
      .filter((v) => v != null);
    const kids = entries
      .map((e) => getNum(e.counts?.kids))
      .filter((v) => v != null);
    const totals = entries
      .map((e) => {
        const c = e.counts || {};
        const t = getNum(c.total);
        if (t != null) return t;
        const m = getNum(c.male) || 0,
          f = getNum(c.female) || 0,
          k = getNum(c.kids) || 0;
        return m + f + k;
      })
      .filter((v) => v != null);

    const hs = [];
    if (males.length === n) {
      const min = Math.min(...males),
        max = Math.max(...males);
      if (max - min <= 1)
        hs.push(`male ${min === max ? min : `${min}–${max}`}`);
    }
    if (females.length === n) {
      const min = Math.min(...females),
        max = Math.max(...females);
      if (max - min <= 1)
        hs.push(`female ${min === max ? min : `${min}–${max}`}`);
    }
    if (kids.length === n) {
      const min = Math.min(...kids),
        max = Math.max(...kids);
      if (max - min <= 1)
        hs.push(`kids ${min === max ? min : `${min}–${max}`}`);
    }
    if (totals.length === n) {
      const min = Math.min(...totals),
        max = Math.max(...totals);
      if (max - min <= 3)
        hs.push(`total ${min === max ? min : `${min}–${max}`}`);
    }
    if (hs.length) out.push({ label: "headcount", value: hs.join(", ") });

    // RANSOM: ±10%
    const ransoms = entries
      .map((e) => getNum(e.ransom))
      .filter((v) => v != null);
    if (ransoms.length === n) {
      const min = Math.min(...ransoms),
        max = Math.max(...ransoms);
      if ((max - min) / Math.max(max, 1) <= 0.1) {
        const mean = (ransoms.reduce((a, b) => a + b, 0) / n).toFixed(2);
        out.push({ label: "ransom", value: `≈ ${mean} (range ${min}–${max})` });
      }
    }

    // EVENT TYPE: show the INTERSECTION across all entries
    const evs = entries.map((e) =>
      Array.isArray(e.eventTypes) ? e.eventTypes.map(String) : [],
    );
    if (evs.every((arr) => Array.isArray(arr))) {
      let common = evs[0] ? [...new Set(evs[0])] : [];
      for (let i = 1; i < evs.length; i++) {
        const set = new Set(evs[i].map(String));
        common = common.filter((x) => set.has(String(x)));
        if (!common.length) break;
      }
      if (common.length)
        out.push({ label: "event type", value: common.join(", ") });
      else out.push({ label: "event type", value: "—" });
    }

    // TRANSPORT: exact
    const trs = entries.map((e) => (e.transport || "").trim().toLowerCase());
    if (trs.every((t) => t) && trs.every((t) => t === trs[0])) {
      out.push({ label: "transport", value: trs[0] });
    }

    // CONDITIONS: show the INTERSECTION across all entries
    const cons = entries.map((e) =>
      Array.isArray(e.conditions) ? e.conditions.map(String) : [],
    );
    if (cons.every((arr) => Array.isArray(arr))) {
      let common = cons[0] ? [...new Set(cons[0])] : [];
      for (let i = 1; i < cons.length; i++) {
        const set = new Set(cons[i].map(String));
        common = common.filter((x) => set.has(String(x)));
        if (!common.length) break;
      }
      if (common.length)
        out.push({ label: "conditions", value: common.join(", ") });
      else out.push({ label: "conditions", value: "—" });
    }

    return out;
  }

  function renderBuckets(data) {
    const { buckets = [], entryById = {} } = data;
    const resultsEl = document.getElementById("results");

    if (!buckets.length) {
      resultsEl.innerHTML = `<div class="card">No groups found with the current threshold.</div>`;
      return;
    }

    const prettyLoc = (s) =>
      (s || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
        .join(", ");

    const tag = (t) => `<span class="tag">${t}</span>`;
    const dash = `<span class="muted small">—</span>`;

    const container = document.createElement("div");

    buckets.forEach((b, idx) => {
      const s = b.summary || {};
      const card = document.createElement("div");
      card.className = "card bucket";

      // HEADER
      const header = document.createElement("div");
      header.className = "bucket-header";
      header.innerHTML = `
        <div>
          <strong>Bucket ${idx + 1}</strong>
          <span class="tag">size: ${b.size}</span>
        </div>
        <div class="muted small">click to expand</div>
      `;

      // BODY
      const body = document.createElement("div");
      body.style.display = "none";

      // Similar aspects block
      const rows = [];

      // date
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">date</div>
          <div>${s.dateRange ? tag(`${s.dateRange.earliest} → ${s.dateRange.latest}`) : dash}</div>
        </div>`);

      // location
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">location</div>
          <div>${s.location ? tag(prettyLoc(s.location)) : dash}</div>
        </div>`);

      // headcount (ranges)
      let headTags = [];
      if (s.counts) {
        const keys = ["male", "female", "kids", "total"];
        keys.forEach((k) => {
          if (s.counts[k]) {
            const { min, max } = s.counts[k];
            headTags.push(tag(`${k} ${min === max ? min : `${min}–${max}`}`));
          }
        });
      }
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">headcount</div>
          <div>${headTags.length ? headTags.join(" ") : dash}</div>
        </div>`);

      // ransom
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">ransom</div>
          <div>${
            s.ransom
              ? tag(
                  `≈ ${((s.ransom.min + s.ransom.max) / 2).toFixed(0)} (range ${s.ransom.min}–${s.ransom.max})`,
                )
              : dash
          }</div>
        </div>`);

      // event type (array)
      const evTags =
        Array.isArray(s.eventType) && s.eventType.length
          ? s.eventType.map((x) => tag(String(x))).join(" ")
          : "";
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">event type</div>
          <div>${evTags || dash}</div>
        </div>`);

      // transport
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">transport</div>
          <div>${s.transport ? tag(String(s.transport)) : dash}</div>
        </div>`);

      // conditions (array)
      const condTags =
        Array.isArray(s.conditions) && s.conditions.length
          ? s.conditions.map((x) => tag(String(x))).join(" ")
          : "";
      rows.push(`
        <div class="row"><div class="muted small" style="width:120px">conditions</div>
          <div>${condTags || dash}</div>
        </div>`);

      const similarBlock = `
        <div class="muted small" style="margin-bottom:6px">Similar aspects in this bucket</div>
        ${rows.join("")}
      `;

      // Entries list (collapsed details)
      const entriesWrap = document.createElement("div");
      entriesWrap.className = "grid";
      b.entryIds.forEach((id) => {
        const e = entryById[id] || { id };
        const loc = e.location ? prettyLoc(e.location) : "";
        const counts = e.counts || {};
        const cstr = [
          counts.male != null ? `m ${counts.male}` : null,
          counts.female != null ? `f ${counts.female}` : null,
          counts.kids != null ? `k ${counts.kids}` : null,
          counts.total != null ? `t ${counts.total}` : null,
        ]
          .filter(Boolean)
          .join(", ");

        const div = document.createElement("div");
        div.className = "entry";
        div.innerHTML = `
          <div>
            <div><strong>${e.date || "—"}</strong></div>
            <div class="muted small">${loc}</div>
            <div class="muted small">${cstr}</div>
          </div>
        `;
        entriesWrap.appendChild(div);
      });

      body.innerHTML = `
        ${similarBlock}
        <div class="muted small" style="margin:10px 0 6px">Entries in this bucket</div>
      `;
      body.appendChild(entriesWrap);

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
