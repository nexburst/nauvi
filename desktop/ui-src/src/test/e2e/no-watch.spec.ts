// Kinds without the watch verb (#95): the backend lists them now and then
// instead, and the header says the table is not live.

import { expect, test } from "@playwright/test";
import { column, openApp, rows } from "./helpers";

test("a kind that cannot be watched lists its objects and says it is not live", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.denied = cluster.denied.filter((id) => id !== "v1/componentstatuses");
    const kind = cluster.kinds.find((k) => k.id === "v1/componentstatuses")!;
    kind.label = "Component Statuses";
    cluster.rows["v1/componentstatuses"] = ["controller-manager", "etcd-0", "scheduler"].map((name) => ({
      key: name,
      name,
      namespace: "",
      created: Math.floor(Date.now() / 1000) - 86400,
      cells: [name, ""],
      status: "",
      problem: "",
    }));
  });
  const nav = page.getByRole("navigation");
  await nav.locator("details", { has: page.locator("summary", { hasText: /^core$/ }) }).locator("summary").click();
  await nav.getByRole("button", { name: "Component Statuses", exact: true }).click();

  await expect(rows(page)).toHaveCount(3);
  expect(await column(page, "Name")).toEqual(["controller-manager", "etcd-0", "scheduler"]);
  await expect(page.getByTestId("connection-status")).toHaveText("Not live: refreshed every 30 s");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // A later list that changed something arrives as an ordinary batch.
  await fake.emitWatchBatch({ deleted: ["etcd-0"] });
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId("connection-status")).toHaveText("Not live: refreshed every 30 s");
  expect(fake.errors).toEqual([]);
});

test("a watched kind still says Live", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live");
});
