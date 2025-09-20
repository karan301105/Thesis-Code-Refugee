import express from "express";
import fs from "fs/promises";
import crypto from "crypto";
import bcrypt from "bcrypt";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();
const USERS_FILE = path.join("users.json");

const ENC_ALGO = "aes-256-gcm";
const ENC_KEY = crypto
  .createHash("sha256")
  .update(process.env.ENCRYPTION_SECRET)
  .digest();

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, ENC_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decryptSecret({ iv, tag, data }) {
  const decipher = crypto.createDecipheriv(
    ENC_ALGO,
    ENC_KEY,
    Buffer.from(iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ✅ POST /signup
router.post("/signup", async (req, res) => {
  const {
    email,
    password,
    clientId,
    clientSecret,
    oidcIssuer,
    targetPod,
    firstName,
    lastName,
  } = req.body;

  try {
    const users = JSON.parse(
      await fs.readFile(USERS_FILE, "utf8").catch(() => "[]"),
    );
    if (users.find((u) => u.email === email)) {
      return res.status(400).send("User already exists.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const encryptedSecret = encryptSecret(clientSecret);

    users.push({
      email,
      password: hashedPassword,
      clientId,
      clientSecret: encryptedSecret,
      oidcIssuer,
      targetPod,
      firstName: firstName || "",
      lastName: lastName || "",
    });

    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
    res.send("✅ Signup successful.");
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).send("Signup failed.");
  }
});

// ✅ POST /login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
    const user = users.find((u) => u.email === email);

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).send("Invalid credentials.");
    }

    req.session.user = {
      email,
      clientId: user.clientId,
      clientSecret: decryptSecret(user.clientSecret),
      oidcIssuer: user.oidcIssuer,
      targetPod: user.targetPod,
      firstName: user.firstName || "",
      lastName: user.lastName || "",
    };

    res.send("✅ Login successful.");
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed.");
  }
});

// ✅ GET /logout
router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Logout failed.");
    }
    res.clearCookie("connect.sid");
    res.send("✅ Logged out.");
  });
});

// ✅ GET /settings
router.get("/settings", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");

  const users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
  const current = users.find((u) => u.email === req.session.user.email);

  if (!current) return res.status(404).send("User not found");

  res.json({
    clientId: current.clientId,
    clientSecret: decryptSecret(current.clientSecret),
    oidcIssuer: current.oidcIssuer,
    targetPod: current.targetPod,
    firstName: current.firstName || "",
    lastName: current.lastName || "",
  });
});

// ✅ POST /settings
router.post("/settings", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");

  const { clientId, clientSecret, oidcIssuer, targetPod, firstName, lastName } =
    req.body;
  const users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
  const user = users.find((u) => u.email === req.session.user.email);

  if (!user) return res.status(404).send("User not found");

  user.clientId = clientId;
  user.clientSecret = encryptSecret(clientSecret);
  user.oidcIssuer = oidcIssuer;
  user.targetPod = targetPod;
  user.firstName = firstName || "";
  user.lastName = lastName || "";

  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
  req.session.user = {
    email: user.email,
    clientId,
    clientSecret,
    oidcIssuer,
    targetPod,
    firstName: user.firstName,
    lastName: user.lastName,
  };

  res.send("✅ Settings updated.");
});

export default router;
