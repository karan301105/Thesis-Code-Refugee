// ✅ Final production-ready server.js with Redis session support, NGO alert system,
//    Solid-Pod journal upload, Similarity Buckets UI/API, refugee list & delete

import express from "express";
import path from "path";
import fileUpload from "express-fileupload";
import session from "express-session";
import {
  overwriteFile,
  getSolidDataset,
  getThingAll,
  getStringNoLocale,
  // solid RDF + container + ACL helpers for journal save
  createSolidDataset,
  setThing,
  saveSolidDatasetAt,
  buildThing,
  createThing,
  createContainerAt,
  getSolidDatasetWithAcl,
  hasResourceAcl,
  hasAccessibleAcl,
  getResourceAcl,
  createAcl,
  setAgentResourceAccess,
  saveAclFor,
  getContainedResourceUrlAll, // ⬅️ added here (no later duplicate import)
} from "@inrupt/solid-client";
import dotenv from "dotenv";
import fs from "fs";
import { promises as fsp } from "fs";
import { fileURLToPath } from "url";
import { processAndBlur } from "./ocrProcess.js";
import { encryptFile, decryptFileToBuffer } from "./encryption.js";
import authRoutes from "./auth.js";
import syncRoutes from "./sync.js";
import alertRoutes from "./alerts.js";
import { Session } from "@inrupt/solid-client-authn-node";
import fetch from "node-fetch"; // (kept in case other routes need it)
import crypto from "crypto";
import { writeFileSync } from "fs";
import Redis from "ioredis";
import connectRedis from "connect-redis";

// 🔗 Similarity API route (JS build)
import similarRoutes from "./routes/similar.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(fileUpload());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---------- Redis session config ----------
const RedisStore = connectRedis(session);
const redisClient = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
});

app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // set true if behind HTTPS proxy
      httpOnly: true,
      maxAge: 1000 * 60 * 60, // 1 hour
    },
  }),
);

// Assign admin role based on email domain
app.use((req, res, next) => {
  if (req.session?.user?.email?.endsWith("@ngo.com")) {
    req.session.user.role = "admin";
  }
  next();
});

// Mount existing routes
app.use(authRoutes);
app.use(syncRoutes);
app.use(alertRoutes);

// 🔗 mount similarity API
app.use(similarRoutes);

// ---------- Local storage dirs ----------
const uploadsDir = path.join(__dirname, "uploads");
const rawDir = path.join(uploadsDir, "raw");
[uploadsDir, rawDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// NGO aggregation dir
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Routes: file upload ----------
app.post("/upload", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).send("Unauthorized. Please log in.");
  if (!req.files || !req.files.file)
    return res.status(400).send("No file uploaded.");

  try {
    const file = req.files.file;
    const ext = path.extname(file.name);
    const originalName = path.basename(file.name, ext);
    const uuid = crypto.randomUUID();
    const redactedName = `${originalName}_blurred${ext}`;
    const encryptedName = `${uuid}${ext}.enc`;
    const encryptedPath = path.join(rawDir, encryptedName);

    const redactedBuffer = await processAndBlur(file.data);
    await encryptFile(file.data, encryptedPath);

    const sessionNode = new Session();
    await sessionNode.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret, // Assuming you already decrypt this in auth flow
      oidcIssuer: user.oidcIssuer,
    });

    const podFolder = user.targetPod.endsWith("/")
      ? user.targetPod
      : user.targetPod + "/";
    const remoteUrl = new URL(redactedName, podFolder).href;
    await overwriteFile(remoteUrl, redactedBuffer, {
      contentType: file.mimetype || "application/octet-stream",
      fetch: sessionNode.fetch,
    });

    const metadata = `
@prefix dc: <http://purl.org/dc/elements/1.1/> .
@prefix schema: <http://schema.org/> .

<> a schema:MediaObject ;
   dc:title "${file.name}" ;
   schema:dateCreated "${new Date().toISOString()}" ;
   schema:contentUrl <${remoteUrl}> ;
   schema:encryptedCopy "${encryptedName}" .
`;

    const metaName = redactedName + ".ttl";
    const metaPath = path.join(rawDir, metaName);
    writeFileSync(metaPath, metadata);

    const remoteMetaUrl = new URL(metaName, podFolder).href;
    await overwriteFile(remoteMetaUrl, fs.readFileSync(metaPath), {
      contentType: "text/turtle",
      fetch: sessionNode.fetch,
    });

    fs.unlinkSync(metaPath);
    res.send({
      message: "✅ File uploaded",
      url: remoteUrl,
      encryptedLocalFile: encryptedName,
    });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).send("❌ Upload failed: " + err.message);
  }
});

