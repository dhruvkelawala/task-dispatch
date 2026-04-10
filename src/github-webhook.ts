import crypto from "node:crypto";

export type GitHubPushWebhook = {
  ref?: string;
  before?: string;
  after?: string;
  compare?: string;
  installation?: { id?: number | null } | null;
  pusher?: { name?: string | null } | null;
  repository?: {
    full_name?: string | null;
    default_branch?: string | null;
  } | null;
};

export type NormalizedGitHubReviewPayload = {
  repo: string;
  beforeSha: string;
  sha: string;
  branch: string;
  pusher: string | null;
  compareUrl: string | null;
  deliveryKey: string;
  installationId: number | null;
};

export type ForwardReviewConfig = {
  taskDispatchUrl: string;
  apiKey?: string | null;
};

export type GitHubBridgeProjectConfig = {
  repo?: string;
};

export function verifyGitHubSignature(params: {
  secret: string;
  body: string;
  signature256?: string | null;
}): boolean {
  if (!params.secret) {
    return false;
  }
  if (!params.signature256?.startsWith("sha256=")) {
    return false;
  }
  const actual = crypto.createHmac("sha256", params.secret).update(params.body).digest("hex");
  const expected = params.signature256.slice("sha256=".length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function normalizeGitHubPushWebhook(params: {
  deliveryId?: string | null;
  eventName?: string | null;
  payload: GitHubPushWebhook;
}): NormalizedGitHubReviewPayload {
  if (params.eventName !== "push") {
    throw new Error("unsupported_github_event");
  }
  const deliveryKey = params.deliveryId?.trim();
  if (!deliveryKey) {
    throw new Error("missing_delivery_id");
  }
  const ref = params.payload.ref?.trim() || "";
  if (!ref.startsWith("refs/heads/")) {
    throw new Error("unsupported_ref");
  }
  const branch = ref.slice("refs/heads/".length);
  if (branch !== "main") {
    throw new Error("unsupported_branch");
  }

  const repo = params.payload.repository?.full_name?.trim() || "";
  const sha = params.payload.after?.trim() || "";
  if (!repo || !sha) {
    throw new Error("invalid_push_payload");
  }

  return {
    repo,
    beforeSha: params.payload.before?.trim() || `${sha}^`,
    sha,
    branch,
    pusher: params.payload.pusher?.name?.trim() || null,
    compareUrl: params.payload.compare?.trim() || null,
    deliveryKey,
    installationId:
      typeof params.payload.installation?.id === "number" ? params.payload.installation.id : null,
  };
}

export function isGitHubPingEvent(eventName?: string | null): boolean {
  return eventName === "ping";
}

export function buildTaskDispatchReviewForwardRequest(
  payload: NormalizedGitHubReviewPayload,
  config: ForwardReviewConfig,
): {
  url: string;
  init: RequestInit;
} {
  const baseUrl = config.taskDispatchUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey?.trim()) {
    headers["X-API-Key"] = config.apiKey.trim();
  }
  return {
    url: `${baseUrl}/api/tasks/review`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  };
}

export async function forwardGitHubReview(
  payload: NormalizedGitHubReviewPayload,
  config: ForwardReviewConfig & {
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  },
): Promise<{ status: number; body: string }> {
  const fetchImpl = config.fetchImpl || fetch;
  const request = buildTaskDispatchReviewForwardRequest(payload, config);
  const response = await fetchImpl(request.url, request.init);
  return {
    status: response.status,
    body: await response.text(),
  };
}

export function isRepoAllowedForBridge(params: {
  repo: string;
  projects?: Record<string, GitHubBridgeProjectConfig>;
}): boolean {
  const target = params.repo.trim().toLowerCase();
  if (!target) {
    return false;
  }
  return Object.values(params.projects || {}).some(
    (project) => project.repo?.trim().toLowerCase() === target,
  );
}
