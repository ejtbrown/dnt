import { test, expect } from "@playwright/test";
import { fixture, admin } from "../mcp-fixtures.js";
import { randomUUID } from "node:crypto";

test("renewal retains drafts and view, respects cancellation and never replays writes", async ({
  page,
  context,
}) => {
  const f = fixture();
  const call = async (path: string, body: unknown) => {
    const r = await f.service.handle({
      method: "POST",
      path: `/api/v1${path}`,
      principal: admin,
      body,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(r.status).toBe(201);
    return r.body as any;
  };
  await call("/projects", { slug: "SSO", name: "Session test" });
  const i = await call("/projects/SSO/items", {
    kind: "Initiative",
    title: "Initiative",
  });
  const e = await call("/projects/SSO/items", {
    kind: "Epic",
    title: "Epic",
    parentId: i.id,
  });
  const t = await call("/projects/SSO/items", {
    kind: "Task",
    title: "Task",
    parentId: e.id,
  });
  let mode = "success",
    exchanges = 0,
    writes = 0,
    rejectWrites = false,
    authorizeCount = 0;
  const jwt = (sub: string) =>
    `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;
  await context.route("**/config.json", (r) =>
    r.fulfill({
      json: { clientId: "browser", authDomain: "https://login.example.com" },
    }),
  );
  await context.route("https://login.example.com/oauth2/token", (r) => {
    if (r.request().method() === "OPTIONS")
      return r.fulfill({
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    exchanges++;
    return r.fulfill({
      json: {
        access_token: jwt(mode === "other-account" ? "someone-else" : admin),
        expires_in: 900,
      },
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await context.route(
    "https://login.example.com/oauth2/authorize?*",
    async (r) => {
      authorizeCount++;
      const state = new URL(r.request().url()).searchParams.get("state")!;
      if (mode === "stall")
        return r.fulfill({
          body: "Sign in when ready",
          contentType: "text/html",
        });
      const query = mode === "denied" ? "error=access_denied" : "code=renewed";
      await r.fulfill({
        status: 302,
        headers: {
          location: `http://127.0.0.1:5173/auth/callback?state=${state}&${query}`,
          "cross-origin-opener-policy": "same-origin",
        },
      });
    },
  );
  await context.route("https://login.example.com/logout?*", (r) =>
    r.fulfill({ body: "Signed out", contentType: "text/html" }),
  );
  await context.route("**/api/v1/**", async (r) => {
    const req = r.request(),
      url = new URL(req.url());
    if (["POST", "PATCH", "DELETE"].includes(req.method())) {
      writes++;
      if (rejectWrites)
        return r.fulfill({ status: 401, json: { error: "Expired" } });
    }
    const result = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      principal: admin,
      origin: "web",
      headers: req.headers(),
      query: Object.fromEntries(url.searchParams),
      body: req.postData() ? req.postDataJSON() : undefined,
    });
    await r.fulfill({ status: result.status, json: result.body });
  });
  await page.goto("/");
  await page.clock.install();
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.locator("nav")).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("button", { name: /SSO-3.*Task/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Unsaved title");
  const comment = dialog.getByRole("textbox", { name: "Comment", exact: true });
  await comment.fill("Unsaved comment");
  await page.clock.runFor(901_000);
  const renew = dialog.getByRole("button", {
    name: "Continue session",
    exact: true,
  });
  await expect(renew).toBeVisible();
  await dialog
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  expect(writes).toBe(0);
  for (const failure of ["denied", "other-account", "stall"]) {
    mode = failure;
    await renew.click();
    if (failure === "stall")
      await dialog.getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(renew).toBeEnabled();
    await expect(comment).toHaveText("Unsaved comment");
    expect(writes).toBe(0);
  }
  mode = "success";
  await renew.click();
  await expect(
    dialog.getByRole("button", { name: "Cancel sign-in" }),
  ).toHaveCount(0);
  await expect(renew).toHaveCount(0);
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
    "Unsaved title",
  );
  await expect(comment).toHaveText("Unsaved comment");
  await expect(page.locator("nav .active")).toContainText("Planning");
  expect(writes).toBe(0);
  await page.bringToFront();
  rejectWrites = true;
  await dialog
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect.poll(() => writes).toBe(1);
  await expect(renew).toBeVisible();
  await renew.click();
  await expect(
    dialog.getByRole("button", { name: "Cancel sign-in" }),
  ).toHaveCount(0);
  await expect(renew).toHaveCount(0);
  expect(writes).toBe(1);
  rejectWrites = false;
  await dialog
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(comment).toHaveText("");
  expect(writes).toBe(2);
  expect(exchanges).toBe(4);
  expect(authorizeCount).toBe(6);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ),
  ).not.toContain("signature");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Sign in/ })).toBeVisible();
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/login.example.com\/logout/);
});
