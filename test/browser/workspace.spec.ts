import { test, expect } from "@playwright/test";
test("a team can create a project, plan work, move tasks, and revise documentation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const slug = `QA${Date.now().toString(36).toUpperCase()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Platform foundations");
  await page.getByLabel("Project key").fill(slug);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Work board" })).toBeVisible();
  await page
    .getByRole("button", { name: "New work item", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Build a shared workspace");
  await page
    .getByRole("button", { name: "Create work item", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "New work item", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Deliver the first release");
  await page
    .getByRole("button", { name: "Create work item", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const [title, state] of [
    ["Capture the product vision", "Concept"],
    ["Wire up project permissions", "Implement"],
    ["Confirm the Cognito client", "Needs Attention"],
    ["Check the API contract", "Review"],
    ["Define the project model", "Done"],
  ] as const) {
    await page
      .getByRole("button", { name: "New work item", exact: true })
      .click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page
      .getByRole("combobox", { name: "State", exact: true })
      .selectOption(state);
    await page
      .getByRole("button", { name: "Create work item", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await page
    .getByRole("button", { name: new RegExp("Wire up project permissions") })
    .click();
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("Review");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .locator(".column.review")
      .getByRole("heading", { name: "Wire up project permissions" }),
  ).toBeVisible();
  const draggable = page.getByRole("button", {
    name: /Wire up project permissions/,
  });
  await draggable.hover();
  const source = (await draggable.boundingBox())!;
  const destination = (await page.locator(".column.implement").boundingBox())!;
  await page.mouse.move(source.x + 20, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(source.x + 40, source.y + 20, { steps: 5 });
  await page.mouse.move(destination.x + 30, destination.y + 80, { steps: 15 });
  await page.mouse.up();
  await expect(
    page
      .locator(".column.implement")
      .getByRole("heading", { name: "Wire up project permissions" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/board-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Work board" })).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/board-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "New page", exact: true })
    .first()
    .click();
  await page.getByLabel("Page title").fill("Getting started");
  await page
    .getByRole("textbox", { name: "Page content", exact: true })
    .fill(
      "# Welcome\n\nA shared home for **docs and tasks**.\n\n- Start with an initiative\n- Break it into epics\n- Make progress with tasks",
    );
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Getting started", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Page content", exact: true })
    .fill("# Updated guide\n\nYour second revision.");
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Updated guide" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByLabel("Revision", { exact: true })).toHaveValue("2");
  await page.getByLabel("Revision", { exact: true }).selectOption("1");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Welcome", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Page content", exact: true }),
  ).toContainText("# Welcome");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Updated guide" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByLabel("Revision", { exact: true }).selectOption("1");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Welcome", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Page content", exact: true }),
  ).toContainText("# Welcome");

  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await page.getByLabel("Find Cognito users by email").fill("teammate");
  await page.getByRole("button", { name: "Find users", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Teammate · teammate@example.com",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Identity")).toHaveValue("cognito:teammate");
  await page
    .getByRole("button", { name: "Add member", exact: true })
    .last()
    .click();
  await expect(
    page.locator(".member-list").getByText("cognito:teammate", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synchronization: ready", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View User group users" }).click();
  await expect(
    page.locator(".group-grid").getByText("Teammate", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Role for cognito:teammate").selectOption("Maintainer");
  await expect(page.getByLabel("Role for cognito:teammate")).toHaveValue(
    "Maintainer",
  );
  await expect(
    page.getByText("Synchronization: ready", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View Maintainer group users" })
    .click();
  await expect(
    page.locator(".group-grid").getByText("Teammate", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Remove cognito:teammate").click();
  await expect(page.getByLabel("Role for cognito:teammate")).toHaveCount(0);
  const deleteButton = page.getByRole("button", { name: /^Delete [A-Z0-9]+$/ });
  expect((await deleteButton.innerText()).slice(7)).toBe(slug);
  page.once("dialog", (dialog) => dialog.accept(slug));
  await deleteButton.click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Synchronization: deleted", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByText("Deleted projects", { exact: true }).click();
  await page.getByRole("button", { name: `Check ${slug} deletion` }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Synchronization: deleted", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
