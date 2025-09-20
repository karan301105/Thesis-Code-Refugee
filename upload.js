import { Session } from "@inrupt/solid-client-authn-node";
import { overwriteFile } from "@inrupt/solid-client";
import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";
import mime from "mime-types"; // Install this with: npm install mime-types

dotenv.config();

const session = new Session();

async function uploadFile(localFilePath) {
  const fileName = path.basename(localFilePath);
  const podFolder = process.env.TARGET_POD_FOLDER.endsWith("/")
    ? process.env.TARGET_POD_FOLDER
    : process.env.TARGET_POD_FOLDER + "/";
  const remoteUrl = new URL(fileName, podFolder).href;

  try {
    await session.login({
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      oidcIssuer: process.env.OIDC_ISSUER,
    });

    if (!session.info.isLoggedIn) throw new Error("Login failed");

    console.log(`🔐 Logged in as: ${session.info.webId}`);
    console.log(`📤 Uploading ${fileName} to: ${remoteUrl}`);

    const fileData = fs.readFileSync(localFilePath);
    const contentType = mime.lookup(fileName) || "application/octet-stream";

    await overwriteFile(remoteUrl, fileData, {
      contentType,
      fetch: session.fetch,
    });

    console.log("✅ File uploaded successfully to Solid Pod.");
  } catch (err) {
    console.error("❌ Upload failed:", err.message);
  }
}

// Example usage
const filePath = "./example.txt"; // Replace with your file
uploadFile(filePath);
