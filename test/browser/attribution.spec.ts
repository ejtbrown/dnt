import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, mint, origin, admin } from "../mcp-fixtures.js";

test("MCP writes appear as the account via the agent in comments, document history, and activity", async ({
  page,
}) => {
  const f = fixture();
  f.settings.identity.profile.name = "Erick Brown";
  const tokens = await mint(f);
  const client = new Client({ name: "browser-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: (input, init) => f.http(new Request(input, init)),
      requestInit: {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBeFalsy();
    return (r.structuredContent as any).result;
  };
  try {
    await call("create_project", {
      input: { slug: "MCP", name: "Agent workspace" },
      idempotencyKey: randomUUID(),
      agentName: "Planner",
    });
    const i = await call("create_work_item", {
      project: "MCP",
      input: { kind: "Initiative", title: "Launch" },
      idempotencyKey: randomUUID(),
    });
    const e = await call("create_work_item", {
      project: "MCP",
      input: { kind: "Epic", title: "Release", parentId: i.id },
      idempotencyKey: randomUUID(),
    });
    const t = await call("create_work_item", {
      project: "MCP",
      input: { kind: "Task", title: "Ship attribution", parentId: e.id },
      idempotencyKey: randomUUID(),
      agentName: "Builder",
    });
    await call("create_work_item_comment", {
      project: "MCP",
      id: t.id,
      input: { content: "Ready for review." },
      idempotencyKey: randomUUID(),
      agentName: "Review <script>",
    });
    const doc = await call("create_document", {
      project: "MCP",
      tree: "User",
      input: { title: "Agent guide", content: "First revision" },
      idempotencyKey: randomUUID(),
      agentName: "Writer",
    });
    await call("update_document", {
      project: "MCP",
      tree: "User",
      documentId: doc.id,
      patch: { content: "Updated by agent" },
      expectedVersion: 1,
      agentName: "Editor",
    });
    // Browser and official MCP client share the real service in this test. The
    // browser adapter supplies its authenticated name, as the Lambda does.
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const r = await f.service.handle({
        method: request.method(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers(),
        body: request.postData() ? request.postDataJSON() : undefined,
        principal: admin,
        userName: "Erick Brown",
      });
      await route.fulfill({
        status: r.status,
        contentType: "application/json",
        body: r.status === 204 ? "" : JSON.stringify(r.body),
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Ship attribution/ }).click();
    await expect(
      page.getByText("Erick Brown via Builder", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Erick Brown via Review <script>", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".task-comments script")).toHaveCount(0);
    await page.getByLabel("Comment", { exact: true }).fill("Human follow-up");
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(
      page
        .locator(".task-comment")
        .filter({ hasText: "Human follow-up" })
        .getByText("Erick Brown", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.screenshot({
      path: "test-results/agent-comments-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole("button", { name: "Documentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Agent guide", exact: true })
      .click();
    await expect(
      page.getByText("Erick Brown via Editor", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByLabel("Revision", { exact: true }).selectOption("1");
    await expect(
      page
        .getByRole("dialog")
        .getByText("Erick Brown via Writer", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Revision", { exact: true }).selectOption("2");
    await expect(
      page
        .getByRole("dialog")
        .getByText("Erick Brown via Editor", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/agent-document-history.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(
      page.getByText("Erick Brown via Planner", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Project activity" }),
    ).toBeVisible();
  } finally {
    await client.close();
  }
});
