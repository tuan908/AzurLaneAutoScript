import { expect, test } from "@playwright/test";

const base = process.env.ALAS_E2E_BASE;
if (!base) throw new Error("Set ALAS_E2E_BASE to an isolated server with a fake worker");

test("edits a profile and reconnects to the same worker after closing the tab", async ({ browser, request }) => {
  const name = `smoke-${Date.now()}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  let started = false;
  try {
    await page.goto(`${base}/dashboard/`);
    await page.getByRole("button", { name: "New profile" }).click();
    await page.getByLabel("Profile name").fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/${name}/settings$`));

    const editSerial = () => page.getByRole("textbox", { name: /Alas\.Emulator\.Serial$/ });
    await page.getByLabel("Search settings").fill("Alas.Emulator.Serial");
    await editSerial().fill("127.0.0.1:19999");
    await page.getByRole("button", { name: "Save (1)" }).click();
    await expect(page.getByText("Saved 1 setting(s)")).toBeVisible();

    await page.reload();
    await page.getByLabel("Search settings").fill("Alas.Emulator.Serial");
    await expect(editSerial()).toHaveValue("127.0.0.1:19999");
    await editSerial().fill("127.0.0.1:20000");
    const configUrl = `${base}/api/v1/instances/${name}/config`;
    const config = await (await request.get(configUrl)).json();
    const outsideEdit = await request.patch(configUrl, {
      headers: { "If-Match": `"${config.revision}"` },
      data: { changes: { "Alas.Emulator.Serial": "127.0.0.1:20001" } },
    });
    expect(outsideEdit.ok()).toBe(true);
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === "GET" && response.url() === configUrl),
      page.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))),
    ]);
    await page.getByRole("button", { name: "Save (1)" }).click();
    await page.getByRole("button", { name: "Reload, discard my edits" }).click();
    await expect(editSerial()).toHaveValue("127.0.0.1:20001");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    started = true;
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page.getByRole("region", { name: "Recent log lines" })).toContainText("Smoke worker ready");
    const statusUrl = `${base}/api/v1/instances/${name}`;
    const before = await (await request.get(statusUrl)).json();
    expect(before.processId).toBeGreaterThan(0);
    await context.close();

    const reopened = await browser.newPage();
    await reopened.goto(`${base}/dashboard/#/${name}/logs`);
    await expect(reopened.getByRole("region", { name: "Recent log lines" })).toContainText("Smoke worker ready");
    const after = await (await request.get(statusUrl)).json();
    expect(after.processId).toBe(before.processId);
    const details = await (await request.get(`${base}/api/v1/health/details`)).json();
    expect(details.metrics.taskSuccesses).toBeGreaterThan(0);
    await reopened.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await (await request.get(statusUrl)).json()).processId).toBeNull();
    started = false;
    await reopened.close();
  } finally {
    if (started) await request.post(`${base}/api/v1/instances/${name}/stop`);
    await context.close();
  }
});
