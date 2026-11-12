import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";
test("assignment finds full names and saves only the selected principal", async ({
  page,
}) => {
  const f = fixture();
  f.directory.accounts.set("cognito:duplicate", {
    principal: "cognito:duplicate",
    username: "duplicate",
    name: "Teammate",
    enabled: true,
    status: "CONFIRMED",
  });
  const call = async (method: string, path: string, body?: unknown) =>
    (
      await f.service.handle({
        method,
        path: `/api/v1${path}`,
        body,
        principal: admin,
        headers: { "idempotency-key": randomUUID() },
      })
    ).body as any;
  await call("POST", "/projects", { slug: "PICK", name: "Picker" });
  await call("POST", "/projects/PICK/members", {
    principal: "cognito:teammate",
    role: "Maintainer",
  });
  await call("POST", "/projects/PICK/members", {
    principal: "cognito:duplicate",
    role: "Maintainer",
  });
  const i = await call("POST", "/projects/PICK/items", {
    kind: "Initiative",
    title: "I",
  });
  const e = await call("POST", "/projects/PICK/items", {
    kind: "Epic",
    title: "E",
    parentId: i.id,
  });
  const t = await call("POST", "/projects/PICK/items", {
    kind: "Task",
    title: "T",
    parentId: e.id,
  });
  let saved: any;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === "PATCH" && url.pathname.endsWith(`/items/${t.id}`))
      saved = req.postDataJSON();
    const res = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      principal: admin,
      origin: "web",
      headers: req.headers(),
      query: Object.fromEntries(url.searchParams),
      body: req.postData() ? req.postDataJSON() : undefined,
    });
    await route.fulfill({
      status: res.status,
      contentType: "application/json",
      body: res.status === 204 ? undefined : JSON.stringify(res.body),
    });
  });
  await page.goto(`/t/${t.id}`);
  await page.getByLabel("Assignee (optional)").fill("Team");
  await page
    .getByRole("button", { name: "Teammate cognito:teammate", exact: true })
    .click();
  await expect(page.getByLabel("Assignee (optional)")).toHaveValue("Teammate");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saved.assignee).toBe("cognito:teammate");
  await page.goto(`/t/${t.id}`);
  await expect(page.getByLabel("Assignee (optional)")).toHaveValue("Teammate");
  await page.getByLabel("Assignee (optional)").fill("Not a project member");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByLabel("Assignee (optional)").fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saved.assignee).toBeNull();
});
