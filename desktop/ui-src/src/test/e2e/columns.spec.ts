import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row } from "./helpers";

// Columns (#547): the Image column, custom columns, and the chooser's
// order, search, reset, and the header's right-click menu.

// Its name, and the sort arrow when the table is sorted by it.
const header = (page: Page, label: string) =>
  page.getByRole("columnheader", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( [▲▼])?$`) });
const chooser = (page: Page) => page.getByRole("dialog", { name: "Columns" });
const openChooser = (page: Page) => page.getByRole("button", { name: /^Columns/ }).click();
const filter = (page: Page) => page.getByRole("searchbox", { name: "Filter" });
const headers = async (page: Page) =>
  (await page.locator(".table .head .th").allTextContents()).map((h) => h.replace(/[▲▼]/g, "").trim()).filter(Boolean);

async function restart(page: Page) {
  await page.reload();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
}

test("the Image column is off by default, shows the first image and lists them all on hover", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(header(page, "Status")).toBeVisible();
  await expect(header(page, "Image")).toHaveCount(0);

  await openChooser(page);
  const image = chooser(page).getByRole("checkbox", { name: "Image", exact: true });
  await expect(image).not.toBeChecked();
  await image.check();
  await page.keyboard.press("Escape");
  await expect(header(page, "Image")).toBeVisible();
  expect(await column(page, "Image")).toContain("mongo:7.0.1");
  const cell = row(page, "web-1").getByRole("gridcell", { name: "web:1.4.2 +1", exact: true });
  await expect(cell).toHaveAttribute("title", /^web:1\.4\.2 \+1\nghcr\.io\/shop\/web:1\.4\.2@sha256:3f3f.*\ndocker\.io\/envoyproxy\/envoy:v1\.31\.0/s);

  // It sorts, and the filter finds what it shows.
  await header(page, "Image").click();
  expect((await column(page, "Image"))[0]).toBe("busybox:latest");
  await filter(page).fill("mongo");
  await expect(row(page, "db-0")).toBeVisible();
  await expect(row(page, "web-1")).toHaveCount(0);
  await filter(page).fill("");

  // Workloads have it too, off by default.
  await openKind(page, "Deployments");
  await expect(header(page, "Image")).toHaveCount(0);
  await openChooser(page);
  await chooser(page).getByRole("checkbox", { name: "Image", exact: true }).check();
  await page.keyboard.press("Escape");
  expect(await column(page, "Image")).toContain("web:1.4.2 +1");
  // No new request for it: one watch per table, as before.
  expect((await fake.lastCall("cmdWatchStart")).custom).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("a custom column from a label, an annotation or a field path, renamed, removed, kept over a restart", async ({
  page,
}) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await openChooser(page);
  await chooser(page).getByRole("button", { name: "+ Add column…" }).click();

  const name = chooser(page).getByRole("textbox", { name: "Name" });
  const from = chooser(page).getByRole("combobox", { name: "From" });
  // A wrong path says why, in plain words, and adds nothing.
  await name.fill("Pod IP");
  await from.selectOption({ label: "Field path" });
  await chooser(page).getByRole("textbox", { name: "Path" }).fill("status.podIP");
  await expect(chooser(page).getByText("A field path starts with a dot, for example .status.podIP.")).toBeVisible();
  await chooser(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(chooser(page).getByRole("textbox", { name: "Path" })).toHaveAttribute("aria-invalid", "true");
  await chooser(page).getByRole("textbox", { name: "Path" }).fill(".status.podIP");
  await expect(chooser(page).locator("#column-draft-error")).toHaveText("");
  await chooser(page).getByRole("button", { name: "Add", exact: true }).click();

  // Then one from a label.
  await chooser(page).getByRole("button", { name: "+ Add column…" }).click();
  await name.fill("Version");
  await chooser(page).getByRole("textbox", { name: "Key" }).fill("app.kubernetes.io/version");
  await chooser(page).getByRole("button", { name: "Add", exact: true }).click();
  // A name the table has is refused.
  await chooser(page).getByRole("button", { name: "+ Add column…" }).click();
  await name.fill("Status");
  await chooser(page).getByRole("textbox", { name: "Key" }).fill("app");
  await chooser(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(chooser(page).getByText('The table already has a column named "Status".')).toBeVisible();
  await chooser(page).getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");

  await expect(header(page, "Pod IP")).toBeVisible();
  await expect(header(page, "Version")).toBeVisible();
  // The rows' cells come from the one watch the table has, which reads them.
  const start = await fake.lastCall("cmdWatchStart");
  expect((start.custom as { value: string }[]).map((c) => c.value)).toEqual([".status.podIP", "app.kubernetes.io/version"]);
  expect(await column(page, "Version")).toContain("7.0.1");
  expect(await column(page, "Pod IP")).toContain("10.244.0.5");
  // Sorted and filtered like any other.
  await header(page, "Version").click();
  await header(page, "Version").click();
  expect((await column(page, "Version"))[0]).toBe("7.0.1");
  await filter(page).fill("7.0.1");
  await expect(row(page, "db-0")).toBeVisible();
  await expect(row(page, "web-1")).toHaveCount(0);
  await filter(page).fill("");
  await expect(header(page, "Version")).toHaveAttribute(
    "title",
    "Version (Label: app.kubernetes.io/version)",
  );

  await restart(page);
  await expect(header(page, "Pod IP")).toBeVisible();
  expect(await column(page, "Version")).toContain("1.4.2");

  // Renamed: the same values, no new watch.
  const watches = (await fake.calls("cmdWatchStart")).length;
  await openChooser(page);
  await chooser(page).getByRole("button", { name: "Edit column Version" }).click();
  await name.fill("App version");
  await chooser(page).getByRole("button", { name: "Save" }).click();
  await expect(header(page, "App version")).toBeVisible();
  expect(await column(page, "App version")).toContain("1.4.2");
  expect((await fake.calls("cmdWatchStart")).length).toBe(watches);

  // Removed.
  await chooser(page).getByRole("button", { name: "Remove column Pod IP" }).click();
  await expect(header(page, "Pod IP")).toHaveCount(0);
  await restart(page);
  await expect(header(page, "App version")).toBeVisible();
  await expect(header(page, "Pod IP")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("columns move with Alt+arrows or by dragging, the order is kept, and Reset to default undoes it", async ({
  page,
}) => {
  await openApp(page);
  await openKind(page, "Pods");
  const before = await headers(page);
  expect(before.slice(0, 4)).toEqual(["Name", "Namespace", "Ready", "Status"]);

  await openChooser(page);
  await expect(chooser(page).getByRole("button", { name: "Reset to default" })).toHaveCount(0);
  const status = chooser(page).getByRole("checkbox", { name: "Status", exact: true });
  await status.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  // Focus stays on it, and screen readers hear where it is.
  await expect(status).toBeFocused();
  await expect(chooser(page).locator("[aria-live]")).toHaveText("Status: position 2 of 9");
  expect((await headers(page)).slice(0, 4)).toEqual(["Name", "Status", "Namespace", "Ready"]);

  // Drag Node by its handle above Ready.
  const item = (label: string) => chooser(page)
      .locator("li")
      .filter({ has: page.getByRole("checkbox", { name: label, exact: true }) });
  const handle = item("Node").getByTestId("column-handle");
  const target = await item("Ready").boundingBox();
  const from = await handle.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 20, target!.y + 2, { steps: 5 });
  await page.mouse.up();
  expect((await headers(page)).slice(0, 5)).toEqual(["Name", "Status", "Namespace", "Node", "Ready"]);

  await page.keyboard.press("Escape");
  await restart(page);
  expect((await headers(page)).slice(0, 5)).toEqual(["Name", "Status", "Namespace", "Node", "Ready"]);

  await openChooser(page);
  await chooser(page).getByRole("button", { name: "Reset to default" }).click();
  expect(await headers(page)).toEqual(before);
  await expect(chooser(page).getByRole("button", { name: "Reset to default" })).toHaveCount(0);
});

test("a header's right-click menu hides it or opens the chooser, and the chooser can be searched", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await header(page, "Node").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Node");
  await menu.getByRole("menuitem", { name: "Hide this column" }).click();
  await expect(header(page, "Node")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Columns (1 hidden)" })).toBeVisible();

  // Name is always shown.
  await header(page, "Name").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: /Hide this column/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Columns…" }).click();
  await expect(chooser(page)).toBeVisible();

  const find = chooser(page).getByRole("searchbox", { name: "Find a column" });
  await expect(find).toBeFocused();
  await find.fill("qo");
  await expect(chooser(page).getByRole("checkbox")).toHaveCount(1);
  await expect(chooser(page).getByRole("checkbox", { name: "QoS", exact: true })).toBeVisible();
  await find.fill("nothing like it");
  await expect(chooser(page).getByText("No column matches “nothing like it”.")).toBeVisible();
});

test("a bad custom column in the settings says why instead of an empty table", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.kinds["v1/pods"] = {
      sort_key: "",
      sort_desc: false,
      hidden: [],
      shown: [],
      widths: {},
      order: [],
      custom: [{ id: "c1", label: "Broken", source: "field", value: "status", context: "" }],
    };
  });
  await openKind(page, "Pods");
  await expect(page.getByText(/Column "Broken": A field path starts with a dot/).first()).toBeVisible();
});

const SECRET_REFUSED = "A column on Secrets cannot show their data: open the Secret and press Reveal to see it.";

test("a custom column on Secrets cannot show their data (#571)", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Secrets");
  await openChooser(page);
  await chooser(page).getByRole("button", { name: "+ Add column…" }).click();
  const name = chooser(page).getByRole("textbox", { name: "Name" });
  const from = chooser(page).getByRole("combobox", { name: "From" });
  const error = chooser(page).locator("#column-draft-error");
  const add = chooser(page).getByRole("button", { name: "Add", exact: true });
  await name.fill("Password");
  await from.selectOption({ label: "Field path" });
  const path = chooser(page).getByRole("textbox", { name: "Path" });
  for (const p of [".data.password", ".Data", ".stringData.token"]) {
    await path.fill(p);
    await expect(error).toHaveText(SECRET_REFUSED);
  }
  await add.click();
  await expect(path).toHaveAttribute("aria-invalid", "true");
  // The last-applied annotation holds the whole Secret.
  await from.selectOption({ label: "Annotation" });
  const key = chooser(page).getByRole("textbox", { name: "Key" });
  await key.fill("kubectl.kubernetes.io/last-applied-configuration");
  await expect(error).toHaveText(SECRET_REFUSED);
  await add.click();
  // Nothing was added or saved.
  await expect(chooser(page).getByRole("button", { name: "Edit column Password" })).toHaveCount(0);
  expect((await fake.lastCall("cmdWatchStart")).custom).toEqual([]);

  // The Secret's type is fine.
  await from.selectOption({ label: "Field path" });
  await name.fill("Kind of secret");
  await path.fill(".type");
  await expect(error).toHaveText("");
  await add.click();
  await page.keyboard.press("Escape");
  await expect(header(page, "Kind of secret")).toBeVisible();

  // The same path on a ConfigMap is fine too.
  await openKind(page, "Config Maps");
  await openChooser(page);
  await chooser(page).getByRole("button", { name: "+ Add column…" }).click();
  await name.fill("Value");
  await from.selectOption({ label: "Field path" });
  await path.fill(".data.x");
  await expect(error).toHaveText("");
  expect(fake.errors).toEqual([]);
});

test("a custom column on Secrets saved before #571 says why instead of their data", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.kinds["v1/secrets"] = {
      sort_key: "",
      sort_desc: false,
      hidden: [],
      shown: [],
      widths: {},
      order: [],
      custom: [{ id: "c1", label: "Password", source: "field", value: ".data.password", context: "" }],
    };
  });
  await openKind(page, "Secrets");
  await expect(page.getByText(`Column "Password": ${SECRET_REFUSED}`).first()).toBeVisible();
});
