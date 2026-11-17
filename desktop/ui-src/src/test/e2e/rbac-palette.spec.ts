// The command palette and the keyboard Delete follow RBAC too (#349): the
// same access check as the row menu (rbac-actions.spec.ts), with the same
// "Not allowed: …" text, and a read-only context's reason first (#338).
// (The `openApp` init functions are serialized: their strings are inline.)
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const palette = (page: Page) =>
  page.getByRole("dialog", { name: "Command palette" });
const option = (page: Page, name: string) =>
  palette(page).getByRole("option").filter({ hasText: name });
const dialog = (page: Page) => page.getByRole("alertdialog");
const notice = (page: Page) => page.locator(".notice");

const NO_SHELL = "Not allowed: you can't create pods/exec in namespace demo";
const NO_DELETE = "Not allowed: you can't delete pods in namespace demo";
const NO_DELETE_KS =
  "Not allowed: you can't delete pods in namespace kube-system";
const READ_ONLY =
  "kind-dev is read-only: changes to this cluster are turned off";

/** Focus the first row (`crashed`, in demo) and open the palette on its actions. */
async function paletteActions(page: Page) {
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">");
  await expect(palette(page)).toBeVisible();
}

test("the palette greys out the actions RBAC refuses, and picking one does nothing", async ({
  page,
}) => {
  const fake = await openApp(page, (cluster) => {
    cluster.deniedActions = {
      shell: "Not allowed: you can't create pods/exec in namespace demo",
      delete: "Not allowed: you can't delete pods in namespace demo",
    };
  });
  await openKind(page, "Pods");
  await paletteActions(page);

  const shell = option(page, "Shell");
  await expect(shell).toHaveAttribute("aria-disabled", "true");
  await expect(shell).toHaveAccessibleDescription(NO_SHELL);
  await expect(shell).toHaveAttribute("title", NO_SHELL);
  const del = palette(page)
    .getByRole("option")
    .filter({ has: page.getByText("Delete", { exact: true }) });
  await expect(del).toHaveAttribute("aria-disabled", "true");
  await expect(del.getByTestId("palette-reason")).toHaveText(NO_DELETE);
  // The rest is offered.
  await expect(option(page, "Logs")).not.toHaveAttribute("aria-disabled");
  await expect(option(page, "Force delete…")).not.toHaveAttribute(
    "aria-disabled",
  );
  await expect(option(page, "Evict")).not.toHaveAttribute("aria-disabled");
  expect((await fake.lastCall("cmdCheckActions"))?.namespace).toBe("demo");

  // Clicking or Enter on a refused one runs nothing and keeps the palette open.
  await page.keyboard.type("delete");
  const first = palette(page).getByRole("option").first();
  await expect(first).toHaveAttribute("aria-disabled", "true");
  await first.click({ force: true });
  // The search keeps the focus.
  await expect(palette(page).getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdRunAction")).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("palette-denied.png") });

  // An allowed one still runs.
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(">evict");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAccessibleName("Evict Pod");
});

test("the palette's bulk delete is refused when one namespace of the selection refuses it", async ({
  page,
}) => {
  await openApp(page, (cluster) => {
    cluster.deniedActions = {
      "kube-system/delete":
        "Not allowed: you can't delete pods in namespace kube-system",
    };
  });
  await openKind(page, "Pods");
  await row(page, "web-1").getByRole("checkbox").check();
  await row(page, "coredns-1").getByRole("checkbox").check();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">delete");
  const del = option(page, "Delete 2 selected…");
  await expect(del).toHaveAttribute("aria-disabled", "true");
  await expect(del.getByTestId("palette-reason")).toHaveText(NO_DELETE_KS);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Without the refused namespace it is offered again.
  await row(page, "coredns-1").getByRole("checkbox").uncheck();
  await row(page, "web-2").getByRole("checkbox").check();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">delete");
  await expect(option(page, "Delete 2 selected…")).not.toHaveAttribute(
    "aria-disabled",
  );
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAccessibleName("Delete 2 Pods");
});

test("the keyboard Delete says why instead of opening the dialog", async ({
  page,
}) => {
  const fake = await openApp(page, (cluster) => {
    cluster.deniedActions = {
      "kube-system/delete":
        "Not allowed: you can't delete pods in namespace kube-system",
    };
  });
  await openKind(page, "Pods");
  // The focused row (in demo) may be deleted.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Delete");
  await expect(dialog(page)).toHaveAccessibleName("Delete Pod");
  await page.keyboard.press("Escape");

  // A selection with a kube-system pod may not.
  await row(page, "coredns-1").getByRole("checkbox").check();
  await row(page, "web-1").getByRole("checkbox").check();
  await page.getByRole("grid").focus();
  await page.keyboard.press("Delete");
  await expect(notice(page)).toContainText(NO_DELETE_KS);
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
});

test("on a read-only context the palette and Delete give the read-only reason", async ({
  page,
}) => {
  const fake = await openApp(page, (cluster) => {
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
    // RBAC refuses too: read-only wins.
    cluster.deniedActions = {
      shell: "Not allowed: you can't create pods/exec in namespace demo",
      delete: "Not allowed: you can't delete pods in namespace demo",
    };
  });
  await openKind(page, "Pods");
  await paletteActions(page);
  for (const name of ["Shell", "Evict", "Force delete…"]) {
    await expect(option(page, name), name).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(
      option(page, name).getByTestId("palette-reason"),
      name,
    ).toHaveText(READ_ONLY);
  }
  // Reading still works.
  await expect(option(page, "Logs")).not.toHaveAttribute("aria-disabled");
  await expect(option(page, "Port forward…")).not.toHaveAttribute(
    "aria-disabled",
  );
  await page.keyboard.press("Escape");

  await page.getByRole("grid").focus();
  await page.keyboard.press("Delete");
  await expect(notice(page)).toContainText(READ_ONLY);
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdRunAction")).toEqual([]);
});
