import { expect, test } from "@playwright/test";

const base = process.env["ALAS_E2E_BASE"];
if (!base) throw new Error("Set ALAS_E2E_BASE to an isolated server with a fake worker");

test("distinguishes pending, unavailable, empty, and stale dashboard data", async ({
  page,
  request,
}) => {
  const { instances } = await (await request.get(`${base}/api/v1/instances`)).json();
  const profile = `${base}/dashboard/#/${encodeURIComponent(instances[0].id)}`;
  let releaseTasks = () => {};
  const firstRequest = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });
  let taskResponse: "error" | "empty" | "ready" = "error";
  await page.emulateMedia({ colorScheme: "light" });
  await page.clock.install();
  await page.route("**/api/v1/instances/*/tasks", async (route) => {
    await firstRequest;
    await route.fulfill(
      taskResponse === "error"
        ? { status: 503 }
        : {
            json: {
              running: [],
              pending: taskResponse === "ready" ? [{ command: "Commission", nextRun: null }] : [],
              waiting: [],
            },
          },
    );
  });

  await page.goto(`${profile}/scheduler`);
  await expect(page.getByText("Loading task queue…")).toBeVisible();
  await expect(page.getByText("No pending tasks.")).toHaveCount(0);
  releaseTasks();
  await expect(page.getByText("Could not load task queue.")).toBeVisible();
  await expect(page.getByText("No pending tasks.")).toHaveCount(0);

  taskResponse = "empty";
  await page.getByRole("button", { name: "Retry task queue" }).click();
  await expect(page.getByText("No pending tasks.")).toBeVisible();

  taskResponse = "ready";
  await page.clock.fastForward(11_000);
  await expect(page.getByText("Commission", { exact: true })).toBeVisible();
  taskResponse = "error";
  await page.clock.fastForward(11_000);
  await expect(
    page.getByText("Showing stale task queue. The latest request failed."),
  ).toBeVisible();
  await expect(page.getByText("Commission", { exact: true })).toBeVisible();
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByText("Showing stale task queue. The latest request failed."),
  ).toBeVisible();

  let historyUnavailable = true;
  await page.route("**/api/v1/recovery", (route) =>
    historyUnavailable
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: {
            history: [],
            policy: { maxRestartsPerHour: 3, backoffSeconds: [15], instances: {} },
          },
        }),
  );
  await page.goto(`${profile}/health`);
  await expect(page.getByText("Could not load recovery history.")).toBeVisible();
  await expect(page.getByText("No recovery actions for this instance.")).toHaveCount(0);
  historyUnavailable = false;
  await page.getByRole("button", { name: "Retry recovery history" }).click();
  await expect(page.getByText("No recovery actions for this instance.")).toBeVisible();
});

