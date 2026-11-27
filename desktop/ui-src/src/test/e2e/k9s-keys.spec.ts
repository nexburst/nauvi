import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import { openApp, openKind, row } from "./helpers";

// Confirm dialogs from the keyboard, and the k9s keys (#575).

const grid = (page: Page) => page.getByRole("grid");
const dialog = (page: Page) => page.getByTestId("action-dialog");
const confirmButton = (page: Page) => page.getByTestId("action-confirm");
const protectedConfirm = (page: Page) => page.getByTestId("protected-confirm");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const help = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const panel = (page: Page) => page.getByTestId("detail-panel");

const withK9sKeys = (cluster: FakeCluster) => {
  cluster.settings.k9s_keys = true;
};

// `openApp` serializes these, so each spells its mode out.
const protectedDev = (cluster: FakeCluster) => {
  cluster.settings.contexts["kind-dev"] = {
    view: "",
    namespaces: [],
    typed_namespaces: [],
    prometheus: "",
    display_name: "",
    color: "",
    default_namespace: "",
    shell_cwd: "",
    last_used: 0,
    hide_metrics: false,
    mode: "protected",
    mode_source: { file: "", given: "", context: "" },
  };
};

const readOnlyDev = (cluster: FakeCluster) => {
  cluster.settings.contexts["kind-dev"] = {
    view: "",
    namespaces: [],
    typed_namespaces: [],
    prometheus: "",
    display_name: "",
    color: "",
    default_namespace: "",
    shell_cwd: "",
    last_used: 0,
    hide_metrics: false,
    mode: "readOnly",
    mode_source: { file: "", given: "", context: "" },
  };
};

/** j, Space, j, Space: the first two rows selected from the keyboard. */
async function selectTwo(page: Page) {
  await openKind(page, "Pods");
  await expect(row(page, "crashed")).toBeVisible();
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("2 selected");
}

test("j Space j Space Ctrl+D Enter deletes both pods; the confirm button has the focus", async ({ page }) => {
  const fake = await openApp(page);
  await selectTwo(page);
  await page.keyboard.press("Control+d");
  await expect(dialog(page)).toHaveAccessibleName("Delete 2 Pods");
  await expect(confirmButton(page)).toBeFocused();
  // It shows the focus ring, though the dialog (not a Tab) focused it.
  await expect(confirmButton(page)).not.toHaveCSS("outline-style", "none");

  // Tab and the arrows stay between Cancel and Delete.
  await page.keyboard.press("Tab");
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmButton(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(confirmButton(page)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("ArrowRight");

  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  const call = await fake.lastCall("cmdBulkDelete");
  expect((call.items as { name: string }[]).map((i) => i.name)).toEqual(["crashed", "db-0"]);
  await expect(page.getByRole("status")).toContainText("Deleted 2 pods");
  // The keyboard is back on the table.
  await expect(grid(page)).toBeFocused();
});

test("Escape cancels the dialog Ctrl+D opened; Enter on Cancel cancels too", async ({ page }) => {
  const fake = await openApp(page);
  await selectTwo(page);
  await page.keyboard.press("Control+d");
  await expect(confirmButton(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  await page.keyboard.press("Control+d");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
  expect(await fake.calls("cmdRunAction")).toEqual([]);
});

test("a delete from a menu focuses the confirm button too", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Delete" }).click();
  await expect(confirmButton(page)).toBeFocused();
  // A dialog with a field starts on it.
  await page.keyboard.press("Escape");
  await row(page, "web").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Scale…" }).click();
  await expect(page.getByTestId("action-replicas")).toBeFocused();
});

test("on a protected cluster the same keys stop at the type-the-name field", async ({ page }) => {
  const fake = await openApp(page, protectedDev);
  await selectTwo(page);
  await page.keyboard.press("Control+d");
  await expect(confirmButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  const input = protectedConfirm(page).getByTestId("protected-confirm-input");
  await expect(input).toBeFocused();
  // Enter again (and again) changes nothing.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(protectedConfirm(page)).toBeVisible();
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
  // Tab stays in the prompt, and Enter on its Cancel cancels.
  await page.keyboard.press("Tab");
  await expect(protectedConfirm(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(protectedConfirm(page)).toHaveCount(0);
  await expect(dialog(page)).toContainText("Cancelled: nothing was changed");
  // Back on the action dialog's confirm button.
  await expect(confirmButton(page)).toBeFocused();
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
});

test("a read-only cluster refuses Ctrl+D with the reason, as Delete", async ({ page }) => {
  await openApp(page, readOnlyDev);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("Control+d");
  await expect(page.getByRole("alert")).toContainText("kind-dev is read-only");
  await expect(dialog(page)).toHaveCount(0);
});

test("Ctrl+K kills a pod with the k9s keys on; otherwise it opens the palette", async ({ page }) => {
  const fake = await openApp(page, withK9sKeys);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toHaveAccessibleName("Force delete Pod");
  // A force delete asks for the name: its field has the focus.
  const field = dialog(page).getByRole("textbox");
  await expect(field).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await fake.calls("cmdRunAction")).toEqual([]);
  await page.keyboard.type("crashed");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.lastCall("cmdRunAction")).toMatchObject({ name: "crashed", action: "forceDelete" });
  // Ctrl+P is the palette there.
  await page.keyboard.press("Control+p");
  await expect(palette(page)).toBeVisible();
});

test("without the k9s keys Ctrl+K stays the palette and Shift+L does nothing", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("Shift+L");
  await expect(page.getByTestId("dock").getByRole("tab")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});

test("Shift+L opens the pod's previous logs with the k9s keys on", async ({ page }) => {
  const fake = await openApp(page, withK9sKeys);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("Shift+L");
  await expect(page.getByTestId("dock").getByRole("tab", { name: "Logs: crashed" })).toBeVisible();
  await expect.poll(async () => (await fake.calls("cmdStreamPodLogs")).at(-1)?.previous).toBe(true);
});

test("Shift+N sorts by name, again the other way", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  const header = (title: string) => page.locator(`[role="columnheader"][title="${title}"]`);
  const name = header("Name");
  await page.keyboard.press("Shift+N");
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await page.keyboard.press("Shift+N");
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await page.keyboard.press("Shift+A");
  await expect(header("Age")).toHaveAttribute("aria-sort", "ascending");
  await expect(name).toHaveAttribute("aria-sort", "none");
});

test("d opens the details, : goes to a kind, Ctrl+Space marks a range and Ctrl+\\ clears it", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("d");
  await expect(panel(page).locator(".title")).toHaveText("demo/crashed");
  await page.keyboard.press("Escape");

  await grid(page).focus();
  await page.keyboard.press(" ");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("Control+Space");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("3 selected");
  await page.keyboard.press("Control+\\");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toHaveCount(0);

  await page.keyboard.press(":");
  await expect(palette(page).getByRole("combobox")).toHaveValue(":");
  await page.keyboard.type("deploy");
  await expect(palette(page).getByRole("option").first()).toContainText("Deployments");
  await page.keyboard.press("Enter");
  await expect(grid(page)).toHaveAccessibleName("Deployments");
});

test("o opens the pod's node and Shift+J its owner", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("o");
  await expect(panel(page).locator(".title")).toContainText("node-");
  await page.keyboard.press("Escape");
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("Shift+J");
  await expect(panel(page).locator(".title")).toContainText("web-");
});

test("none of the new keys fire in the filter", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  const filter = page.getByRole("searchbox", { name: "Filter" });
  await filter.focus();
  for (const key of ["d", "o", "r", "Shift+N", "Shift+J", "Shift+F", ":", "Control+d", "Control+Space"]) {
    await page.keyboard.press(key);
  }
  await expect(filter).toHaveValue("dorNJF:");
  await expect(dialog(page)).toHaveCount(0);
  await expect(palette(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
});

test("? lists the new keys, and the k9s ones while they are on", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("?");
  await expect(help(page)).toContainText("Ctrl+D");
  await expect(help(page)).toContainText("Sort by CPU, memory, name, age or status");
  await expect(help(page)).not.toContainText("Kill: force delete");
  await expect(help(page).getByTestId("k9s-keys-note")).toContainText("k9s keys are off");

  // Settings → Keyboard turns them on.
  await help(page).getByRole("button", { name: "Settings → Keyboard" }).click();
  const box = page.getByTestId("k9s-keys");
  await expect(box).toBeVisible();
  await box.check();
  await page.keyboard.press("Escape");
  await grid(page).focus();
  await page.keyboard.press("?");
  await expect(help(page)).toContainText("Kill: force delete");
  await expect(help(page)).toContainText("Logs of the pod's previous run");
  await expect(help(page).locator("kbd").first()).toHaveText("Ctrl+P");
});

// #580: the follow-ups of #579.

test(": opens the palette from the table, not from a button outside it", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const pods = page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true });
  await pods.focus();
  await page.keyboard.press(":");
  await expect(palette(page)).toHaveCount(0);
  // Ctrl+K opens the palette from anywhere.
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toHaveCount(0);
  await grid(page).focus();
  await page.keyboard.press(":");
  await expect(palette(page).getByRole("combobox")).toHaveValue(":");
});

