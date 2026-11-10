import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { WorkItem } from "../../src/shared/model.js";
import { fixture, admin } from "../mcp-fixtures.js";

test("native Markdown edits, formatted descriptions/comments, and arbitrary historical comparisons", async ({
  page,
}) => {
  const f = fixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    version?: number,
  ) => {
    const r = await f.service.handle({
      method,
      path: `/api/v1${path}`,
      principal: admin,
      userName: "Erick Brown",
      agentName: "Writer",
      body,
      headers: {
        "idempotency-key": randomUUID(),
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
    expect(r.status).toBeLessThan(300);
    return r.body;
  };
  await request("POST", "/projects", {
    slug: "MD",
    name: "Markdown workspace",
  });
  const source =
    "# Native Markdown\n\nA **strong** word and *emphasis*.\n\n- One\n- Two\n\n| Name | Value |\n| --- | --- |\n| Markdown | Yes |\n\n    indented code\n\nA hard break  \nnext line\n\n[Link](https://example.com)\n\n<script>window.markdownExecuted=true</script>\n";
  const items: WorkItem[] = [];
  for (const kind of ["Initiative", "Epic", "Task"])
    items.push(
      await request("POST", "/projects/MD/items", {
        kind,
        title: `${kind} Markdown`,
        description: source,
        parentId: items.at(-1)?.id,
      }),
    );
  const doc = await request("POST", "/projects/MD/docs/User", {
    title: "Revision guide",
    content: source,
  });
  const docPath = `/projects/MD/docs/User/${doc.id}`;
  for (let version = 2; version <= 20; version++)
    await request(
      "PATCH",
      docPath,
      {
        title: `Guide ${version}`,
        content: `# Heading ${version}\n\nCommon text\n\nVersion **${version}**\n`,
      },
      version - 1,
    );
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const r = await f.service.handle({
      method: req.method(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers(),
      body: req.postData() ? req.postDataJSON() : undefined,
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
  await page.getByRole("button", { name: "Planning", exact: true }).click();
  for (const item of items) {
    if (item.kind === "Task")
      await page
        .getByRole("button", { name: new RegExp(`${item.id}.*Task Markdown`) })
        .click();
    else
      await page
        .locator("summary")
        .filter({ hasText: item.title })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
    const description = page.getByRole("region", {
      name: "Work item description",
    });
    await expect(
      description.getByRole("heading", { name: "Native Markdown" }),
    ).toBeVisible();
    await expect(description.locator("strong")).toHaveText("strong");
    await expect(description.getByRole("table")).toBeVisible();
    await expect(description.locator("script")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit description", exact: true })
      .click();
    const editor = page.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    await expect(editor).toContainText("# Native Markdown");
    await expect(
      editor.locator("span").filter({ hasText: "Native Markdown" }),
    ).toHaveCSS("color", "rgb(7, 93, 121)");
    await page
      .getByRole("button", { name: "Preview description", exact: true })
      .click();
    await expect(
      description.getByRole("heading", { name: "Native Markdown" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Edit description", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect(
      (await request("GET", `/projects/MD/items/${item.id}`)).description,
    ).toBe(source);
    if (item.kind === "Task")
      await page
        .getByRole("button", { name: new RegExp(`${item.id}.*Task Markdown`) })
        .click();
    else
      await page
        .locator("summary")
        .filter({ hasText: item.title })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("## Comment heading\n\nA **bold** update.");
    await page
      .getByRole("button", { name: "Preview comment", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Comment heading" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    const comment = page.locator(".task-comment");
    await expect(
      comment.getByRole("heading", { name: "Comment heading" }),
    ).toBeVisible();
    await comment
      .getByRole("button", { name: "Edit comment", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Edit comment", exact: true })
      .fill("## Edited comment\n\n- Updated");
    await page
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect(
      comment.getByRole("heading", { name: "Edited comment" }),
    ).toBeVisible();
    await comment
      .getByRole("button", { name: "Comment history", exact: true })
      .click();
    await comment
      .locator("summary")
      .filter({ hasText: /^Revision 1/ })
      .click();
    await expect(
      comment.getByRole("heading", { name: "Comment heading" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
  }
  await page
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await page.getByRole("button", { name: "Guide 20", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await page.getByLabel("Revision", { exact: true }).selectOption("1");
  await expect(
    dialog.getByRole("heading", { name: "Native Markdown" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show Markdown source" }).click();
  await expect(dialog.locator(".markdown-source")).toHaveText(source);
  await page.getByRole("button", { name: "Compare revisions" }).click();
  await page.getByLabel("From revision", { exact: true }).selectOption("3");
  await page.getByLabel("To revision", { exact: true }).selectOption("20");
  await expect(dialog.locator(".diff-removed").last()).toContainText(
    "Version **3**",
  );
  await expect(dialog.locator(".diff-added").last()).toContainText(
    "Version **20**",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/markdown-history-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await expect(dialog).toHaveJSProperty(
    "scrollWidth",
    await dialog.evaluate((e) => e.clientWidth),
  );
  await page.screenshot({
    path: "test-results/markdown-history-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "View history", exact: true }).click();
  await page.getByLabel("Revision", { exact: true }).selectOption("3");
  await expect(
    dialog.getByRole("heading", { name: "Guide 3", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Page content", exact: true }),
  ).toContainText("# Heading 3");
  await page.screenshot({
    path: "test-results/markdown-editor-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  const restored = await request("GET", docPath);
  expect(restored.version).toBe(21);
  expect(restored.content).toBe(
    "# Heading 3\n\nCommon text\n\nVersion **3**\n",
  );
  expect((await request("GET", `${docPath}/revisions/20`)).content).toContain(
    "# Heading 20",
  );
  expect(
    await page.evaluate(() => (window as any).markdownExecuted),
  ).toBeUndefined();
  expect(errors).toEqual([]);
});
