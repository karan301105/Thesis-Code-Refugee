import vision from '@google-cloud/vision';
import sharp from 'sharp';

const client = new vision.ImageAnnotatorClient();

const regexes = {
  dob: /\b\d{1,2}[ /-]\d{1,2}[ /-]\d{2,4}\b/g, // more flexible, catches "06 09 2001"
  fullName: /^[A-Z][a-z]+\s+[A-Z][a-z]+$/,
  allCapsName: /^[A-Z\s]{5,}$/,
};

const preservedLabels = [
  "passport", "id", "document", "number", "issued", "nationality", "country", "type", "permit"
];

const nameLabels = ["name", "voornaam", "surname", "given", "naam"];
const dobLabels = ["birth", "geboorte", "dob", "geboortedatum", "date of birth"];

export async function processAndBlur(filePath) {
  console.log("📥 Starting redaction for:", filePath);

  const [result] = await client.documentTextDetection(filePath);
  const annotation = result.fullTextAnnotation;

  if (!annotation || !annotation.pages) {
    console.log("⚠️ No OCR results found.");
    return null;
  }

  const allText = annotation.text || "";
  console.log("🔤 Extracted Text:\n", allText);

  const lines = allText.split(/\n+/);
  const possibleNames = new Set();

  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
if (nameLabels.some(lbl => lower.includes(lbl))) {
  // same-line scan
  const afterLabel = line.split(/[:\-]/).pop().trim();
  if (afterLabel) {
    afterLabel.split(/\s+/).forEach(p => {
      if (p.length > 1) possibleNames.add(p.toLowerCase());
    });
  }

  // also scan next 5–10 lines even if one-word entries
  for (let j = 1; j <= 10 && lines[idx + j]; j++) {
    const next = lines[idx + j].trim();
    const parts = next.split(/\s+/);
    if (parts.length <= 4) {
      parts.forEach(p => {
        if (/^[A-Z][a-z]+$/.test(p) || /^[A-Z]+$/.test(p)) {
          possibleNames.add(p.toLowerCase());
        }
      });
    }
  }
}

  });

  console.log("🧠 Auto-detected name tokens:", [...possibleNames].join(", "));

  const blurBoxes = [];

  annotation.pages.forEach(page => {
    page.blocks.forEach(block => {
      block.paragraphs.forEach(paragraph => {
        const words = paragraph.words;
        const wordList = words.map(w => w.symbols.map(s => s.text).join("").trim());
        const joined = wordList.join(" ");

        const dobMatches = [...joined.matchAll(regexes.dob)].map(m => m[0]);

        // loop through words
        for (let i = 0; i < wordList.length; i++) {
          const text = wordList[i];
          const lower = text.toLowerCase();
          const word = words[i];

          const isName = possibleNames.has(lower);
          const isSuspectName = regexes.fullName.test(text) || regexes.allCapsName.test(text);
          const isPreserved = preservedLabels.some(label => lower.includes(label));
          const isSensitiveName = (isName || isSuspectName) && !isPreserved;

          const isPartOfDOB = dobMatches.some(match =>
            match.includes(text) || match.includes(text.replace(/[^0-9]/g, ""))
          );

          if (isSensitiveName || isPartOfDOB) {
            const vertices = word.boundingBox.vertices;
            const x0 = Math.min(...vertices.map(v => v.x || 0));
            const y0 = Math.min(...vertices.map(v => v.y || 0));
            const x1 = Math.max(...vertices.map(v => v.x || 0));
            const y1 = Math.max(...vertices.map(v => v.y || 0));
            blurBoxes.push({ x0, y0, x1, y1 });
            console.log(`🔒 Redacting: "${text}" at [${x0},${y0}] to [${x1},${y1}]`);
          }
        }
      });
    });
  });

  if (blurBoxes.length === 0) {
    console.log("⚠️ No sensitive matches — inserting fallback test box.");
    blurBoxes.push({ x0: 100, y0: 100, x1: 250, y1: 150 });
  }

  const overlays = [];
  for (const { x0, y0, x1, y1 } of blurBoxes) {
    const width = x1 - x0;
    const height = y1 - y0;
    const blurOverlay = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 50, g: 50, b: 50 }
      }
    }).png().blur(30).toBuffer();

    overlays.push({ input: blurOverlay, top: y0, left: x0 });
  }

  const redactedBuffer = await sharp(filePath)
    .composite(overlays)
    .jpeg()
    .toBuffer();

  console.log("✅ Redacted image processed in memory");
  return redactedBuffer;
}
