// The row's ⋮ menu and the cells that act as links (#382). The ⋮ opens the
// very menu a right-click opens (same items, same RBAC and read-only greying);
// Namespace, Node and Controlled By cells lead to what they name.
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { namespaceButton, openApp, openKind, row, rows } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

const menu = (page: Page) => page.getByRole("menu");
const more = (page: Page, name: string) => row(page, name).getByTestId("row-menu");
const detail = (page: Page) => page.getByTestId("detail-panel");
const nav = (page: Page) => page.getByRole("navigation").locator("button.active");

/** Every item of the open menu: label, whether offered, and why not. */
async function items(m: Locator) {
  return m.getByRole("menuitem").evaluateAll((els) =>
    els.map((e) => ({
      label: e.textContent?.trim(),
      disabled: (e as HTMLButtonElement).disabled,
      title: e.getAttribute("title"),
    })),
  );
}

// Init functions run in the page as source text: no captured variables.
const denied = (cluster: FakeCluster) => {
  cluster.deniedActions = {
    shell: "Not allowed: you can't create pods/exec in namespace demo",
    delete: "Not allowed: you can't delete pods in namespace demo",
  };
};

test("⋮ opens the right-click menu, greyed the same, without opening the row", async ({ page }) => {
  const fake = await openApp(page, denied);
  await openKind(page, "Pods");

  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page).getByTestId("menu-reason")).toHaveCount(2);
  const byRightClick = await items(menu(page));
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  await expect(more(page, "web-1")).toHaveAccessibleName("Actions for web-1");
  await more(page, "web-1").click();
  await expect(menu(page).getByTestId("menu-reason")).toHaveCount(2);
  expect(await items(menu(page))).toEqual(byRightClick);
  // The menu is under the button, and names the object.
  const button = (await more(page, "web-1").boundingBox())!;
  const box = (await menu(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height - 1);
  await expect(menu(page)).toContainText("demo/web-1");
  // Neither opens the detail nor selects the row.
  await expect(detail(page)).toHaveCount(0);
  await expect(row(page, "web-1")).not.toHaveClass(/selected/);

  // An item runs as from the right-click menu.
  await menu(page).getByRole("menuitem", { name: "Logs" }).click();
  await expect(page.getByTestId("dock")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a read-only context greys the ⋮ menu like the right-click one", async ({ page }) => {
  await openApp(page, (cluster) => {
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
  });
  await openKind(page, "Pods");
  await more(page, "web-1").click();
  const del = menu(page).getByRole("menuitem", { name: "Delete", exact: true });
  await expect(del).toBeDisabled();
  await expect(del).toHaveAttribute("title", "kind-dev is read-only: changes to this cluster are turned off");
  await expect(menu(page).getByRole("menuitem", { name: "Logs" })).toBeEnabled();
});

test("the keyboard opens the same menu under the row's ⋮", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const grid = page.getByRole("grid");
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  const first = await rows(page).first().getByTestId("row-menu").boundingBox();
  const box = (await menu(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(first!.y + first!.height - 1);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(grid).toBeFocused();
});

test("a namespace cell shows the same kind in that namespace", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(5);
  const link = row(page, "coredns-1").getByTestId("namespace-link");
  await expect(link).toHaveAccessibleName("Show Pods in namespace kube-system");
  await expect(link).toHaveAttribute("title", "Show Pods in namespace kube-system");
  // Hidden until the row is hovered: the table stays calm.
  await page.mouse.move(0, 0);
  await expect(link).toHaveCSS("opacity", "0");

  // A click on the namespace text opens the row, as anywhere in the row.
  await row(page, "web-1").locator(".linked-text", { hasText: "demo" }).click();
  await expect(detail(page)).toContainText("web-1");
  await expect(namespaceButton(page)).toContainText("All namespaces");
  await page.keyboard.press("Escape");
  await expect(detail(page)).toHaveCount(0);

  // A middle click on the link does nothing.
  await row(page, "coredns-1").hover();
  await expect(link).toHaveCSS("opacity", "1");
  await link.click({ button: "middle" });
  await expect(rows(page)).toHaveCount(5);
  await expect(namespaceButton(page)).toContainText("All namespaces");

  await link.click();
  await expect(namespaceButton(page)).toContainText("kube-system");
  await expect(rows(page)).toHaveCount(1);
  await expect(nav(page)).toHaveAccessibleName("Pods");
  await expect(detail(page)).toHaveCount(0);
});

test("a Ctrl/Cmd-click on a namespace link does what a click does, and selects nothing", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  const link = row(page, "web").getByTestId("namespace-link");
  await link.click({ modifiers: ["ControlOrMeta"] });
  await expect(namespaceButton(page)).toContainText("demo");
  await expect(nav(page)).toHaveAccessibleName("Deployments");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toHaveCount(0);
  await expect(detail(page)).toHaveCount(0);
});

test("a Node cell opens the node's detail", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  const link = row(page, "crashed").getByTestId("node-link");
  await expect(link).toHaveAttribute("title", "Open node node-2");
  await row(page, "crashed").hover();
  await link.click();
  await expect(nav(page)).toHaveAccessibleName("Nodes");
  await expect(detail(page)).toContainText("node-2");
  await expect(row(page, "node-2")).toHaveClass(/selected/);
  // Back returns to the pods.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(nav(page)).toHaveAccessibleName("Pods");
  expect(fake.errors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`the Pods table with its ⋮ column at 1280x800 (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await openKind(page, "Pods");
    // The ⋮ stays at the table's right edge, whole, even where the columns
    // scroll sideways (and after scrolling them).
    const scroller = page.locator(".table .scroller");
    const inside = () =>
      more(page, "web-1").evaluate((btn) => {
        const b = btn.getBoundingClientRect();
        const edge = btn.closest(".scroller")!.getBoundingClientRect().right;
        // Whole, and on top at both ends: not under a cell or cut off.
        const hit = (x: number) => document.elementFromPoint(x, b.top + b.height / 2)?.closest('[data-testid="row-menu"]') === btn;
        return b.right <= edge && hit(b.left + 2) && hit(b.right - 2);
      });
    expect(await inside()).toBe(true);
    await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    expect(await inside()).toBe(true);
    await scroller.evaluate((el) => (el.scrollLeft = 0));
    await row(page, "web-2").getByTestId("node-link").hover();
    await page.screenshot({ path: test.info().outputPath(`row-menu-${theme}.png`) });
  });
}
