import { test, expect } from "@playwright/test";
import { fixture, admin } from "../mcp-fixtures.js";
import { randomUUID } from "node:crypto";

test("silent top-level renewal restores drafts and view without replay or redirect loops", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
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
  let holdMutation: Promise<void> | undefined;
  let releaseMutation: (() => void) | undefined;
  const prompts: (string | null)[] = [];
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
      prompts.push(new URL(r.request().url()).searchParams.get("prompt"));
      const state = new URL(r.request().url()).searchParams.get("state")!;
      if (mode === "stall")
        return r.fulfill({
          body: "Sign in when ready",
          contentType: "text/html",
        });
      const query = mode === "denied" ? "error=login_required" : "code=renewed";
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
      if (holdMutation) await holdMutation;
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
  const restored = async () => {
    await expect(
      page.getByRole("dialog").getByLabel("Title", { exact: true }),
    ).toHaveValue("Unsaved title");
    await expect(
      page.getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveText("Unsaved comment");
    await expect(page.locator("nav .active")).toContainText("Planning");
  };
  await page.clock.runFor(871_000);
  await expect.poll(() => exchanges).toBe(2);
  await restored();
  expect(writes).toBe(0);
  expect(authorizeCount).toBe(2);
  expect(prompts.slice(0, 2)).toEqual([null, "none"]);
  expect(context.pages().length).toBe(1);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ),
  ).not.toContain("signature");

  rejectWrites = true;
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Continue session" }),
  ).toBeVisible();
  expect(exchanges).toBe(2);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue session" })
    .click();
  await expect.poll(() => exchanges).toBe(3);
  await restored();
  expect(writes).toBe(1);
  rejectWrites = false;

  mode = "denied";
  await page.clock.runFor(871_000);
  await expect(page.getByRole("button", { name: /^Sign in/ })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Your shared session has ended",
  );
  const failedAttempts = authorizeCount;
  await page.reload();
  await expect(page.getByRole("button", { name: /^Sign in/ })).toBeVisible();
  expect(authorizeCount).toBe(failedAttempts);
  mode = "other-account";
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.getByRole("alert")).toContainText("same account");
  expect(
    await page.evaluate(() => sessionStorage.getItem("dnt.renewal-drafts")),
  ).toContain("Unsaved comment");
  mode = "success";
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await restored();

  mode = "stall";
  await page.clock.runFor(871_000);
  await expect(page).toHaveURL(/login.example.com/);
  await page.goBack();
  await expect(page.getByRole("button", { name: /^Sign in/ })).toBeVisible();
  const cancelledAttempts = authorizeCount;
  await page.goForward();
  await expect(page).toHaveURL(/login.example.com/);
  await page.goBack();
  await expect(page.getByRole("button", { name: /^Sign in/ })).toBeVisible();
  expect(authorizeCount).toBeLessThanOrEqual(cancelledAttempts + 1);
  mode = "success";
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await restored();
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveText("");
  expect(writes).toBe(2);
  await page.getByRole("button", { name: "Edit comment", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit comment", exact: true })
    .fill("Edited comment draft");
  let before = exchanges;
  await page.clock.runFor(871_000);
  await expect.poll(() => exchanges).toBe(before + 1);
  await expect(
    page.getByRole("textbox", { name: "Edit comment", exact: true }),
  ).toHaveText("Edited comment draft");
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply", exact: true })
    .fill("Reply draft survives");
  before = exchanges;
  await page.clock.runFor(871_000);
  await expect.poll(() => exchanges).toBe(before + 1);
  await expect(
    page.getByRole("textbox", { name: "Reply", exact: true }),
  ).toHaveText("Reply draft survives");
  await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Posted during expiry");
  holdMutation = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect.poll(() => writes).toBe(3);
  before = exchanges;
  const originalDestination = page.url();
  await page.clock.runFor(871_000);
  expect(exchanges).toBe(before);
  await expect(page).toHaveURL(originalDestination);
  releaseMutation!();
  holdMutation = undefined;
  await expect.poll(() => exchanges).toBe(before + 1);
  await expect(
    page.getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveText("");
  expect(writes).toBe(3);
  await page.getByRole("button", { name: "Close dialog" }).click();
  const renewAndCheck = async (
    field: ReturnType<typeof page.getByLabel>,
    value: string,
  ) => {
    const before = exchanges;
    await page.clock.runFor(871_000);
    await expect.poll(() => exchanges).toBe(before + 1);
    await expect(field).toHaveValue(value);
  };
  await page
    .getByRole("button", { name: "New work item", exact: true })
    .click();
  await page.getByLabel("Title", { exact: true }).fill("New task draft");
  await renewAndCheck(
    page.getByLabel("Title", { exact: true }),
    "New task draft",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("New project draft");
  await renewAndCheck(page.getByLabel("Project name"), "New project draft");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "Documentation" })
    .click();
  await page
    .getByRole("button", { name: "New page", exact: true })
    .first()
    .click();
  await page.getByLabel("Page title").fill("New document draft");
  await renewAndCheck(page.getByLabel("Page title"), "New document draft");
  await page.getByRole("button", { name: "Close dialog" }).click();
  const doc = await call("/projects/SSO/docs/User", {
    title: "Existing document",
    content: "Original",
  });
  await page.goto(`/d/user-${doc.id}`);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await page.getByLabel("Page title").fill("Edited document draft");
  mode = "denied";
  await page.clock.runFor(871_000);
  await expect(page.getByRole("button", { name: /^Sign in/ })).toBeVisible();
  mode = "success";
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(new RegExp(`/d/user-${doc.id}$`));
  await expect(page.getByLabel("Page title")).toHaveValue(
    "Edited document draft",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "Members", exact: true })
    .click();
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption("Maintainer");
  await renewAndCheck(
    page.getByRole("combobox", { name: "Role", exact: true }),
    "Maintainer",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/login.example.com\/logout/);
});
