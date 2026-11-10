import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";
test("project administrators without dnt-admin can manage members but cannot create or delete projects", async ({
  page,
}) => {
  const f = fixture();
  const created = await f.service.handle({
    method: "POST",
    path: "/api/v1/projects",
    principal: admin,
    headers: { "idempotency-key": randomUUID() },
    body: { slug: "ADMIN", name: "Admin controls" },
  });
  expect(created.status).toBe(201);
  f.directory.administrators.delete(admin);
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const response = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      principal: admin,
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
  await page.goto("/");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add member", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete ADMIN", exact: true }),
  ).toHaveCount(0);
  f.directory.administrators.add(admin);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Delete ADMIN", exact: true }),
  ).toBeVisible();
  // Home navigation must preserve the document that owns the in-memory token.
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.getByRole("link", { name: "dnt home", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Work board", exact: true }),
  ).toBeVisible();
  expect(navigations).toBe(0);
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(
    "ADMIN",
  );
});