test("opens nested views, restores route search, and shows invalid routes", async ({
  page,
  request,
}) => {
  const response = await request.get(`${base}/api/v1/instances`);
  expect(response.ok()).toBe(true);
  const { instances } = await response.json();
  expect(instances.length).toBeGreaterThan(0);
  const root = `${base}/dashboard/`;
  const profile = `${root}#/${encodeURIComponent(instances[0].id)}`;
  const links = page.getByRole("navigation", { name: "Profile views" });

  await page.goto(root);
  await expect(page).toHaveURL(`${profile}/overview`);
  await expect(links.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.goto(`${profile}/logs?filter=Scheduler&level=warn`);
  const filter = page.getByRole("textbox", { name: "Filter logs" });
  await expect(filter).toHaveValue("Scheduler");
  await filter.fill("Commission");
  await expect(page).toHaveURL(`${profile}/logs?filter=Commission&level=warn`);
  await links.getByRole("link", { name: "Health" }).click();
  await expect(page).toHaveURL(`${profile}/health`);
  await page.goBack();
  await expect(filter).toHaveValue("Commission");
  await page.reload();
  await expect(filter).toHaveValue("Commission");

  await page.goto(`${profile}/settings?q=Alas.Emulator.Serial`);
  await expect(page.getByRole("textbox", { name: "Search settings" })).toHaveValue(
    "Alas.Emulator.Serial",
  );
  await expect(page.getByRole("textbox", { name: /Alas\.Emulator\.Serial$/ })).toBeVisible();

  await page.goto(`${profile}/unknown`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New profile" })).toBeVisible();
  await page.goto(`${root}#/missing-${Date.now()}/overview`);
  await expect(page.getByRole("heading", { name: "Instance not found" })).toBeVisible();
});

test("edits a profile and reconnects to the same worker after closing the tab", async ({
  browser,
  request,
}) => {
  const name = `smoke-${Date.now()}`;
  const other = `${name}-other`;
  const otherProfile = await request.post(`${base}/api/v1/instances`, { data: { id: other } });
  expect(otherProfile.ok()).toBe(true);
  const context = await browser.newContext();
  const page = await context.newPage();
  let started = false;
  let releaseSave = () => {};
  let releaseStart = () => {};
  try {
    await page.goto(`${base}/dashboard/`);
    await page.getByRole("button", { name: "New profile" }).click();
    await page.getByLabel("Profile name").fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/${name}/settings$`));

    const editSerial = () => page.getByRole("textbox", { name: /Alas\.Emulator\.Serial$/ });
    const configUrl = `${base}/api/v1/instances/${name}/config`;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route(configUrl, async (route) => {
      if (route.request().method() === "PATCH") await saveGate;
      await route.continue();
    });
    await page.getByLabel("Search settings").fill("Alas.Emulator.Serial");
    await editSerial().fill("127.0.0.1:19999");
    await page.getByRole("button", { name: "Save (1)" }).click();
    await expect(editSerial()).toBeDisabled();
    await page.getByLabel("Search settings").fill("Alas.Emulator.ScreenshotMethod");
    await expect(
      page.getByRole("combobox", { name: /Alas\.Emulator\.ScreenshotMethod$/ }),
    ).toBeDisabled();
    releaseSave();
    await expect(page.getByText("Saved 1 setting(s)")).toBeVisible();

    await page.reload();
    await page.getByLabel("Search settings").fill("Alas.Emulator.Serial");
    await expect(editSerial()).toHaveValue("127.0.0.1:19999");
    await editSerial().fill("127.0.0.1:20000");
    const config = await (await request.get(configUrl)).json();
    const outsideEdit = await request.patch(configUrl, {
      headers: { "If-Match": `"${config.revision}"` },
      data: { changes: { "Alas.Emulator.Serial": "127.0.0.1:20001" } },
    });
    expect(outsideEdit.ok()).toBe(true);
    await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === "GET" && response.url() === configUrl,
      ),
      page.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))),
    ]);
    await expect(page.getByRole("button", { name: "Save (1)" })).toBeDisabled();
    await expect(editSerial()).toHaveValue("127.0.0.1:20000");
    await page.getByRole("button", { name: "Reload, discard my edits" }).click();
    await expect(editSerial()).toHaveValue("127.0.0.1:20001");
    const start = page.getByRole("button", { name: "Start", exact: true });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await page.route(`${base}/api/v1/instances/${name}/start`, async (route) => {
      await startGate;
      await route.continue();
    });
    await start.click();
    await page.goto(`${base}/dashboard/#/${other}/overview`);
    await expect(start).toBeEnabled();
    await page.goto(`${base}/dashboard/#/${name}/overview`);
    await expect(start).toBeDisabled();
    await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeDisabled();
    started = true;
    releaseStart();
    await page.getByRole("link", { name: "Logs", exact: true }).click();
    await expect(page.getByRole("region", { name: "Recent log lines" })).toContainText(
      "Smoke worker ready",
    );
    const statusUrl = `${base}/api/v1/instances/${name}`;
    const before = await (await request.get(statusUrl)).json();
    expect(before.processId).toBeGreaterThan(0);
    await context.close();

    const reopened = await browser.newPage();
    await reopened.goto(`${base}/dashboard/#/${name}/logs`);
    await expect(reopened.getByRole("region", { name: "Recent log lines" })).toContainText(
      "Smoke worker ready",
    );
    const after = await (await request.get(statusUrl)).json();
    expect(after.processId).toBe(before.processId);
    const details = await (await request.get(`${base}/api/v1/health/details`)).json();
    expect(details.metrics.taskSuccesses).toBeGreaterThan(0);
    await reopened.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(statusUrl)).json()).processId)
      .toBeNull();
    started = false;
    await reopened.close();
  } finally {
    releaseSave();
    releaseStart();
    if (started) await request.post(`${base}/api/v1/instances/${name}/stop`);
    await context.close();
  }
});
