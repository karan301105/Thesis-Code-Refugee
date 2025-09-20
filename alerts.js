// alerts.js
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const router = express.Router();
const alertsFile = path.join("uploads", "alerts.json");
const binFile = path.join("uploads", "bin.json");

function loadAlerts(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`❌ Failed to load ${filePath}:`, err);
  }
  return [];
}

function saveAlerts(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// POST /alert - refugee sends alert
router.post("/alert", (req, res) => {
  if (!req.session || !req.session.user)
    return res.status(401).send("Unauthorized");

  const { latitude, longitude } = req.body;
  const newAlert = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    firstName: req.session.user.firstName || "",
    lastName: req.session.user.lastName || "",
    email: req.session.user.email,
    location: { latitude, longitude },
    encryptedLocalFile: req.session.user.latestUpload || null,
    status: "pending",
  };

  const alerts = loadAlerts(alertsFile);
  alerts.push(newAlert);
  saveAlerts(alertsFile, alerts);

  res.send("✅ Alert submitted.");
});

// GET /alerts - NGO admin views alerts
router.get("/alerts", (req, res) => {
  if (!req.session || req.session.user?.role !== "admin") {
    return res.status(403).send("Forbidden");
  }
  const alerts = loadAlerts(alertsFile).filter(
    (alert) => alert.status !== "removed",
  );
  res.json(alerts);
});

// PATCH /alerts/:id - update alert status
router.patch("/alerts/:id", (req, res) => {
  if (!req.session || req.session.user?.role !== "admin") {
    return res.status(403).send("Forbidden");
  }

  const { id } = req.params;
  const { status } = req.body;
  const alerts = loadAlerts(alertsFile);
  const alert = alerts.find((a) => a.id === id);
  if (!alert) return res.status(404).send("Alert not found");

  alert.status = status;
  saveAlerts(alertsFile, alerts);
  res.send("✅ Status updated");
});

// POST /alerts/:id/remove - move to bin
router.post("/alerts/:id/remove", (req, res) => {
  if (!req.session || req.session.user?.role !== "admin") {
    return res.status(403).send("Forbidden");
  }

  const { id } = req.params;
  let alerts = loadAlerts(alertsFile);
  const index = alerts.findIndex((a) => a.id === id);
  if (index === -1) return res.status(404).send("Alert not found");

  const [removedAlert] = alerts.splice(index, 1);
  removedAlert.removedAt = new Date().toISOString();

  const bin = loadAlerts(binFile);
  bin.push(removedAlert);

  saveAlerts(alertsFile, alerts);
  saveAlerts(binFile, bin);

  res.send("🗑️ Alert removed and moved to bin");
});

export default router;
