// Sidebar names of discovered kinds (#96): readable, unique, and kept inside
// the sidebar: a long name wraps onto a second line, a longer one ends in an
// ellipsis, and the tooltip has the full name.

import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { openApp, showAllKinds } from "./helpers";

const LONG = "Extraordinarily Long Custom Resource Kind Names That Go On And On";

/** How the label of a sidebar button fits. */
function fit(button: Locator) {
  return button.evaluate((b) => {
    const label = b.querySelector(".label") as HTMLElement | null;
    const nav = b.closest("nav")!.getBoundingClientRect();
    const lineHeight = label ? parseFloat(getComputedStyle(label).lineHeight) : 0;
    return {
      inside: b.getBoundingClientRect().right <= nav.right,
      lines: label ? Math.round(label.clientHeight / lineHeight) : 0,
      clipped: label ? label.scrollHeight > label.clientHeight + 1 : false,
    };
  });
}

test("long kind names wrap inside the sidebar, longer ones end in an ellipsis", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.kinds.find((k) => k.id === "example.com/v1/widgets")!.label =
      "Extraordinarily Long Custom Resource Kind Names That Go On And On";
  });
  const nav = page.getByRole("navigation");
  await showAllKinds(page);
  await nav.evaluate((n) => n.querySelectorAll("details").forEach((d) => (d.open = true)));

  const bindings = nav.getByRole("button", { name: "Validating Admission Policy Bindings", exact: true });
  await expect(bindings).toBeVisible();
  await expect(bindings).toHaveAttribute(
    "title",
    "Validating Admission Policy Bindings: ValidatingAdmissionPolicyBinding (admissionregistration.k8s.io/v1)",
  );
  expect(await fit(bindings)).toEqual({ inside: true, lines: 2, clipped: false });

  const long = nav.getByRole("button", { name: LONG, exact: true });
  expect(await fit(long)).toEqual({ inside: true, lines: 2, clipped: true });
  await expect(long).toHaveAttribute("title", `${LONG}: Widget (example.com/v1)`);

  expect(await fit(nav.getByRole("button", { name: "Pods", exact: true }))).toEqual({
    inside: true,
    lines: 1,
    clipped: false,
  });
});

test("every kind in the sidebar has its own name", async ({ page }) => {
  await openApp(page);
  const nav = page.getByRole("navigation");
  await showAllKinds(page);
  await nav.evaluate((n) => n.querySelectorAll("details").forEach((d) => (d.open = true)));
  // Each kind once in its section; what is pinned is a copy at the top.
  const labels = await nav.locator("[data-group] button.kind .label").allTextContents();
  expect(labels.length).toBeGreaterThan(40);
  expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  for (const name of ["Component Statuses", "Node Metrics", "Pod Metrics", "CSI Storage Capacities"]) {
    await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
  }
});