// Expanded /me
app.get("/me", (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");
  const { email, webId } = req.session.user;
  res.json({ email, webId });
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).send("Logout failed.");
    res.clearCookie("connect.sid");
    res.send("✅ Logged out.");
  });
});

// Decrypt & view
app.get("/view", async (req, res) => {
  const fileParam = req.query.file;
  const isFromGate = req.get("X-Trusted-Gate") === "true";
  if (!fileParam) return res.status(400).send("Missing file parameter");
  if (!isFromGate)
    return res.status(403).send("Access denied. Use secure view interface.");

  const encFilePath = path.join(rawDir, String(fileParam));
  try {
    const decryptedBuffer = await decryptFileToBuffer(encFilePath);
    const ext = path.extname(String(fileParam)).replace(".enc", "") || ".jpg";
    const mimeType = ext === ".pdf" ? "application/pdf" : "image/jpeg";
    res.setHeader("Content-Type", mimeType);
    res.send(decryptedBuffer);
  } catch (err) {
    console.error("❌ Failed to decrypt:", err.message);
    res.status(500).send("Decryption failed or file not found.");
  }
});

// Delete encrypted local file (unchanged)
app.delete("/file", async (req, res) => {
  const url = req.query.url;
  const user = req.session.user;
  if (!url || !user)
    return res.status(400).send("Missing URL or not logged in");

  try {
    const fileName = decodeURIComponent(String(url).split("/").pop());
    const podFolder = user.targetPod.endsWith("/")
      ? user.targetPod
      : user.targetPod + "/";
    const metaUrl = new URL(fileName + ".ttl", podFolder).href;

    const sessionNode = new Session();
    await sessionNode.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    const ttlDataset = await getSolidDataset(metaUrl, {
      fetch: sessionNode.fetch,
    });
    const thing = getThingAll(ttlDataset)[0];
    const encryptedCopy = getStringNoLocale(
      thing,
      "http://schema.org/encryptedCopy",
    );
    if (encryptedCopy) {
      const encPath = path.join("uploads/raw", encryptedCopy);
      if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
    }

    const deleteFromPod = async (targetUrl) => {
      const response = await sessionNode.fetch(targetUrl, { method: "DELETE" });
      if (!response.ok) {
        console.error(
          `❌ Failed to delete ${targetUrl}:`,
          response.status,
          await response.text(),
        );
        throw new Error(`Failed to delete ${targetUrl}`);
      }
    };

    await deleteFromPod(String(url));
    await deleteFromPod(metaUrl);

    res.send("✅ File and metadata deleted from Solid Pod and local server.");
  } catch (err) {
    console.error("❌ Deletion error:", err);
    res.status(500).send("Failed to delete file or metadata.");
  }
});

// ===================================================================================
// Save journal entry to the refugee's Solid Pod (per-entry optional NGO read)
// ===================================================================================

const SCHEMA = "https://schema.org/";
const WGS84 = "http://www.w3.org/2003/01/geo/wgs84_pos#";
const DCT = "http://purl.org/dc/terms/";

// Set your NGO WebID here or via env
const NGO_WEBID =
  process.env.NGO_WEBID || "https://example-ngo.org/profile/card#me";

/** Ensure a Solid container exists (ignore error if it already exists). */
async function ensureContainerAt(url, sessionNode) {
  try {
    await createContainerAt(url.endsWith("/") ? url : url + "/", {
      fetch: sessionNode.fetch,
    });
  } catch (_) {
    /* likely 409: already exists */
  }
}

