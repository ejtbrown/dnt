import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";

test("newest roots, top composer and flat inline replies preserve legacy parent evidence", async ({
  page,
}) => {
  const f = fixture();
  const request = async (method: string, path: string, body?: unknown) => {
    const r = await f.service.handle({
      method,
      path: `/api/v1${path}`,
      principal: admin,
      headers: { "idempotency-key": randomUUID() },
      body,
    });
    expect(r.status).toBeLessThan(300);
    return r.body as any;
  };
  await request("POST", "/projects", { slug: "CHAT", name: "Comments" });
  const initiative = await request("POST", "/projects/CHAT/items", {
    kind: "Initiative",
    title: "Initiative",
  });
  const epic = await request("POST", "/projects/CHAT/items", {
    kind: "Epic",
    title: "Epic",
    parentId: initiative.id,
  });
  const task = await request("POST", "/projects/CHAT/items", {
    kind: "Task",
    title: "Task",
    parentId: epic.id,
  });
  const path = `/projects/CHAT/items/${task.id}/comments`;
  const old = await request("POST", path, { content: "Old root" });
  await new Promise((r) => setTimeout(r, 5));
  const reply = await request("POST", path, {
    content: "Old reply",
    parentCommentId: old.id,
  });
  await new Promise((r) => setTimeout(r, 5));
  const nested = await request("POST", path, {
    content: "Legacy nested reply",
    parentCommentId: reply.id,
  });
  await new Promise((r) => setTimeout(r, 5));
  const newest = await request("POST", path, { content: "Newest root" });
  let posted: any;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const body = req.postData() ? req.postDataJSON() : undefined;
    if (req.method() === "POST" && url.pathname.endsWith("/comments"))
      posted = body;
    const r = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      principal: admin,
      origin: "web",
      headers: req.headers(),
      query: Object.fromEntries(url.searchParams),
      body,
    });
    await route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: r.status === 204 ? undefined : JSON.stringify(r.body),
    });
  });
  await page.goto(`/t/${task.id}`);
  const section = page.getByRole("region", {
    name: "Work item comments",
    exact: true,
  });
  await expect(section.locator(".task-comment").first()).toHaveAttribute(
    "id",
    `comment-${newest.id}`,
  );
  const thread = section.locator(`[data-root-comment="${old.id}"]`);
  await expect(
    thread.locator(".comment-replies > .task-comment").first(),
  ).toHaveAttribute("id", `comment-${nested.id}`);
  await expect(
    thread
      .locator(`#comment-${nested.id} a`)
      .filter({ hasText: "original comment" }),
  ).toHaveAttribute("href", `/t/${task.id}#comment-${reply.id}`);
  await page
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Unsent top draft");
  await thread
    .locator(`#comment-${nested.id}`)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const composer = thread.getByRole("form", { name: "Reply composer" });
  await expect(composer).toBeVisible();
  expect(
    await thread.evaluate((el) => [...el.children].map((e) => e.className)),
  ).toEqual(["task-comment", "inline-reply-composer", "comment-replies"]);
  expect(
    await section.evaluate(
      (el) =>
        [...el.children].findIndex(
          (e) => e.className === "new-comment-composer",
        ) < [...el.children].findIndex((e) => e.className === "comment-thread"),
    ),
  ).toBe(true);
  await page
    .getByRole("textbox", { name: "Reply", exact: true })
    .fill("New flat reply");
  await composer
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    thread.locator(".comment-replies > .task-comment").first(),
  ).toContainText("New flat reply");
  expect(posted.parentCommentId).toBe(old.id);
  expect(posted.parentCommentVersion).toBe(old.version);
  await expect(
    page.getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveText("Unsent top draft");
  const stored = await request("GET", path);
  expect(
    stored.items.find((c: any) => c.id === nested.id).parentCommentId,
  ).toBe(reply.id);
});
