import { test, expect } from "@playwright/test";
import {
  fixture,
  begin,
  origin,
  clientId,
  redirectUri,
  formRequest,
} from "../mcp-fixtures.js";

for (const decision of ["approve", "deny"] as const) {
  test(`OAuth consent ${decision} submits the browser origin and returns to ChatGPT`, async ({
    page,
    context,
  }) => {
    // Stub the upstream identity provider; exercise the real consent HTML,
    // browser-generated headers/cookies, HTTP origin guard and OAuth broker.
    const f = fixture();
    const start = await begin(f);
    const [name, value] = start.cookie.split("=");
    await context.addCookies([
      {
        name,
        value,
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const response = await f.http(
        new Request(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          ...(request.postData() ? { body: request.postData() } : {}),
        }),
      );
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    await page.route(`${redirectUri}?**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "Returned to ChatGPT" }),
    );
    const callback = await page.goto(
      `${origin}/oauth/callback?${new URLSearchParams({ state: start.state, code: "upstream-code" })}`,
    );
    expect(callback!.status()).toBe(200);
    const submitted = page.waitForResponse(
      (response) => response.url() === `${origin}/oauth/consent`,
    );
    await page
      .getByRole("button", {
        name: decision === "approve" ? "Allow connection" : "Cancel",
        exact: true,
      })
      .click();
    const response = await submitted;
    const headers = await response.request().allHeaders();
    expect(headers.origin).toBe(origin);
    // Never disclose the upstream authorization code or state in Referer.
    expect(headers.referer).toBe(`${origin}/`);
    expect(response.status()).toBe(302);
    await expect(page).toHaveURL(new RegExp(`^${redirectUri}\\?`));
    const returned = new URL(page.url());
    expect(returned.searchParams.get("iss")).toBe(origin);
    expect(returned.searchParams.get("state")).toBe(start.query.state);
    expect((await context.cookies(origin)).some((c) => c.name === name)).toBe(
      false,
    );
    if (decision === "deny") {
      expect(returned.searchParams.get("error")).toBe("access_denied");
      expect(returned.searchParams.has("code")).toBe(false);
    } else {
      expect(returned.searchParams.has("error")).toBe(false);
      const token = await f.http(
        formRequest("/oauth/token", {
          client_id: clientId,
          resource: `${origin}/mcp`,
          grant_type: "authorization_code",
          code: returned.searchParams.get("code")!,
          code_verifier: start.verifier,
          redirect_uri: redirectUri,
        }),
      );
      expect(token.status).toBe(200);
      expect(
        await f.broker.authenticate((await token.json()).access_token),
      ).toBeDefined();
    }
  });
}