/** Build an RDF dataset for the journal entry (Event + linked Place). */
function buildJournalDataset(entryIri, placeIri, payload) {
  const {
    date,
    people = {},
    ransom,
    eventTypes = [],
    transport,
    conditions = [],
    location = {},
  } = payload;

  // ----- Event -----
  let ev = buildThing(createThing({ url: entryIri }))
    .addUrl("http://www.w3.org/1999/02/22-rdf-syntax-ns#type", SCHEMA + "Event")
    .addStringNoLocale(SCHEMA + "name", "Refugee Journal Entry")
    .addStringNoLocale(DCT + "created", new Date().toISOString())
    .addStringNoLocale(SCHEMA + "startDate", date || "")
    .addInteger(SCHEMA + "numberOfItems", people.total ?? 0)
    .addInteger(SCHEMA + "maleCount", people.males ?? 0)
    .addInteger(SCHEMA + "femaleCount", people.females ?? 0)
    .addInteger(SCHEMA + "childrenCount", people.kids ?? 0)
    .addStringNoLocale(SCHEMA + "monetaryAmount", String(ransom ?? ""))
    .addStringNoLocale(SCHEMA + "vehicle", transport || "")
    .addUrl(SCHEMA + "location", placeIri);

  (eventTypes || []).forEach((v) => {
    ev = ev.addStringNoLocale(SCHEMA + "eventType", String(v));
  });
  (conditions || []).forEach((v) => {
    ev = ev.addStringNoLocale(SCHEMA + "healthCondition", String(v));
  });

  const eventThing = ev.build();

  // ----- Place -----
  const placeThing = buildThing(createThing({ url: placeIri }))
    .addUrl("http://www.w3.org/1999/02/22-rdf-syntax-ns#type", SCHEMA + "Place")
    .addStringNoLocale(
      SCHEMA + "name",
      location.display_name || location.text || "",
    )
    .addStringNoLocale(
      "http://www.w3.org/2006/vcard/ns#country-name",
      location.country_iso2 || "",
    )
    .addDecimal(WGS84 + "lat", location.lat ? Number(location.lat) : 0)
    .addDecimal(WGS84 + "long", location.lon ? Number(location.lon) : 0)
    .addStringNoLocale(
      SCHEMA + "identifier",
      (location.osm_type ? `${location.osm_type}:` : "") +
        (location.osm_id || ""),
    )
    .build();

  let ds = createSolidDataset();
  ds = setThing(ds, eventThing);
  ds = setThing(ds, placeThing);
  return ds;
}

/** Optionally grant NGO read access on the resource via WAC ACL. */
async function grantNgoReadIfConsented(resourceUrl, consent, sessionNode) {
  if (!consent || !NGO_WEBID) return;
  try {
    const dsWithAcl = await getSolidDatasetWithAcl(resourceUrl, {
      fetch: sessionNode.fetch,
    });
    let resourceAcl = hasResourceAcl(dsWithAcl)
      ? getResourceAcl(dsWithAcl)
      : hasAccessibleAcl(dsWithAcl)
        ? createAcl(dsWithAcl)
        : null;

    if (resourceAcl) {
      resourceAcl = setAgentResourceAccess(resourceAcl, NGO_WEBID, {
        read: true,
        append: false,
        write: false,
        control: false,
      });
      await saveAclFor(dsWithAcl, resourceAcl);
    } else {
      console.warn("⚠️ Could not set ACL for resource (no accessible ACL).");
    }
  } catch (e) {
    console.warn("⚠️ Setting NGO read access failed:", e?.message || e);
  }
}

/** Decide public vs private bases from targetPod */
function basesFromTargetPod(targetPod) {
  const base = targetPod.endsWith("/") ? targetPod : targetPod + "/";
  const endsWithPublic = /\/public\/?$/i.test(base);
  if (endsWithPublic) {
    const privateBase = base.replace(/public\/?$/i, "");
    const publicBase = base;
    return { privateBase, publicBase };
  }
  const privateBase = base;
  const publicBase = new URL("public/", privateBase).href;
  return { privateBase, publicBase };
}

/** Append a consented link record for NGO list */
const NGO_CONSENTED_PATH = path.join(DATA_DIR, "consented-journals.jsonl");
async function appendConsentedLink(entry) {
  const line = JSON.stringify(entry) + "\n";
  await fsp.appendFile(NGO_CONSENTED_PATH, line, "utf8");
}

