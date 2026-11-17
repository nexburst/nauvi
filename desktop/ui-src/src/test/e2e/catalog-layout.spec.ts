import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// #179: the cluster catalog at 1280x800 with an unreachable context: server
// URLs on one line, paths wrapped only between folders, the long status
// message clamped, and the row actions in one line (Open, Check, More).

const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="catalog-row"][data-context="${id}"]`);
const LONG_FILE = "/Users/pedrosanchezmartinez/.kube/nauvi-kind.yaml";
// One folder name wider than the Source column.
const DEAD_FILE = "/tmp/nauvi-qa-area5-catalog-Z95d7V-with-a-much-longer-folder-name/clusters/dead.yaml";

async function openCatalog(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page, (cluster) => {
    cluster.contexts = [
      { name: "kind-nauvi-test", current: true, namespace: null, server: "https://127.0.0.1:45613", file: "/Users/pedrosanchezmartinez/.kube/nauvi-kind.yaml" },
      { name: "dead", current: false, namespace: null, server: "https://127.0.0.1:1", file: "/tmp/nauvi-qa-area5-catalog-Z95d7V-with-a-much-longer-folder-name/clusters/dead.yaml", source: "/tmp/nauvi-qa-area5-catalog-Z95d7V-with-a-much-longer-folder-name/clusters/dead.yaml" },
    ];
    cluster.catalog.checks["dead"] = {
      name: "dead",
      state: "unreachable",
      message:
        "Could not reach the cluster at https://127.0.0.1:1: error trying to connect: tcp connect error: Connection refused (os error 111). Check that the API server is running and that the address and port in the kubeconfig are right.",
      version: "",
    };
  });
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(catalogRow(page, "dead").getByTestId("catalog-status")).toContainText("Unreachable");
  return fake;
}

/** How many lines the text of the row's `testid` element takes. */
function lines(page: Page, id: string, testid: string) {
  return catalogRow(page, id)
    .getByTestId(testid)
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      return tops.size;
    });
}

test("server URLs stay on one line, with the full URL in the tooltip", async ({ page }) => {
  await openCatalog(page);
  for (const id of ["kind-nauvi-test", "dead"]) {
    expect(await lines(page, id, "catalog-server"), `${id}'s server on one line`).toBe(1);
  }
  await expect(catalogRow(page, "kind-nauvi-test").getByTestId("catalog-server")).toHaveAttribute(
    "title",
    "https://127.0.0.1:45613",
  );
  await expect(catalogRow(page, "dead").getByTestId("catalog-server")).toHaveText("https://127.0.0.1:1");
  // Not cut: the whole URL fits.
  const cut = await catalogRow(page, "kind-nauvi-test")
    .getByTestId("catalog-server")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(cut).toBe(false);
  await expect(catalogRow(page, "dead").getByTestId("catalog-user")).toHaveText("dead-admin");
  // A long name stays beside its colour swatch, level with the rest of the row.
  for (const id of ["kind-nauvi-test", "dead"]) {
    const name = await catalogRow(page, id).getByTestId("catalog-name").boundingBox();
    const status = await catalogRow(page, id).getByTestId("catalog-status").locator("span").first().boundingBox();
    expect(Math.abs(name!.y - status!.y), `${id}'s name on the row's first line`).toBeLessThan(4);
  }
});

test("source paths wrap only after a slash", async ({ page }) => {
  await openCatalog(page);
  const file = catalogRow(page, "kind-nauvi-test").getByTestId("catalog-file");
  await expect(file).toContainText(LONG_FILE);
  // Each line of the wrapped path ends with a "/" (except the last).
  const rows = await file.locator(".source").evaluate((el) => {
    const byTop = new Map<number, string>();
    for (const span of el.querySelectorAll("span")) {
      const top = Math.round(span.getBoundingClientRect().top);
      byTop.set(top, (byTop.get(top) ?? "") + span.textContent);
      if (span.getClientRects().length > 1) return null; // a part split over lines
    }
    return [...byTop.values()];
  });
  expect(rows, "no folder name split over two lines").not.toBeNull();
  expect(rows!.join("")).toBe(LONG_FILE);
  for (const line of rows!.slice(0, -1)) expect(line.endsWith("/")).toBe(true);

  // A folder name wider than the column wraps inside the column, not cut.
  const dead = catalogRow(page, "dead").getByTestId("catalog-file");
  await expect(dead).toContainText(DEAD_FILE);
  expect(await dead.evaluate((td) => td.scrollWidth <= td.clientWidth)).toBe(true);
});

test("the status message is clamped to two lines, the row actions fit in one line", async ({ page }) => {
  await openCatalog(page);
  const why = catalogRow(page, "dead").getByTestId("catalog-status-message");
  await expect(why).toHaveAttribute("title", /Connection refused/);
  const box = await why.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(2 * 18);

  for (const id of ["kind-nauvi-test", "dead"]) {
    const buttons = catalogRow(page, id).locator(".actions button");
    await expect(buttons).toHaveText(["Open", "⋯"]);
    const tops = await buttons.evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
    expect(tops, `${id}'s actions in one line`).toBe(1);
    const row = await catalogRow(page, id).boundingBox();
    // Was ~240 px with five stacked buttons; dead has a 4-line path.
    expect(row!.height, `${id}'s row stays short`).toBeLessThan(120);
  }
  for (const name of ["Open dead", "More actions for dead"]) {
    await expect(catalogRow(page, "dead").getByRole("button", { name, exact: true })).toBeInViewport({
      ratio: 1,
    });
  }
  // The table fits the window: no horizontal scroll.
  const overflow = await page.getByTestId("catalog").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("More actions offers New window, Check, Settings and Remove", async ({ page }) => {
  const fake = await openCatalog(page);
  const more = catalogRow(page, "dead").getByRole("button", { name: "More actions for dead" });
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    "Open in new window",
    "Check connection",
    "Settings…",
    "Remove source…",
  ]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Focus goes back to the ⋯ button, even where a click does not focus it (WebKit on macOS).
  await expect(more).toBeFocused();

  // The current context's file is the default kubeconfig: nothing to remove.
  await catalogRow(page, "kind-nauvi-test").getByRole("button", { name: "More actions for kind-nauvi-test" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    "Open in new window",
    "Check connection",
    "Settings…",
  ]);
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await expect(page.getByRole("dialog", { name: "Cluster settings" })).toBeVisible();
  expect(fake.errors).toEqual([]);
});
