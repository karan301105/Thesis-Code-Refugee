// sync.js
import express from "express";
import {
  getSolidDataset,
  getContainedResourceUrlAll,
  getThingAll,
  getStringNoLocale
} from "@inrupt/solid-client";
import { Session } from "@inrupt/solid-client-authn-node";

const router = express.Router();

router.get("/sync", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).send("Unauthorized. Please log in.");

  try {
    const session = new Session();
    await session.login({
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      oidcIssuer: user.oidcIssuer,
    });

    const podFolder = user.targetPod.endsWith("/") ? user.targetPod : user.targetPod + "/";
    const dataset = await getSolidDataset(podFolder, { fetch: session.fetch });
    const resourceUrls = getContainedResourceUrlAll(dataset).filter(url => url.endsWith(".ttl"));

    const results = [];
    for (const url of resourceUrls) {
      try {
        const data = await getSolidDataset(url, { fetch: session.fetch });
        const things = getThingAll(data);
        const thing = things[0];

        const title = getStringNoLocale(thing, "http://purl.org/dc/elements/1.1/title");
        let contentUrl = getStringNoLocale(thing, "http://schema.org/contentUrl");
        const encryptedCopy = getStringNoLocale(thing, "http://schema.org/encryptedCopy");

        // Fallback for missing contentUrl
        if (!contentUrl && url.endsWith(".ttl")) {
          contentUrl = url.replace(/\.ttl$/, "");
        }

        if (contentUrl && encryptedCopy) {
          results.push({
            title: title || encryptedCopy,
            url: contentUrl,
            encryptedLocalFile: encryptedCopy
          });
        } else {
          console.warn("⚠️ Incomplete metadata in", url, "(contentUrl:", contentUrl, ", encryptedCopy:", encryptedCopy, ")");
        }
      } catch (e) {
        console.warn("⚠️ Skipping unreadable metadata:", url);
      }
    }

    res.json(results);
  } catch (err) {
    console.error("❌ Sync error:", err);
    res.status(500).send("Sync failed.");
  }
});

export default router;
