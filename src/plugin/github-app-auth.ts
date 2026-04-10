import crypto from "node:crypto";
import { readFileSync } from "node:fs";

type GitHubAppConfig = {
  appId: string;
  privateKeyPath: string;
};

function createJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 10 * 60,
      iss: appId,
    }),
  ).toString("base64url");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

export async function getInstallationToken(
  config: GitHubAppConfig,
  installationId: number,
): Promise<string> {
  const privateKey = readFileSync(config.privateKeyPath, "utf8");
  const jwt = createJwt(config.appId, privateKey);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new Error("GitHub API did not return an installation token");
  }
  return data.token;
}

export type GitHubIssue = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
};

export async function searchIssuesByFingerprint(params: {
  token: string;
  repo: string;
  fingerprint: string;
}): Promise<GitHubIssue[]> {
  const query = encodeURIComponent(
    `repo:${params.repo} is:issue label:ai-review "${params.fingerprint}" in:body`,
  );
  const response = await fetch(`https://api.github.com/search/issues?q=${query}&per_page=5`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub issue search failed: ${response.status} ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as { items?: GitHubIssue[] };
  return data.items || [];
}

export async function createGitHubIssue(params: {
  token: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<GitHubIssue> {
  const response = await fetch(`https://api.github.com/repos/${params.repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      labels: params.labels,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub issue create failed: ${response.status} ${body.slice(0, 500)}`);
  }

  return (await response.json()) as GitHubIssue;
}

export async function commentOnGitHubIssue(params: {
  token: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${params.repo}/issues/${params.issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: params.body }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub issue comment failed: ${response.status} ${body.slice(0, 500)}`);
  }
}
