import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";

async function setup(page: Page, readOnly = false) {
  const f = fixture();
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await f.service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal: admin,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(r.status).toBeLessThan(300);
    return r.body as any;
  };
  for (const slug of ["ONE", "TWO"])
    await call("POST", "/projects", { slug, name: slug });
  const initiative = await call("POST", "/projects/ONE/items", {
    kind: "Initiative",
    title: "Initiative",
  });
  const epic = await call("POST", "/projects/ONE/items", {
    kind: "Epic",
    title: "Epic",
    parentId: initiative.id,
  });
  const task = await call("POST", "/projects/ONE/items", {
    kind: "Task",
    title: "Task",
    parentId: epic.id,
    description: Array.from(
      { length: 50 },
      (_, i) => `Paragraph ${i}. Long description.`,
    ).join("\n\n"),
  });
  await call("POST", `/projects/ONE/items/${task.id}/comments`, {
    content: "Existing comment",
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
    if (readOnly && url.pathname === "/api/v1/projects") {
      for (const item of (r.body as any).items) item.role = "User";
    }
    await route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: r.status === 204 ? undefined : JSON.stringify(r.body),
    });
  });
  return { task, epic, initiative, call };
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`${theme} ${width}: readable controls and state accessible beside comment entry`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 850 });
      const { task, call } = await setup(page);
      await page.goto("/");
      await page.getByRole("button", { name: "Project", exact: true }).click();
      const options = page.locator(".project-options");
      await expect(options).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(27, 37, 32)" : "rgb(255, 255, 255)",
      );
      await options.getByRole("button", { name: "ONE", exact: false }).click();
      await page.goto(`/t/${task.id}`);
      const comment = page.getByRole("textbox", {
        name: "Comment",
        exact: true,
      });
      await comment.fill("Draft comment");
      await comment.scrollIntoViewIfNeeded();
      const state = page.getByLabel("State", { exact: true });
      await expect(state).toBeInViewport();
      await expect(
        page.locator(".markdown-editor .cm-editor").last(),
      ).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(32, 44, 38)" : "rgb(250, 251, 248)",
      );
      await expect(comment).toHaveCSS(
        "color",
        theme === "dark" ? "rgb(225, 234, 228)" : "rgb(38, 52, 47)",
      );
      const box = await page.getByRole("dialog").boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `test-results/ui-${theme}-${width}.png` });
      await state.selectOption("Implement");
      await page
        .locator(".dialog-title")
        .getByRole("button", { name: "Save changes" })
        .click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      expect((await call("GET", `/projects/ONE/items/${task.id}`)).state).toBe(
        "Implement",
      );
    });
  }
}

test("project switching preserves each available navigation section", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  for (const section of [
    "Planning",
    "Documentation",
    "Members",
    "Activity",
    "Board",
  ]) {
    await page
      .locator("nav")
      .getByRole("button", { name: section, exact: false })
      .click();
    for (const project of ["TWO", "ONE"]) {
      await page.getByRole("button", { name: "Project", exact: true }).click();
      await page
        .locator("#project-options")
        .getByRole("button", { name: project, exact: false })
        .click();
      await expect(page.locator("nav .active")).toContainText(section);
      await expect(
        page.getByRole("button", { name: "Project", exact: true }),
      ).toContainText(project);
    }
  }
});

test("derived states remain descriptive and User cannot edit task state", async ({
  page,
}) => {
  const { task, epic, initiative } = await setup(page, true);
  for (const item of [epic, initiative]) {
    await page.goto(`/t/${item.id}`);
    await expect(page.locator(".dialog-title")).toContainText(
      "derived from descendant Tasks",
    );
    await expect(page.getByLabel("State", { exact: true })).toHaveCount(0);
  }
  await page.goto(`/t/${task.id}`);
  await expect(page.getByLabel("State", { exact: true })).toBeDisabled();
  await expect(
    page.locator(".dialog-title").getByRole("button", { name: "Save changes" }),
  ).toHaveCount(0);
});
