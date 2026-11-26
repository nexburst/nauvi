import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ObjectLink } from "../../lib/bindings";
import { namespaceButton, openApp, openKind, row, toggleNamespaces } from "./helpers";

// "Copy link" and opening nauvi:// links (#299). The backend parses and
// checks the link and routes it to a window; these tests start from the
// request a window takes (`cmdTakeLink`).

const panel = (page: Page) => page.getByTestId("detail-panel");
const bar = (page: Page) => panel(page).getByRole("toolbar", { name: "Actions" });
const menu = (page: Page) => page.getByTestId("context-menu");
const sidebar = (page: Page, name: string) => page.getByRole("navigation").getByRole("button", { name, exact: true });

const link = (over: Partial<ObjectLink> = {}): ObjectLink => ({
  context: "kind-dev",
  group: "",
  version: "v1",
  kind: "Pod",
  namespace: "demo",
  name: "web-2",
  ...over,
});

async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test("Copy link in the detail panel and the row menu", async ({ page }) => {
  await captureClipboard(page);
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  // After the other actions, before the destructive ones; not part of the access check.
  await expect(bar(page).getByRole("button")).toHaveText([
    "Logs",
    "Shell",
    "Edit YAML",
    "Port forward…",
    "Attach",
    "Debug…",
    "Copy link",
    "Evict",
    "Delete",
    "Force delete…",
  ]);
  await bar(page).getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status")).toContainText("Copied the link to Pod web-1");
  expect(await copied(page)).toEqual(["nauvi://kind-dev/core/v1/Pod/demo/web-1"]);
  expect((await fake.lastCall("cmdCheckActions")).ids).not.toContain("link");

  await openKind(page, "Deployments");
  await row(page, "api").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Copy link" }).click();
  await expect.poll(() => copied(page)).toContain("nauvi://kind-dev/apps/v1/Deployment/demo/api");
  expect(fake.errors).toEqual([]);
});

test("Copy link says why when the backend refuses", async ({ page }) => {
  await captureClipboard(page);
  const fake = await openApp(page);
  await openKind(page, "Nodes");
  // The menu asks ahead, the click asks again.
  const refusal = "This object can't be linked to: its context is not a name nauvi can link to.";
  await fake.failNext("cmdObjectLink", refusal);
  await fake.failNext("cmdObjectLink", refusal);
  await row(page, "node-1").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.getByRole("alert")).toContainText("its context is not a name nauvi can link to");
  expect(await copied(page)).toEqual([]);
});

test("an opened link shows the object, in its namespace", async ({ page }) => {
  const fake = await openApp(page);
  // Another namespace is shown: the link switches to the object's.
  await openKind(page, "Deployments");
  await toggleNamespaces(page, "kube-system");
  await fake.openLink({ type: "open", link: link() });
  await expect(panel(page)).toContainText("web-2");
  await expect(sidebar(page, "Pods")).toHaveClass(/active/);
  await expect(namespaceButton(page)).toContainText("demo");

  // A cluster-scoped object.
  await fake.openLink({ type: "open", link: link({ kind: "Node", namespace: "", name: "node-2" }) });
  await expect(panel(page)).toContainText("node-2");
  expect(fake.errors).toEqual([]);
});

test("a link the window can't show leaves a plain notice", async ({ page }) => {
  const fake = await openApp(page);
  await fake.openLink({ type: "notice", message: "This link is for the context gone, which is not in your kubeconfigs. Nothing was opened." });
  await expect(page.getByRole("alert")).toContainText("which is not in your kubeconfigs. Nothing was opened.");
  await page.getByRole("button", { name: "Dismiss" }).click();

  await fake.openLink({ type: "open", link: link({ context: "prod" }) });
  await expect(page.getByRole("alert")).toContainText("This link is for the context prod, but this window shows kind-dev");
  await page.getByRole("button", { name: "Dismiss" }).click();

  await fake.openLink({ type: "open", link: link({ group: "example.io", kind: "Widget" }) });
  await expect(page.getByRole("alert")).toContainText("kind-dev does not serve Widget (example.io/v1)");
  await expect(panel(page)).toHaveCount(0);
  // Nothing was switched or run.
  expect(await fake.calls("cmdSetContext")).toEqual([]);
  expect(await fake.calls("cmdRunAction")).toEqual([]);
});

test("the main window started from a link starts on the link's context", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => {
    f.queueLink({
      type: "open",
      link: { context: "prod", group: "apps", version: "v1", kind: "Deployment", namespace: "demo", name: "web" },
    });
  });
  await expect.poll(() => fake.calls("cmdSetContext")).toEqual([{ name: "prod" }]);
  await expect(panel(page)).toContainText("web");
  await expect(sidebar(page, "Deployments")).toHaveClass(/active/);
});