test("no global key acts behind a protected cluster's confirmation", async ({ page }) => {
  const fake = await openApp(page, protectedDev);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const aside = page.locator("aside");
  await aside.getByLabel("Pod port").fill("8080");
  await aside.getByLabel("Local port").fill("18080");
  await aside.getByRole("button", { name: "Forward", exact: true }).click();
  // A port-forward asks with no action dialog behind the prompt.
  await expect(protectedConfirm(page)).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press("Tab");
  const cancel = protectedConfirm(page).getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  for (const key of ["?", ":", "Control+k", "Control+,"]) await page.keyboard.press(key);
  await expect(help(page)).toHaveCount(0);
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(cancel).toBeFocused();
  expect(await fake.calls("cmdPortforwardStart")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(protectedConfirm(page)).toHaveCount(0);
});

test("at 1280x800 no key in ? runs into its description", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, withK9sKeys);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("?");
  await expect(help(page)).toContainText("New local terminal");
  const overlaps = await help(page).evaluate((el) => {
    const out: string[] = [];
    for (const dt of el.querySelectorAll("dt")) {
      const dd = dt.nextElementSibling as HTMLElement;
      const left = dd.getBoundingClientRect().left;
      for (const k of dt.querySelectorAll("kbd, .or")) {
        if (k.getBoundingClientRect().right > left + 0.5) out.push(`${k.textContent} / ${dd.textContent}`);
      }
    }
    return out;
  });
  expect(overlaps).toEqual([]);
});

test("at 1280x800 the force delete's Type … to confirm is one line", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, withK9sKeys);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toHaveAccessibleName("Force delete Pod");
  const label = dialog(page).locator("label.field > span").first();
  await expect(label).toHaveText("Type crashed to confirm");
  const box = await label.boundingBox();
  const input = await dialog(page).getByRole("textbox").boundingBox();
  // One line of 13px text, above the field.
  expect(box!.height).toBeLessThan(24);
  expect(box!.y + box!.height).toBeLessThanOrEqual(input!.y);
});
