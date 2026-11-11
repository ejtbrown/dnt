import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";

test("task relationships, immutable history, threaded decisions and read-only users", async ({
  page,
}) => {
  const f = fixture();
  let principal = admin;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    version?: number,
  ) => {
    const response = await f.service.handle({
      method,
      path: `/api/v1${path}`,
      principal: admin,
      headers: {
        "idempotency-key": randomUUID(),
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
      body,
    });
    expect(response.status).toBeLessThan(300);
    return response.body as any;
  };
  await request("POST", "/projects", { slug: "FLOW", name: "Workflow test" });
  const initiative = await request("POST", "/projects/FLOW/items", {
    kind: "Initiative",
    title: "Initiative",
  });
  const epic = await request("POST", "/projects/FLOW/items", {
    kind: "Epic",
    title: "Epic",
    parentId: initiative.id,
  });
  const upstream = await request("POST", "/projects/FLOW/items", {
    kind: "Task",
    title: "Upstream",
    parentId: epic.id,
  });
  const task = await request("POST", "/projects/FLOW/items", {
    kind: "Task",
    title: "Target",
    parentId: epic.id,
  });
  await request("POST", "/projects/FLOW/members", {
    principal: "cognito:reader",
    role: "User",
  });
  const documents = [];
  for (const tree of ["User", "Maintainer", "Administrator"]) {
    documents.push({
      tree,
      document: await request("POST", `/projects/FLOW/docs/${tree}`, {
        title: `${tree} guide`,
        content: `# ${tree} content`,
      }),
    });
  }
  await request("POST", "/projects/FLOW/members", {
    principal: "cognito:maintainer",
    role: "Maintainer",
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const response = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      principal,
      origin: "web",
      headers: req.headers(),
      query: Object.fromEntries(url.searchParams),
      body: req.postData() ? req.postDataJSON() : undefined,
    });
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: response.status === 204 ? undefined : JSON.stringify(response.body),
    });
  });
  await page.goto(`/t/${task.id}`);
  await page.getByLabel("Due date (optional)").fill("2026-12-31");
  await page.getByLabel("Depends on work items").fill(upstream.id);
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("Cancelled");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /Target/ }).click();
  await expect(page.getByLabel("Due date (optional)")).toHaveValue(
    "2026-12-31",
  );
  await page
    .getByRole("button", { name: "Work item history", exact: true })
    .click();
  await expect(page.getByLabel("Work item history")).toContainText(
    "Revision 1",
  );
  await page
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Decision: approve this scope?");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  const original = page.locator(".task-comment").first();
  await expect(original).toContainText("Decision: approve this scope?");
  await original.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply", exact: true })
    .fill("Only after the tests pass.");
  await page.getByRole("button", { name: "Post reply", exact: true }).click();
  const reply = page.locator(".task-comment").nth(1);
  await reply.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply", exact: true })
    .fill("Tests passed.");
  await page.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(page.locator(".task-comment")).toHaveCount(3);
  await original
    .getByRole("button", { name: "👍 Acknowledge", exact: true })
    .click();
  await expect(original).toContainText("Acknowledgement by");
  page.once("dialog", (dialog) => dialog.dismiss());
  await original
    .getByRole("button", { name: "👍 Approve revision 1", exact: true })
    .click();
  await expect(original.getByText("Approval by", { exact: false })).toHaveCount(
    0,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await original
    .getByRole("button", { name: "👍 Approve revision 1", exact: true })
    .click();
  await expect(original).toContainText("Approval by");
  await original
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await original
    .getByRole("textbox", { name: "Edit comment", exact: true })
    .fill("Decision: changed scope");
  await original
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(original).toContainText(
    "earlier text, not the current revision",
  );
  const href = await original
    .getByRole("link", { name: /Link to comment/ })
    .getAttribute("href");
  await page.goto(href!);
  await expect(page.locator(".task-comment").first()).toContainText(
    "Decision: changed scope",
  );
  await page.goto(`/t/${epic.id}`);
  await expect(
    page.getByText("State: Implement (derived from descendant Tasks)"),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "State", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Related work items").fill(initiative.id);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.goto(`/t/${epic.id}`);
  await expect(page.getByLabel("Related work items")).toHaveValue(
    initiative.id,
  );
  await page.goto(`/t/${task.id}`);
  principal = "cognito:reader";
  await page.reload();
  await expect(page.getByLabel("Due date (optional)")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Post comment", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reply", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Approve revision/ }),
  ).toHaveCount(0);
  const prefixes: Record<string, string> = {
    User: "user",
    Maintainer: "maintainer",
    Administrator: "admin",
  };
  for (const { tree, document } of documents) {
    await page.goto(`/d/${prefixes[tree]}-${document.id}`);
    await expect(
      page.getByRole("heading", { name: `${tree} content`, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit page", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete page", exact: true }),
    ).toBeDisabled();
  }
  principal = "cognito:maintainer";
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Members", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Page content", exact: true })
    .fill("# Maintainer updated Administrator guide");
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Maintainer updated Administrator guide",
      exact: true,
    }),
  ).toBeVisible();
});
