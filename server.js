// ✅ Final production-ready server.js with Redis session support and NGO alert system

import express from "express";
import fileUpload from "express-fileupload";
import session from "express-session";
import {
  overwriteFile,
  getSolidDataset,
  getThingAll,
  getStringNoLocale,
} from "@inrupt/solid-client";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { processAndBlur } from "./ocrProcess.js";
import { encryptFile, decryptFileToBuffer } from "./encryption.js";
import authRoutes from "./auth.js";
import syncRoutes from "./sync.js";
import alertRoutes from "./alerts.js";
import { Session } from "@inrupt/solid-client-authn-node";
import fetch from "node-fetch";
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

// Redis session config
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
      secure: false,
      httpOnly: true,
      maxAge: 1000 * 60 * 60,
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

const uploadsDir = path.join(__dirname, "uploads");
const rawDir = path.join(uploadsDir, "raw");
[uploadsDir, rawDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

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

    const session = new Session();
    await session.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    const podFolder = user.targetPod.endsWith("/")
      ? user.targetPod
      : user.targetPod + "/";
    const remoteUrl = new URL(redactedName, podFolder).href;
    await overwriteFile(remoteUrl, redactedBuffer, {
      contentType: file.mimetype || "application/octet-stream",
      fetch: session.fetch,
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
      fetch: session.fetch,
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

app.get("/me", (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");
  res.json({ email: req.session.user.email });
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

    const session = new Session();
    await session.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    const ttlDataset = await getSolidDataset(metaUrl, { fetch: session.fetch });
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
      const response = await session.fetch(targetUrl, { method: "DELETE" });
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

app.listen(3001, () => {
  console.log("🚀 Upload server listening at http://localhost:3001");
});
