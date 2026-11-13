import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "../mcp-fixtures.js";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: document history stays in the pane and archives leave the tree`, async ({
    page,
  }) => {
    const f = fixture();
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      version?: number,
    ) => {
      const r = await f.service.handle({
        method,
        path: `/api/v1${path}`,
        principal: admin,
        body,
        headers: {
          "idempotency-key": randomUUID(),
          ...(version ? { "if-match": `"${version}"` } : {}),
        },
      });
      expect(r.status).toBeLessThan(300);
      return r.body as any;
    };
    await call("POST", "/projects", { slug: "DOC", name: "Documents" });
    const doc = await call("POST", "/projects/DOC/docs/User", {
      title: "Guide",
      content: "Original text",
    });
    await call(
      "PATCH",
      `/projects/DOC/docs/User/${doc.id}`,
      { content: "Current text" },
      1,
    );
    const archive = await call("POST", "/projects/DOC/docs/User", {
      title: "Source revision archive 1 of 1",
      content: "# Historical Confluence evidence\n\nRetained source payload",
      parentId: doc.id,
    });
    await call("POST", "/projects/DOC/docs/User", {
      title: "Ordinary child",
      content: "Child",
      parentId: archive.id,
    });
    const other = await call("POST", "/projects/DOC/docs/User", {
      title: "Other guide",
      content: "Other text",
    });
    let readOnly = false;
    let failRevision = false,
      failList = false,
      hold: Promise<void> | undefined,
      release: (() => void) | undefined;
    await page.route("**/api/v1/**", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.pathname.endsWith("/revisions/1")) {
        if (hold) await hold;
        if (failRevision)
          return route.fulfill({
            status: 500,
            json: { error: "Revision temporarily unavailable" },
          });
      }
      if (failList && url.pathname.endsWith("/revisions"))
        return route.fulfill({
          status: 500,
          json: { error: "History temporarily unavailable" },
        });
      const r = await f.service.handle({
        method: req.method(),
        path: url.pathname,
        principal: admin,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers(),
        body: req.postData() ? req.postDataJSON() : undefined,
      });
      if (readOnly && url.pathname === "/api/v1/projects")
        for (const membership of (r.body as any).items)
          membership.role = "User";
      await route.fulfill({ status: r.status, json: r.body });
    });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/d/user-${doc.id}`);
    const picker = page.getByRole("combobox", { name: "Document history" });
    await expect(picker.locator("option")).toHaveCount(3);
    await expect(page.locator(".doc-nav")).not.toContainText(
      "Source revision archive",
    );
    await expect(page.locator(".doc-nav")).toContainText("Ordinary child");
    await picker.selectOption("1");
    await expect(page.locator("article.document")).toContainText(
      "Original text",
    );
    await expect(
      page.getByRole("button", { name: "Edit page", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: "Public", exact: true }),
    ).toBeDisabled();
    await picker.selectOption("current");
    await expect(page.locator("article.document")).toContainText(
      "Current text",
    );
    await expect(
      page.getByRole("button", { name: "Edit page", exact: true }),
    ).toBeEnabled();
    await picker.selectOption("1");
    await expect(page.locator("article.document")).toContainText(
      "Original text",
    );
    await page
      .locator(".doc-nav")
      .getByRole("button", { name: "Guide", exact: true })
      .click();
    await expect(picker).toHaveValue("current");
    await expect(page.locator("article.document")).toContainText(
      "Current text",
    );
    await picker.selectOption(`archive:${archive.id}`);
    await expect(page).toHaveURL(`/d/user-${archive.id}`);
    await expect(page.locator("article.document")).toContainText(
      "Retained source payload",
    );
    await expect(page.locator(".doc-nav .selected")).toContainText("Guide");
    await page.reload();
    await expect(picker).toHaveValue(`archive:${archive.id}`);
    await picker.selectOption("owner");
    await expect(page).toHaveURL(`/d/user-${doc.id}`);
    await expect(picker).toHaveValue("current");
    await page.goBack();
    await expect(picker).toHaveValue(`archive:${archive.id}`);
    await page.goForward();
    await expect(picker).toHaveValue("current");
    failRevision = true;
    await picker.selectOption("1");
    await expect(page.getByRole("alert")).toContainText(
      "Revision temporarily unavailable",
    );
    failRevision = false;
    await page.getByRole("button", { name: "Reload revision" }).click();
    await expect(page.locator("article.document")).toContainText(
      "Original text",
    );
    await picker.selectOption("current");
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await picker.selectOption("1");
    await expect(page.getByRole("status")).toContainText("Loading revision");
    await page
      .locator(".doc-nav")
      .getByRole("button", { name: "Other guide", exact: true })
      .click();
    await expect(page).toHaveURL(`/d/user-${other.id}`);
    release!();
    hold = undefined;
    await expect(page.locator("article.document")).toContainText("Other text");
    await expect(page.locator("article.document")).not.toContainText(
      "Original text",
    );
    failList = true;
    await page
      .locator(".doc-nav")
      .getByRole("button", { name: "Guide", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("History unavailable");
    failList = false;
    await page.getByRole("button", { name: "Retry history" }).click();
    await expect(picker.locator("option")).toHaveCount(3);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(picker).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `/tmp/dnt-document-history-${theme}-${width}.png`,
        fullPage: true,
      });
    }
    expect(
      (await call("GET", `/projects/DOC/docs/User/${archive.id}`)).content,
    ).toContain("Retained source payload");
    readOnly = true;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Edit page", exact: true }),
    ).toBeDisabled();
    await picker.selectOption("1");
    await expect(page.locator("article.document")).toContainText(
      "Original text",
    );
    await picker.selectOption("current");
    await expect(
      page.getByRole("button", { name: "Edit page", exact: true }),
    ).toBeDisabled();
  });
}
