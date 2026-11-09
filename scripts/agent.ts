import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
// Example: AWS_PROFILE=default npx tsx scripts/agent.ts GET /me
const [method = "GET", path = "/me", json, version] = process.argv.slice(2);
const endpoint = process.env.DNT_AGENT_API;
if (!endpoint)
  throw new Error(
    "Set DNT_AGENT_API to the AgentApi stack output (ending in /agent/v1)",
  );
const url = new URL(`${endpoint}${path}`);
if (
  url.protocol !== "https:" ||
  !/^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
)
  throw new Error("Use the regional API Gateway HTTPS endpoint from AgentApi");
const region = url.hostname.split(".")[2];
const headers: Record<string, string> = { host: url.host };
if (json) {
  JSON.parse(json);
  headers["content-type"] = "application/json";
}
if (method === "POST") {
  if (!process.env.DNT_REQUEST_KEY)
    throw new Error(
      "Set a stable DNT_REQUEST_KEY for this create request; reuse it when retrying",
    );
  headers["idempotency-key"] = process.env.DNT_REQUEST_KEY;
}
if (version) headers["if-match"] = `"${version}"`;
const signer = new SignatureV4({
  service: "execute-api",
  region,
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});
const signed = await signer.sign(
  new HttpRequest({
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body: json,
  }),
);
const response = await fetch(url, {
  method,
  headers: signed.headers,
  body: json,
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