/** NGO-only: list consented links (newest first) with auto-prune of deleted URLs */
app.get("/ngo/consented-journals", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== "admin")
      return res.status(403).send("Forbidden");

    // prevent browser/proxy caching stale lists
    res.setHeader("Cache-Control", "no-store, max-age=0");

    let rows = [];
    try {
      const txt = await fsp.readFile(NGO_CONSENTED_PATH, "utf8");
      rows = txt
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // none yet
      return res.json([]);
    }

    // Probe which ones still exist (HEAD). We expect read access only to consented (public or ACL-granted) links.
    // Limit concurrency to avoid flooding (simple windowed loop).
    const concurrency = 6;
    const results = [];
    let i = 0;

    async function worker() {
      while (i < rows.length) {
        const idx = i++;
        const row = rows[idx];
        let alive = true;
        try {
          // Use node-fetch (from Session); unauth HEAD first, then fallback to GET if HEAD not allowed
          const sessionNode = new Session();
          // Optional: if you want to probe with a service account, login here; otherwise do plain fetch
          const probe = await fetch(row.url, { method: "HEAD" });
          if (!probe.ok) {
            // Some Solid servers may not allow HEAD; try GET to test existence without reading body
            const probe2 = await fetch(row.url, { method: "GET" });
            alive = probe2.ok;
          }
        } catch {
          alive = false;
        }
        results[idx] = { row, alive };
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, rows.length) },
      () => worker(),
    );
    await Promise.all(workers);

    // Keep only alive; if any were pruned, rewrite the JSONL file
    const aliveRows = results.filter((r) => r && r.alive).map((r) => r.row);
    if (aliveRows.length !== rows.length) {
      const newText =
        aliveRows.map((r) => JSON.stringify(r)).join("\n") +
        (aliveRows.length ? "\n" : "");
      try {
        await fsp.writeFile(NGO_CONSENTED_PATH, newText, "utf8");
      } catch {}
    }

    // newest first
    aliveRows.reverse();
    res.json(aliveRows);
  } catch (err) {
    console.error("GET /ngo/consented-journals failed:", err);
    res.status(500).send("Failed to load consented journals.");
  }
});
// --- helpers for consented-journals cleanup ---
function normalizeUrl(u) {
  if (!u) return "";
  try {
    // decode, trim trailing slashes, lowercase scheme/host
    const dec = decodeURIComponent(String(u).trim());
    const url = new URL(dec);
    url.hash = "";
    // normalize host & protocol to lowercase; keep path/query as-is
    const norm = `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    return norm;
  } catch {
    // not a valid URL; best-effort normalization
    return String(u).trim().replace(/\/+$/, "");
  }
}

function removeFromConsentIndexByUrlSync(jsonlText, targetUrl) {
  const target = normalizeUrl(targetUrl);
  const out = [];
  const lines = jsonlText.split("\n");
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const obj = JSON.parse(l);
      const cur = normalizeUrl(obj.url);
      if (cur === target) continue; // drop
      // also drop if decoded matches encoded (defensive)
      if (normalizeUrl(decodeURIComponent(obj.url || "")) === target) continue;
      out.push(JSON.stringify(obj));
    } catch {
      // malformed line → keep it (or drop; choose keep to avoid data loss)
      out.push(l);
    }
  }
  return out.join("\n") + (out.length ? "\n" : "");
}
/**
 * POST /journal
 * Body: { date, location:{...}, people:{...}, ransom, eventTypes[], transport, conditions[], consent }
 */
app.post("/journal", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).send("Unauthorized. Please log in.");

    const sessionNode = new Session();
    await sessionNode.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    // Choose base by consent: public vs private
    const { privateBase, publicBase } = basesFromTargetPod(user.targetPod);
    const baseForThisEntry = req.body?.consent ? publicBase : privateBase;
    const containerUrl = new URL("journal/", baseForThisEntry).href;

    await ensureContainerAt(containerUrl, sessionNode);

    const id = `entry-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const entryIri = new URL(id, containerUrl).href;
    const placeIri = entryIri + "#place";

    const dataset = buildJournalDataset(entryIri, placeIri, req.body || {});
    const resourceUrl = `${entryIri}.ttl`;
    await saveSolidDatasetAt(resourceUrl, dataset, {
      fetch: sessionNode.fetch,
    });

    if (req.body?.consent) {
      await grantNgoReadIfConsented(resourceUrl, true, sessionNode);
      await appendConsentedLink({
        url: resourceUrl,
        timestamp_iso: new Date().toISOString(),
        reporter_email: req.session.user?.email || null,
        reporter_webId: sessionNode.info?.webId || null,
        date_event: req.body?.date || null,
        location_display_name:
          req.body?.location?.display_name || req.body?.location?.text || null,
      });
    }

    res.status(201).json({
      message: "✅ Journal entry saved to Solid Pod",
      url: resourceUrl,
    });
  } catch (err) {
    console.error("❌ Journal save error:", err);
    res.status(500).send("Failed to save journal entry to Solid Pod.");
  }
});

