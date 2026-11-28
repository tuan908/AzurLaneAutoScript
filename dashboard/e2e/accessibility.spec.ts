import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";

import { instanceFixture } from "../src/api/test-fixtures";

const origin = "http://dashboard.test";
const settingsPath = "/api/v1/instances/alas/config";
const fields = Array.from({ length: 12 }, (_, index) => ({
  path: `Sample.Parameters.Value${index}`,
  label: `Value ${index}`,
  type: "input",
  readOnly: false,
  default: "original",
  help: "",
}));

async function mockDashboard(page: Page, api: (route: Route) => Promise<void> | undefined) {
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/dashboard/")) {
      const file = path === "/dashboard/" ? "index.html" : path.slice("/dashboard/".length);
      await route.fulfill({ path: fileURLToPath(new URL(`../dist/${file}`, import.meta.url)) });
      return;
    }
    if (path === "/api/v1/events") {
      await route.fulfill({
        contentType: "text/event-stream",
        body: 'event: resync\ndata: {"streamId":"accessibility-test"}\n\n',
      });
      return;
    }
    const response = api(route);
    if (response) await response;
    else if (path === "/api/v1/instances") {
      await route.fulfill({ json: { instances: [instanceFixture()] } });
    } else if (path.endsWith("/logs")) {
      await route.fulfill({ json: { lines: [], lastSeq: 0 } });
    } else {
      await route.fulfill({ status: 404, json: {} });
    }
  });
}

test("keeps settings actions in the layout and identifies invalid fields after Save", async ({
  page,
}) => {
  let rejected = false;
  await page.setViewportSize({ width: 320, height: 568 });
  await mockDashboard(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === settingsPath && route.request().method() === "PATCH") {
      if (rejected) {
        return route.fulfill({
          json: { revision: "abcdef0123456789", applied: { "Sample.Parameters.Value0": "10" } },
        });
      }
      rejected = true;
      return route.fulfill({
        status: 400,
        json: {
          error: { code: "invalid_value", message: "Invalid settings" },
          fields: { "Sample.Parameters.Value0": "Enter at least 10" },
        },
      });
    }
    if (path === settingsPath) {
      return route.fulfill({
        json: {
          revision: "0123456789abcdef",
          config: { Sample: { Parameters: { Value0: "original" } } },
        },
      });
    }
    if (path === `${settingsPath}/schema`) {
      return route.fulfill({
        json: {
          lang: "en",
          menus: [
            {
              id: "general",
              name: "General",
              tasks: [
                {
                  id: "Sample",
                  name: "Sample",
                  help: "",
                  groups: [{ id: "Parameters", name: "Parameters", help: "", fields }],
                },
              ],
            },
          ],
        },
      });
    }
    return undefined;
  });

  await page.goto(`${origin}/dashboard/#/alas/settings`);
  const input = page.getByRole("textbox", { name: /^Value 0 / });
  await input.fill("1");
  const actions = page.getByRole("region", { name: "Unsaved changes" });
  await expect(actions).toHaveCSS("position", "static");
  await actions.getByRole("button", { name: "Save (1)", exact: true }).click();

  const summary = actions.locator("[tabindex='-1']");
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Sample.Parameters.Value0: Enter at least 10");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAccessibleDescription("Enter at least 10");
  await input.fill("10");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await actions.getByRole("button", { name: "Save (1)", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved 1 setting(s)" })).toHaveCount(1);
});

test("explains a rejected password and allows a successful retry", async ({ page }) => {
  await mockDashboard(page, (route) => {
    if (new URL(route.request().url()).pathname !== "/api/v1/instances") return;
    if (route.request().headers()["authorization"] === "Bearer mock-correct-password") {
      return route.fulfill({ json: { instances: [] } });
    }
    return route.fulfill({
      status: 401,
      json: { error: { code: "unauthorized", message: "Password required" } },
    });
  });

  await page.goto(`${origin}/dashboard/`);
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await password.fill("mock-rejected-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("#password-error")).toContainText("The server rejected this password.");
  await expect(password).toBeFocused();
  await expect(password).toHaveAccessibleDescription(/The server rejected this password/);

  await password.fill("mock-correct-password");
  await password.press("Enter");
  await expect(page.getByRole("heading", { name: "No instances yet" })).toBeVisible();
});

test("skips the dashboard chrome and shows keyboard focus in the command palette", async ({
  page,
}) => {
  await mockDashboard(page, () => undefined);
  const url = `${origin}/dashboard/#/alas/logs`;
  await page.goto(url);
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(page.getByRole("navigation", { name: "Profile views" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page).toHaveURL(url);

  const trigger = page.getByRole("button", { name: /Search…/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", { name: "Search commands" });
  await expect(search).toBeFocused();
  await expect(search.locator("..")).toHaveCSS("outline-width", "2px");
  await expect(search.locator("..")).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("announces live connection and recovery changes without announcing each countdown tick", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const fetchFromServer = window.fetch;
    let failed = false;
    window.fetch = (input, init) => {
      if (input !== "/api/v1/events") return fetchFromServer(input, init);
      if (!failed) {
        failed = true;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('event: resync\ndata: {"streamId":"test"}\n\n'),
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      );
    };
  });
  const crashed = instanceFixture({
    state: "failed",
    health: {
      state: "crashed",
      detail: "Worker exited",
      recovery: {
        gaveUp: false,
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        pendingReason: "crash",
        policy: { autoRestart: true, restartOnStall: false, stallMinutes: 10 },
        restartsLastHour: 0,
      },
    },
  });
  await mockDashboard(page, (route) =>
    new URL(route.request().url()).pathname === "/api/v1/instances"
      ? route.fulfill({ json: { instances: [crashed] } })
      : undefined,
  );
  await page.goto(`${origin}/dashboard/#/alas/logs`);
  const status = page.getByRole("status");
  await expect(status.filter({ hasText: "Live updates interrupted." })).toHaveCount(1);
  await expect(status.filter({ hasText: "Live updates connected." })).toHaveCount(1);
  const countdown = page
    .getByText("Crashed — restarting automatically", { exact: true })
    .locator("..");
  await expect(countdown).toContainText("Next attempt in ");
  const before = await countdown.textContent();
  await expect(countdown).not.toHaveText(before ?? "");
  await expect(status.filter({ hasText: "Automatic recovery is scheduled." })).toHaveCount(1);
  await expect(status.filter({ hasText: "Next attempt" })).toHaveCount(0);
});

test("keeps status and log text at 4.5 to 1 contrast in both themes", async ({ page }) => {
  await mockDashboard(page, () => undefined);
  await page.goto(`${origin}/dashboard/#/alas/logs`);
  await expect(page.getByRole("main")).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const contrast = await page.evaluate(() => {
      const colors = getComputedStyle(document.documentElement);
      const luminance = (hex: string) => {
        const channels = hex.slice(1).match(/../g) ?? [];
        const linear = channels.map((channel) => {
          const value = Number.parseInt(channel, 16) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
      };
      return [
        ["--muted", "--bg"],
        ["--muted", "--surface-3"],
        ["--ok", "--ok-soft"],
        ["--warn", "--warn-soft"],
        ["--bad", "--bad-soft"],
        ["--idle", "--idle-soft"],
        ["--term-dim", "#121620"],
        ["--term-dim", "--term-bg"],
      ].map(([foreground, background]) => {
        const a = luminance(colors.getPropertyValue(foreground!).trim());
        const b = luminance(
          background!.startsWith("#") ? background! : colors.getPropertyValue(background!).trim(),
        );
        return { foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    });
    for (const { foreground, background, ratio } of contrast) {
      expect(ratio, `${colorScheme} ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
