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
    .getByLabel("Page content")
    .fill(
      "# Welcome\n\nA shared home for **docs and tasks**.\n\n- Start with an initiative\n- Break it into epics\n- Make progress with tasks",
    );
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Getting started", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await page
    .getByLabel("Page content")
    .fill("# Updated guide\n\nYour second revision.");
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Updated guide" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Page content")).toHaveValue(/# Welcome/);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Updated guide" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Page content")).toHaveValue(/# Welcome/);

  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await page.getByLabel("Identity").fill("cognito:teammate");
  await page
    .getByRole("button", { name: "Add member", exact: true })
    .last()
    .click();
  await expect(
    page.locator(".member-list").getByText("cognito:teammate", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
