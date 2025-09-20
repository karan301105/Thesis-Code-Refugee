import crypto from "crypto";
import fs from "fs";

const algorithm = "aes-256-cbc";
const key = crypto.scryptSync(process.env.ENCRYPTION_SECRET || "default", "salt", 32);
const iv = Buffer.alloc(16, 0); // 16-byte zeroed IV

// Encrypts a Buffer and writes it to a file
export function encryptFile(buffer, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const cipher = crypto.createCipheriv(algorithm, key, iv);
      const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
      fs.writeFile(outputPath, encrypted, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Decrypts an encrypted file and returns a Buffer
export function decryptFileToBuffer(inputPath) {
  return new Promise((resolve, reject) => {
    try {
      const decipher = crypto.createDecipheriv(algorithm, key, iv);
      const chunks = [];

      const input = fs.createReadStream(inputPath);
      input.on("data", chunk => chunks.push(decipher.update(chunk)));
      input.on("end", () => {
        chunks.push(decipher.final());
        resolve(Buffer.concat(chunks));
      });
      input.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