// ---------------- Refugee: list my journal entries (private + public) ----------------
app.get("/journal/mine", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).send("Unauthorized");

    const sessionNode = new Session();
    await sessionNode.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    const { privateBase, publicBase } = basesFromTargetPod(user.targetPod);
    const privContainer = new URL("journal/", privateBase).href;
    const pubContainer = new URL("journal/", publicBase).href;

    async function listEntries(containerUrl) {
      try {
        const ds = await getSolidDataset(containerUrl, {
          fetch: sessionNode.fetch,
        });
        const urls = getContainedResourceUrlAll(ds) || [];
        return urls
          .filter((u) => /\.ttl$/i.test(u) && /\/entry-/.test(u))
          .sort()
          .reverse()
          .map((url) => ({
            url,
            id: url.split("/").pop(),
            date_hint:
              (url.match(/entry-(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
          }));
      } catch {
        return [];
      }
    }

    const [privateEntries, publicEntries] = await Promise.all([
      listEntries(privContainer),
      listEntries(pubContainer),
    ]);

    res.json({
      private: { containerUrl: privContainer, entries: privateEntries },
      public: { containerUrl: pubContainer, entries: publicEntries },
    });
  } catch (err) {
    console.error("GET /journal/mine error:", err);
    res.status(500).send("Could not list your journal entries.");
  }
});

// ---------------- Refugee: delete one journal entry (private or public) -------------
app.post("/journal/delete", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).send("Unauthorized");

    const { url } = req.body || {};
    const resourceUrl = typeof url === "string" ? url.trim() : "";
    if (!resourceUrl) return res.status(400).send("Missing 'url' in body");

    const sessionNode = new Session();
    await sessionNode.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    const r = await sessionNode.fetch(resourceUrl, { method: "DELETE" });
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      console.error("Solid DELETE failed:", r.status, msg);
      return res.status(502).send("Failed to delete from Solid Pod.");
    }

    // Best-effort: remove from NGO consent index if present (robust URL match)
    try {
      const txt = await fsp.readFile(NGO_CONSENTED_PATH, "utf8");
      const cleaned = removeFromConsentIndexByUrlSync(txt, resourceUrl);
      if (cleaned !== txt) {
        await fsp.writeFile(NGO_CONSENTED_PATH, cleaned, "utf8");
      }
    } catch {
      /* index may not exist yet; ignore */
    }

    res.send("✅ Entry deleted.");
  } catch (err) {
    console.error("POST /journal/delete error:", err);
    res.status(500).send("Could not delete entry.");
  }
});

// --- DEBUG: probe Solid login + container creation (remove in prod) ---
app.get("/journal/_debug", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user)
      return res
        .status(401)
        .json({ ok: false, where: "session", msg: "Not logged in to app" });
    if (
      !user.clientId ||
      !user.clientSecret ||
      !user.oidcIssuer ||
      !user.targetPod
    ) {
      return res.status(400).json({
        ok: false,
        where: "session",
        msg: "Missing Solid creds in session",
      });
    }

    const { privateBase, publicBase } = basesFromTargetPod(user.targetPod);
    const containerUrl = new URL("journal/", publicBase).href;

    const s = new Session();
    await s.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    let ensure = "skipped";
    try {
      await ensureContainerAt(containerUrl, s);
      ensure = "ok";
    } catch (e) {
      ensure = "error: " + (e?.message || e);
    }

    let headStatus = null;
    try {
      const r = await s.fetch(containerUrl, { method: "HEAD" });
      headStatus = r.status;
    } catch (e) {
      headStatus = "fetch error: " + (e?.message || e);
    }

    res.json({
      ok: true,
      webId: s.info.webId || null,
      containerUrl,
      ensureContainer: ensure,
      headStatus,
      privateBase,
      publicBase,
    });
  } catch (err) {
    console.error("DEBUG /journal/_debug:", err);
    res
      .status(500)
      .json({ ok: false, where: "debug", msg: err?.message || String(err) });
  }
});

// Serve the Similarity UI page
app.get("/similarity", (req, res) => {
  res.sendFile(path.resolve(path.join(__dirname, "public", "similarity.html")));
});

// ---------- Start server ----------
app.listen(3001, () => {
  console.log("🚀 Upload server listening at http://localhost:3001");
});
