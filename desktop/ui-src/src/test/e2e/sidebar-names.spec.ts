// Sidebar names of discovered kinds (#96): readable, unique, and cut off
// with an ellipsis (the full name in the tooltip) when they do not fit.

import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test("long kind names end in an ellipsis inside the sidebar and show in full in the tooltip", async ({ page }) => {
  await openApp(page);
  const nav = page.getByRole("navigation");
  await nav.evaluate((n) => n.querySelectorAll("details").forEach((d) => (d.open = true)));

  const button = nav.getByRole("button", { name: "Validating Admission Policy Bindings", exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute(
    "title",
    "Validating Admission Policy Bindings: ValidatingAdmissionPolicyBinding (admissionregistration.k8s.io/v1)",
  );
  const fit = await button.evaluate((b) => {
    const label = b.querySelector(".label") as HTMLElement | null;
    const nav = b.closest("nav")!.getBoundingClientRect();
    return {
      ellipsis: label ? getComputedStyle(label).textOverflow : "",
      cut: label ? label.scrollWidth > label.clientWidth : false,
      inside: b.getBoundingClientRect().right <= nav.right,
    };
  });
  expect(fit).toEqual({ ellipsis: "ellipsis", cut: true, inside: true });
});

test("every kind in the sidebar has its own name", async ({ page }) => {
  await openApp(page);
  const nav = page.getByRole("navigation");
  await nav.evaluate((n) => n.querySelectorAll("details").forEach((d) => (d.open = true)));
  const labels = await nav.locator("button.kind .label").allTextContents();
  expect(labels.length).toBeGreaterThan(40);
  expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  for (const name of ["Component Statuses", "Node Metrics", "Pod Metrics", "CSI Storage Capacities"]) {
    await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
  }
});
