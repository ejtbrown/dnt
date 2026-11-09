import { execFileSync } from "node:child_process";
export function aws(args: string[]) {
  const result = execFileSync("aws", [...args, "--output", "json", "--no-cli-pager"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  try { return JSON.parse(result); } catch { return result; }
}
export function cdk(args: string[]) {
  execFileSync("npx", ["--no-install", "cdk", ...args], { stdio: "inherit" });
}
export function verifyAccount(account: string) {
  if (aws(["sts", "get-caller-identity"]).Account !== account)
    throw new Error("AWS credentials target the wrong account");
}
