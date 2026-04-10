import { createServer } from "node:http";
import { loadConfig } from "../plugin/config";
import {
  forwardGitHubReview,
  isGitHubPingEvent,
  isRepoAllowedForBridge,
  normalizeGitHubPushWebhook,
  verifyGitHubSignature,
} from "../github-webhook";

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const port = Number(process.env.GITHUB_REVIEW_BRIDGE_PORT || 8787);
const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
const taskDispatchUrl = process.env.TASK_DISPATCH_URL || "http://127.0.0.1:18789";
const taskDispatchApiKey = process.env.TASK_DISPATCH_API_KEY || process.env.OPENCLAW_API_KEY || "";
const config = loadConfig();

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/github/webhook") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const rawBody = await readBody(req);
  const signature = req.headers["x-hub-signature-256"];
  const signatureValue = Array.isArray(signature) ? signature[0] : signature;
  if (
    !verifyGitHubSignature({
      secret,
      body: rawBody,
      signature256: signatureValue,
    })
  ) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_signature" }));
    return;
  }

  try {
    const payload = JSON.parse(rawBody);
    const deliveryId = req.headers["x-github-delivery"];
    const eventName = req.headers["x-github-event"];
    const normalizedEventName = Array.isArray(eventName) ? eventName[0] : eventName;

    if (isGitHubPingEvent(normalizedEventName)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, event: "ping" }));
      return;
    }

    const normalized = normalizeGitHubPushWebhook({
      deliveryId: Array.isArray(deliveryId) ? deliveryId[0] : deliveryId,
      eventName: normalizedEventName,
      payload,
    });

    if (!isRepoAllowedForBridge({ repo: normalized.repo, projects: config.projects })) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "repo_not_allowed" }));
      return;
    }

    const forwarded = await forwardGitHubReview(normalized, {
      taskDispatchUrl,
      apiKey: taskDispatchApiKey,
    });

    process.stdout.write(`[github-review-bridge] ${JSON.stringify(normalized)}\n`);

    res.writeHead(forwarded.status, { "Content-Type": "application/json" });
    res.end(forwarded.body || JSON.stringify({ ok: true, normalized }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(port, () => {
  process.stdout.write(`[github-review-bridge] listening on :${port}\n`);
});
