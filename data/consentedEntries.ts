import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Adjust if your project structure differs
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.resolve(
  __dirname,
  "../../data/consented-journals.jsonl",
);

// Shape your routes/services expect:
export type ConsentedRow = {
  id?: string; // solid url or internal id
  link?: string; // for “Open”
  url?: string;
  date?: string; // ISO
  location?: string;
  male?: number;
  female?: number;
  kids?: number;
  total?: number;
  ransom?: number;
  // ...any other fields you have
};

// If you need NGO-based filtering, use req (e.g., req.session.ngoEmail)
export async function getConsentedEntries(/* req?: any */): Promise<
  ConsentedRow[]
> {
  const raw = await fs.promises.readFile(DATA_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const rows: ConsentedRow[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      rows.push(obj);
    } catch {
      // skip bad line
    }
  }

  // Example: filter by access for this NGO if you have that info in each row.
  // const ngoEmail = req?.session?.user?.email;
  // return rows.filter(r => r.visibleTo?.includes(ngoEmail));

  return rows;
}
