// Admission policies sit under Config and the Dynamic Resource Allocation
// kinds under Device Resources (#332); kinds the cluster does not serve stay
// in their group, greyed out.

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, showAllKinds } from "./helpers";

/** The labels of the sidebar buttons under the heading `title`. */
function section(page: Page, title: string): Promise<string[]> {
  return page.getByRole("navigation").evaluate((nav, title) => {
    const out: string[] = [];
    let el = [...nav.querySelectorAll("h4")].find(
      (h) => h.textContent === title,
    )?.nextElementSibling;
    while (el && el.tagName !== "H4") {
      if (el.tagName === "BUTTON" && el.classList.contains("kind")) out.push(el.textContent!.trim());
      el = el.nextElementSibling;
    }
    return out;
  }, title);
}

const kindButton = (page: Page, name: string): Locator =>
  page.getByRole("navigation").getByRole("button", { name, exact: true });

test("admission policies are under Config, DRA kinds under Device Resources", async ({
  page,
}) => {
  await openApp(page);
  await showAllKinds(page);
  const config = await section(page, "Config");
  expect(config).toEqual(
    expect.arrayContaining([
      "Validating Webhook Configs",
      "Validating Admission Policies",
      "Validating Admission Policy Bindings",
      "Mutating Admission Policies",
    ]),
  );
  expect(await section(page, "Device Resources")).toEqual([
    "Device Classes",
    "Device Taint Rules",
    "Resource Claims",
    "Resource Claim Templates",
    "Resource Slices",
  ]);
  // None of them is left under Other.
  const other = await section(page, "Other");
  expect(
    other.some((l) => /Admission Polic|Device|Resource (Claim|Slice)/.test(l)),
  ).toBe(false);

  await kindButton(page, "Resource Claims").click();
  await expect(page.getByRole("columnheader", { name: "State" })).toBeVisible();
  await expect(kindButton(page, "Resource Claims")).toHaveClass(/active/);
});

test("kinds the cluster does not serve are greyed out in their group", async ({
  page,
}) => {
  await openApp(page, (cluster) => {
    cluster.kinds = cluster.kinds.filter(
      (k) =>
        k.resource.group !== "resource.k8s.io" &&
        k.resource.kind !== "ValidatingAdmissionPolicyBinding",
    );
  });
  await showAllKinds(page);
  expect(await section(page, "Device Resources")).toEqual([
    "Device Classes",
    "Resource Claims",
    "Resource Claim Templates",
    "Resource Slices",
  ]);
  const classes = kindButton(page, "Device Classes");
  await expect(classes).toHaveAttribute("aria-disabled", "true");
  await expect(classes).toHaveAttribute(
    "title",
    "Device Classes: this cluster does not serve DeviceClass (resource.k8s.io)",
  );
  const before = await page.locator("section.content").innerText();
  await classes.click({ force: true });
  await expect(classes).not.toHaveClass(/active/);
  expect(await page.locator("section.content").innerText()).toBe(before);

  const binding = kindButton(page, "Validating Admission Policy Bindings");
  await expect(binding).toHaveAttribute("aria-disabled", "true");
  await expect(
    kindButton(page, "Validating Admission Policies"),
  ).not.toHaveAttribute("aria-disabled", "true");
});
