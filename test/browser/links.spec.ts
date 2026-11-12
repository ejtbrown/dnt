import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";
import { documentLink } from "../../src/shared/links.js";
import { roles, type WorkItem, type Document } from "../../src/shared/model.js";

async function setup() {
  const f = fixture();
  const request = async (path: string, body: unknown) => {
    const result = await f.service.handle({
      method: "POST",
      path: `/api/v1${path}`,
      principal: admin,
      body,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(result.status).toBe(201);
    return result.body;
  };
  for (const slug of ["AA", "BB"])
    await request("/projects", { slug, name: `${slug} project` });
  const items: WorkItem[] = [];
  for (const kind of ["Initiative", "Epic", "Task"])
    items.push(
      await request("/projects/BB/items", {
        kind,
        title: `${kind} linked`,
        parentId: items.at(-1)?.id,
        description:
          "# A long description\n\n" +
          "Paragraph of work item context.\n\n".repeat(40),
      }),
    );
  const docs: Document[] = [];
  for (const tree of roles)
    docs.push(
      await request(`/projects/BB/docs/${tree}`, {
        title: `${tree} linked page`,
        content:
          "# Linked content\n\n**Formatted** Markdown.\n\n[Related task](/t/BB-3)",
      }),
    );
  const route = async (page: Page, signedIn = true) => {
    await page.route("**/config.json", (r) =>
      r.fulfill({
        json: {
          local: signedIn,
          clientId: "browser-client",
          authDomain: "https://login.example.com",
        },
      }),
    );
    await page.route("**/api/v1/**", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      const response = await f.service.handle({
        method: req.method(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers(),
        principal:
          signedIn || req.headers().authorization === "Bearer browser-token"
            ? admin
            : "",
        body: req.postData() ? req.postDataJSON() : undefined,
      });
      await route.fulfill({
        status: response.status,
        headers: response.headers,
        contentType: "application/json",
        body: response.status === 204 ? "" : JSON.stringify(response.body),
      });
    });
  };
  return { ...f, items, docs, route };
}

test("all work and document links survive reload, select their project and retain a fixed dialog header", async ({
  page,
}) => {
  const f = await setup();
  await f.route(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const item of f.items) {
      await page.goto(`/t/${item.id}`);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByLabel("Project", { exact: true })).toHaveAttribute(
        "value",
        "BB",
      );
      await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
        item.title,
      );
      await expect(
        dialog.getByRole("link", { name: "Direct link" }),
      ).toHaveAttribute("href", `/t/${item.id}`);
      expect((await dialog.boundingBox())!.width).toBeCloseTo(width * 0.75, 1);
      const header = dialog.locator(".dialog-title");
      const before = await header.boundingBox();
      await dialog.locator(".dialog-body").evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      expect(
        await dialog.locator(".dialog-body").evaluate((e) => e.scrollTop),
      ).toBeGreaterThan(0);
      expect(await header.boundingBox()).toEqual(before);
      await expect(
        dialog.getByRole("button", { name: "Close dialog" }),
      ).toBeVisible();
      expect(await dialog.evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(
        await dialog.evaluate((e) => e.clientWidth),
      );
      if (item.kind === "Task")
        await page.screenshot({
          path: `test-results/linked-task-${width}.png`,
          fullPage: true,
        });
      await page.getByRole("button", { name: "Close dialog" }).click();
      await expect(page).toHaveURL("/");
      await page.goBack();
      await expect(page.getByRole("dialog")).toBeVisible();
    }
  }
  for (const doc of f.docs) {
    const path = documentLink(doc.tree, doc.id);
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: doc.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Project", { exact: true })).toHaveAttribute(
      "value",
      "BB",
    );
    await expect(
      page.getByRole("link", { name: "Direct link" }),
    ).toHaveAttribute("href", path);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: doc.title, exact: true }),
    ).toBeVisible();
  }
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.getByRole("link", { name: "Related task", exact: true }).click();
  await expect(page).toHaveURL("/t/BB-3");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(navigations).toBe(1); // History API navigation only; no document reload.
  expect(errors).toEqual([]);
});

test("Public is opt-in, anonymous readers see one formatted page, and cancellation/deletion/revocation work", async ({
  page,
  context,
}) => {
  const f = await setup();
  await f.route(page);
  const doc = f.docs[0],
    path = documentLink(doc.tree, doc.id);
  await page.goto(path);
  const checkbox = page.getByRole("checkbox", { name: "Public", exact: true });
  await expect(checkbox).not.toBeChecked();
  const reader = await context.newPage();
  await f.route(reader, false);
  await reader.goto(path);
  await expect(reader.getByRole("alert")).toContainText("unavailable");
  await expect(reader.getByRole("heading", { name: doc.title })).toHaveCount(0);
  await checkbox.check();
  await expect(checkbox).toBeEnabled();
  await reader.reload();
  await expect(reader.getByRole("heading", { name: doc.title })).toBeVisible();
  await expect(reader.locator("strong")).toHaveText("Formatted");
  for (const name of [
    "Edit page",
    "Delete page",
    "History",
    "New page",
    "Documentation",
  ])
    await expect(reader.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await reader.screenshot({
    path: "test-results/public-page.png",
    fullPage: true,
  });
  await checkbox.uncheck();
  await expect(checkbox).toBeEnabled();
  await reader.reload();
  await expect(reader.getByRole("alert")).toContainText("unavailable");
  await checkbox.check();
  await expect(checkbox).toBeEnabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: doc.title, exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Are you sure");
    return dialog.accept();
  });
  await page.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: doc.title, exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL("/");
  await reader.reload();
  await expect(reader.getByRole("alert")).toContainText("unavailable");
  await reader.goto("/");
  await expect(
    reader.getByRole("button", { name: /Sign in with/ }),
  ).toBeVisible();
  await expect(reader.getByRole("heading", { name: doc.title })).toHaveCount(0);
});

test("sign-in returns to private work/document links and same-site navigation keeps the token in memory", async ({
  page,
}) => {
  const f = await setup();
  await f.route(page, false);
  await page.route("https://login.example.com/oauth2/token", (r) =>
    r.fulfill({
      json: { access_token: "browser-token" },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  for (const path of ["/t/BB-3", documentLink("Administrator", f.docs[2].id)]) {
    let state = "";
    await page.route(
      "https://login.example.com/oauth2/authorize?*",
      async (r) => {
        state = new URL(r.request().url()).searchParams.get("state")!;
        await r.fulfill({ contentType: "text/html", body: "Sign in" });
      },
    );
    await page.goto(path);
    await page.getByRole("button", { name: /^Sign in/ }).click();
    await expect(page).toHaveURL(/login.example.com/);
    await page.goto(
      `/auth/callback?code=sample&state=${encodeURIComponent(state)}`,
    );
    await expect(page).toHaveURL(path);
    if (path.startsWith("/t/"))
      await expect(page.getByRole("dialog")).toBeVisible();
    else {
      await expect(
        page.getByRole("heading", { name: f.docs[2].title }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Related task", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("button", { name: /^Sign in/ })).toHaveCount(
        0,
      );
    }
  }
});
