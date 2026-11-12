import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";
test("dependency view opens large project-scoped dialog and project options show both flags", async ({
  page,
}) => {
  const f = fixture();
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
  await call("POST", "/projects", { slug: "VIEW", name: "View test" });
  const i = await call("POST", "/projects/VIEW/items", {
    kind: "Initiative",
    title: "Initiative",
  });
  const e = await call("POST", "/projects/VIEW/items", {
    kind: "Epic",
    title: "Epic",
    parentId: i.id,
  });
  const a = await call("POST", "/projects/VIEW/items", {
    kind: "Task",
    title: "Decision needed",
    state: "Needs Attention",
    parentId: e.id,
  });
  await call("POST", "/projects/VIEW/items", {
    kind: "Task",
    title: "Concept scope",
    parentId: e.id,
  });
  await call("POST", "/projects/VIEW/items", {
    kind: "Task",
    title: "Waiting implementation",
    state: "Implement",
    parentId: e.id,
    dependencies: [a.id],
  });
  await call("POST", "/projects/VIEW/items", {
    kind: "Task",
    title: "Finished scope",
    state: "Done",
    parentId: e.id,
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const r = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      principal: admin,
      origin: "web",
      headers: req.headers(),
      query: Object.fromEntries(url.searchParams),
      body: req.postData() ? req.postDataJSON() : undefined,
    });
    await route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: r.status === 204 ? undefined : JSON.stringify(r.body),
    });
  });
  await page.goto("/");
  const picker = page.getByRole("button", { name: "Project", exact: true });
  await expect(
    picker.getByRole("img", { name: "Contains Needs Attention work" }),
  ).toBeVisible();
  await expect(
    picker.getByRole("img", { name: "Contains Concept work" }),
  ).toBeVisible();
  await picker.click();
  await expect(
    page
      .locator("#project-options")
      .getByRole("img", { name: "Contains Needs Attention work" }),
  ).toBeVisible();
  await page.locator("#project-options button").click();
  await page
    .getByRole("button", { name: "Dependency View", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const dimensions = await dialog.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
    viewportW: innerWidth,
    viewportH: innerHeight,
  }));
  expect(Math.abs(dimensions.width - dimensions.viewportW * 0.9)).toBeLessThan(
    2,
  );
  expect(Math.abs(dimensions.height - dimensions.viewportH * 0.9)).toBeLessThan(
    2,
  );
  await expect(dialog).toContainText("Decision needed");
  await expect(dialog).not.toContainText("Finished scope");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
