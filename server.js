// ✅ Final production-ready server.js with Redis session support, NGO alert system,
//    and Solid-Pod journal upload with optional NGO read-access per entry

import express from "express";
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
} from "@inrupt/solid-client";
import dotenv from "dotenv";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
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

app.use(authRoutes);
app.use(syncRoutes);
app.use(alertRoutes);

// ---------- Local storage dirs ----------
const uploadsDir = path.join(__dirname, "uploads");
const rawDir = path.join(uploadsDir, "raw");
[uploadsDir, rawDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// (Optional) NGO aggregation dirs
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Routes: file upload (existing) ----------
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

// Expanded /me to include webId if present
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

app.get("/view", async (req, res) => {
  const fileParam = req.query.file;
  const isFromGate = req.get("X-Trusted-Gate") === "true";
  if (!fileParam) return res.status(400).send("Missing file parameter");
  if (!isFromGate)
    return res.status(403).send("Access denied. Use secure view interface.");

  const encFilePath = path.join(rawDir, fileParam);
  try {
    const decryptedBuffer = await decryptFileToBuffer(encFilePath);
    const ext = path.extname(fileParam).replace(".enc", "") || ".jpg";
    const mimeType = ext === ".pdf" ? "application/pdf" : "image/jpeg";
    res.setHeader("Content-Type", mimeType);
    res.send(decryptedBuffer);
  } catch (err) {
    console.error("❌ Failed to decrypt:", err.message);
    res.status(500).send("Decryption failed or file not found.");
  }
});

app.delete("/file", async (req, res) => {
  const url = req.query.url;
  const user = req.session.user;
  if (!url || !user)
    return res.status(400).send("Missing URL or not logged in");

  try {
    const fileName = decodeURIComponent(url.split("/").pop());
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

    await deleteFromPod(url);
    await deleteFromPod(metaUrl);

    res.send("✅ File and metadata deleted from Solid Pod and local server.");
  } catch (err) {
    console.error("❌ Deletion error:", err);
    res.status(500).send("Failed to delete file or metadata.");
  }
});

// ===================================================================================
// NEW: Save journal entry to the refugee's Solid Pod (per-entry optional NGO read)
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

  // Multi-valued: eventType
  (eventTypes || []).forEach((v) => {
    ev = ev.addStringNoLocale(SCHEMA + "eventType", String(v));
  });

  // Multi-valued: healthCondition
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

/** NGO-only: list consented links (newest first) */
app.get("/ngo/consented-journals", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== "admin")
      return res.status(403).send("Forbidden");
    let rows = [];
    try {
      const txt = await fsp.readFile(NGO_CONSENTED_PATH, "utf8");
      rows = txt
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .reverse();
    } catch (_) {
      // none yet
    }
    res.json(rows);
  } catch (err) {
    console.error("GET /ngo/consented-journals failed:", err);
    res.status(500).send("Failed to load consented journals.");
  }
});

/**
 * POST /journal
 * Body: {
 *   date, location:{text,display_name,lat,lon,country_iso2,osm_type,osm_id},
 *   people:{males,females,kids,total}, ransom, eventTypes[], transport, conditions[],
 *   consent: boolean // if true, grant NGO WebID read on this resource
 * }
 */
app.post("/journal", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).send("Unauthorized. Please log in.");

    // Login to the user's Pod using their client credentials from the session
    const sessionNode = new Session();
    await sessionNode.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret, // ensure plaintext here
      oidcIssuer: user.oidcIssuer,
    });

    // Choose base by consent: public vs private
    const { privateBase, publicBase } = basesFromTargetPod(user.targetPod);
    const baseForThisEntry = req.body?.consent ? publicBase : privateBase;
    const containerUrl = new URL("journal/", baseForThisEntry).href;

    // Ensure container exists
    await ensureContainerAt(containerUrl, sessionNode);

    // Create resource IRI
    const id = `entry-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const entryIri = new URL(id, containerUrl).href;
    const placeIri = entryIri + "#place";

    // Build dataset
    const dataset = buildJournalDataset(entryIri, placeIri, req.body || {});

    // Save Turtle at entry.ttl
    const resourceUrl = `${entryIri}.ttl`;
    await saveSolidDatasetAt(resourceUrl, dataset, {
      fetch: sessionNode.fetch,
    });

    // Optional: if consent provided, grant NGO read on this resource AND record link
    if (req.body?.consent) {
      await grantNgoReadIfConsented(resourceUrl, true, sessionNode);
      if (req.body?.consent) {
        // record for NGO list
        await appendConsentedLink({
          url: resourceUrl,
          timestamp_iso: new Date().toISOString(),
          reporter_email: req.session.user?.email || null,
          reporter_webId: sessionNode.info?.webId || null,
          // a little useful context (optional):
          date_event: req.body?.date || null,
          location_display_name:
            req.body?.location?.display_name ||
            req.body?.location?.text ||
            null,
        });
      }
    }

    res.status(201).json({
      message: "✅ Journal entry saved to Solid Pod",
      url: resourceUrl, // the client UI can ignore showing it
    });
  } catch (err) {
    console.error("❌ Journal save error:", err);
    res.status(500).send("Failed to save journal entry to Solid Pod.");
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

    // Try a HEAD on the container
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

// ---------- Start server ----------
app.listen(3001, () => {
  console.log("🚀 Upload server listening at http://localhost:3001");
});
