// data/consentedEntries.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.resolve(__dirname, "../data/consented-journals.jsonl");

export async function getConsentedEntries() {
  let raw = "";
  try {
    raw = await fs.promises.readFile(DATA_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);

      // 🔁 Normalize into the shape used by /services + UI
      rows.push({
        id: r.url || r.id || r.link, // use the Solid URL as id
        link: r.url || r.link || r.id,
        date: r.date ?? r.date_event ?? null, // <-- normalize
        location: r.location ?? r.location_display_name ?? null, // <-- normalize
        ransom: r.ransom ?? null,
        male: r.male ?? null,
        female: r.female ?? null,
        kids: r.kids ?? null,
        total: r.total ?? null,
        // who is this from? (for NGO to see a name/id in UI)
        personId: r.reporter_email || r.reporter_webId || null,
      });
    } catch {}
  }
  return rows;
}
