import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

async function openYaml(page: Page, kindLabel: string, name: string) {
  const fake = await openApp(page);
  await openKind(page, kindLabel);
  await row(page, name).click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  return fake;
}

const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };

/** The CodeMirror editor (its content element is the textbox), once loaded. */
async function editorOf(page: Page, kind: string): Promise<Locator> {
  await expect(page.locator("aside .code-editor")).toHaveAttribute("data-ready", "true");
  return page.getByRole("textbox", { name: `${kind} YAML`, exact: true });
}

/** Type at the end of the document, as raw text (no auto-indent). */
async function append(page: Page, editor: Locator, text: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
}

function button(page: Page, name: string): Locator {
  return page.locator("aside").getByRole("button", { name, exact: true });
}

test("the YAML tab loads the object into the editor", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await expect(editor).toContainText("kind: Deployment");
  await expect(editor).toContainText('resourceVersion: "1"');
  // Highlighting, line numbers and folding are on.
  await expect(page.locator("aside .cm-lineNumbers")).toBeVisible();
  await expect(page.locator("aside .cm-foldGutter")).toBeVisible();
  await expect(editor).toBeEditable();
  expect(await fake.lastCall("cmdGetResourceYaml")).toEqual({
    resource: DEPLOYMENT,
    namespace: "demo",
    name: "web",
    reveal: false,
  });
  // Nothing changed yet: nothing to review.
  await expect(button(page, "Review & save…")).toBeDisabled();
});

test("the YAML arrives as raw bytes, multi-byte text intact (#115)", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await expect(editor).toContainText("kind: Deployment");
  await fake.setCluster((cluster) => {
    cluster.yaml["apps/v1/deployments|demo/web"] =
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  annotations:\n    note: \"größe 日本 🚀\"\n";
  }, null);
  await button(page, "Reload").click();
  await expect(editor).toContainText('note: "größe 日本 🚀"');
  // Unchanged after load: the decoded text is what the editor compares with.
  await expect(button(page, "Review & save…")).toBeDisabled();
});

test("edit, review the diff, then save", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await expect(page.locator("aside h3", { hasText: "YAML" }).locator(".dirty")).toBeVisible();

  await button(page, "Review & save…").click();
  // Validated with a dry run first, at the version that was loaded.
  expect(await fake.lastCall("cmdApplyResourceYaml")).toMatchObject({ dryRun: true, resourceVersion: "1" });
  const diff = page.getByRole("textbox", { name: "Deployment YAML changes" });
  await expect(diff).toBeVisible();
  await expect(page.locator("aside .cm-changedLine")).toHaveText(["spec:", "  replicas: 5"]);
  await expect(page.locator("aside").getByText("The server accepted these changes in a test run.")).toBeVisible();

  // Side by side shows both versions.
  await button(page, "Side by side").click();
  await expect(page.locator("aside .cm-mergeView .cm-editor")).toHaveCount(2);
  await button(page, "Unified").click();

  await button(page, "Save").click();
  await expect(page.getByTestId("yaml-saved")).toContainText(/Saved at \d\d:\d\d:\d\d/);
  const applies = await fake.calls("cmdApplyResourceYaml");
  expect(applies).toHaveLength(2);
  const saved = applies[1];
  expect(saved).toMatchObject({ resource: DEPLOYMENT, namespace: "demo", name: "web", resourceVersion: "1", dryRun: false });
  expect(saved.yaml).toMatch(/kind: Deployment\n[\s\S]*spec:\n {2}replicas: 5\n$/);
  // Reloaded from the server after the save: the new version, no unsaved edits.
  expect(await fake.calls("cmdGetResourceYaml")).toHaveLength(2);
  const reloaded = await editorOf(page, "Deployment");
  await expect(reloaded).toContainText('resourceVersion: "2"');
  await expect(reloaded).toContainText("replicas: 5");
  await expect(button(page, "Review & save…")).toBeDisabled();
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("review shows the fields a save would take over, and the save reports them", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await fake.setCluster(
    (cluster) => {
      cluster.nextTakeovers = [
        { manager: "kubectl-client-side-apply", fields: [".spec.replicas", '.spec.template.spec.containers[name="web"].image'] },
        { manager: "helm", fields: [".metadata.labels.app"] },
      ];
    },
    null,
  );
  await append(page, editor, "spec:\n  replicas: 5\n");

  await button(page, "Review & save…").click();
  const note = page.getByRole("note");
  // The tools in words, not their field manager names (#495).
  await expect(note).toContainText("Saving takes over fields that kubectl apply and Helm set.");
  await expect(note.getByRole("listitem")).toHaveText([
    'kubectl apply: .spec.replicas, .spec.template.spec.containers[name="web"].image',
    "Helm: .metadata.labels.app",
  ]);
  await expect(note.locator("strong").first()).toHaveAttribute("title", "kubectl-client-side-apply");

  await button(page, "Save").click();
  await expect(note).toContainText("This save took over fields that kubectl apply and Helm had set.");
  await expect(note.locator("strong")).toHaveText(["kubectl apply", "Helm"]);
});

test("a dry-run error is shown, points at the line, and nothing is saved", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: -1\n");
  await fake.failNext(
    "cmdApplyResourceYaml",
    'Deployment.apps "web" is invalid: spec.replicas: Invalid value: -1: must be greater than or equal to 0',
  );

  await button(page, "Review & save…").click();
  const alert = page.locator("aside").getByRole("alert");
  await expect(alert).toContainText("The server rejected this YAML: Deployment.apps \"web\" is invalid: spec.replicas");
  await expect(alert).toContainText("(line 8)");
  await expect(page.locator("aside .cm-errorLine")).toHaveText("  replicas: -1");
  // Still editing, the edit kept; only the dry run was sent.
  await expect(editor).toContainText("replicas: -1");
  await expect(button(page, "Save")).toHaveCount(0);
  const applies = await fake.calls("cmdApplyResourceYaml");
  expect(applies.map((c) => c.dryRun)).toEqual([true]);
});

test("a rejected save shows the server's reason and keeps the edit", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "broken: [\n");
  await button(page, "Review & save…").click();
  await fake.failNext("cmdApplyResourceYaml", "admission webhook denied the request");

  await button(page, "Save").click();
  await expect(page.locator("aside").getByRole("alert")).toContainText(
    "Could not save YAML: admission webhook denied the request",
  );
  await expect(await editorOf(page, "Deployment")).toContainText("broken: [");
});

test("a write by someone else is detected: diff against the latest, then save", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await fake.setCluster((cluster) => {
    cluster.resourceVersions["apps/v1/deployments|demo/web"] = 7;
  }, null);

  await button(page, "Review & save…").click();
  const alert = page.locator("aside").getByRole("alert");
  await expect(alert).toContainText("This object changed on the server since you loaded it.");
  await alert.getByRole("button", { name: "Compare with the latest" }).click();

  // Compared with the latest version; the edit is kept.
  await expect(page.getByRole("textbox", { name: "Deployment YAML changes" })).toBeVisible();
  await expect(page.locator("aside .cm-changedLine")).toContainText(['resourceVersion: "1"', "spec:", "  replicas: 5"]);
  await button(page, "Save").click();
  await expect(page.getByTestId("yaml-saved")).toContainText(/Saved at \d\d:\d\d:\d\d/);
  expect(await fake.lastCall("cmdApplyResourceYaml")).toMatchObject({ resourceVersion: "7", dryRun: false });
});

test("a conflict can be resolved by reloading", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await fake.setCluster((cluster) => {
    cluster.resourceVersions["apps/v1/deployments|demo/web"] = 3;
  }, null);
  await button(page, "Review & save…").click();
  await button(page, "Reload (lose my edits)").click();
  await expect(editor).toContainText('resourceVersion: "3"');
  await expect(editor).not.toContainText("replicas: 5");
  await expect(page.locator("aside").getByRole("alert")).toHaveCount(0);
  await expect(button(page, "Review & save…")).toBeDisabled();
});

test("the save is confirmed above the editor and in the notifications (#495)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await button(page, "Review & save…").click();
  // The review's messages sit between the buttons and the diff.
  const accepted = page.locator("aside").getByText("The server accepted these changes in a test run.");
  const diff = page.locator("aside .pane");
  expect((await accepted.boundingBox())!.y).toBeLessThan((await diff.boundingBox())!.y);
  await button(page, "Save").click();

  const saved = page.getByTestId("yaml-saved");
  await expect(saved).toBeInViewport();
  expect((await saved.boundingBox())!.y).toBeLessThan((await diff.boundingBox())!.y);
  await expect(page.getByTestId("notification-count")).toHaveText("1");
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification").first()).toContainText("Saved the YAML of Deployment web.");
  await page.keyboard.press("Escape");

  // The next edit makes it old news.
  await append(page, await editorOf(page, "Deployment"), "# more\n");
  await expect(saved).toHaveCount(0);
});

test("a status-only change on the server is no conflict: the save goes through (#495)", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  // A rollout updates the status while the user types.
  await fake.setCluster((cluster) => {
    cluster.resourceVersions["apps/v1/deployments|demo/web"] = 4;
    cluster.serverWrites["apps/v1/deployments|demo/web"] = "status";
  }, null);
  await button(page, "Review & save…").click();
  await expect(page.locator("aside").getByText("The server accepted these changes in a test run.")).toBeVisible();
  await expect(page.getByTestId("yaml-rebased")).toHaveCount(0);
  await button(page, "Save").click();
  await expect(page.getByTestId("yaml-saved")).toBeVisible();
  await expect(page.locator("aside").getByRole("alert")).toHaveCount(0);
  // The loaded YAML went along, so the backend could tell.
  const saved = await fake.lastCall("cmdApplyResourceYaml");
  expect(saved).toMatchObject({ resourceVersion: "1", dryRun: false });
  expect(saved.base).toContain("kind: Deployment");
  expect(saved.base).not.toContain("replicas: 5");
});

test("a change to other fields re-applies the edit on the latest version, to review (#495)", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await fake.setCluster((cluster) => {
    cluster.resourceVersions["apps/v1/deployments|demo/web"] = 6;
    cluster.serverWrites["apps/v1/deployments|demo/web"] = {
      changed: ['.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]'],
    };
  }, null);
  await button(page, "Review & save…").click();
  const note = page.getByTestId("yaml-rebased");
  await expect(note).toContainText("The object changed on the server while you were editing");
  await expect(note).toContainText("kubectl.kubernetes.io/restartedAt");
  // The diff is against the latest version: only the edit is new.
  await expect(page.locator("aside .cm-changedLine")).toHaveText(["spec:", "  replicas: 5"]);
  await button(page, "Save").click();
  await expect(page.getByTestId("yaml-saved")).toBeVisible();
  expect(await fake.lastCall("cmdApplyResourceYaml")).toMatchObject({ resourceVersion: "6", dryRun: false });
});

test("a field changed on both sides is a conflict that names it (#495)", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await fake.setCluster((cluster) => {
    cluster.resourceVersions["apps/v1/deployments|demo/web"] = 8;
    cluster.serverWrites["apps/v1/deployments|demo/web"] = { conflict: [".spec.replicas"] };
  }, null);
  await button(page, "Review & save…").click();
  const alert = page.locator("aside").getByRole("alert");
  await expect(alert).toContainText("You and someone else both changed .spec.replicas since you loaded this object.");
  await alert.getByRole("button", { name: "Compare with the latest" }).click();
  // An explicit overwrite: said before the save.
  await expect(page.getByRole("note")).toContainText("Saving replaces what changed there with your version");
  await button(page, "Save").click();
  await expect(page.getByTestId("yaml-saved")).toBeVisible();
});

test("closing the panel with unsaved edits asks first", async ({ page }) => {
  await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });

  await page.getByRole("button", { name: "Close details" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("replicas: 5");

  await page.getByRole("button", { name: "Close details" }).click();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator("aside")).toHaveCount(0);

  // Discarded for good: re-opening shows the server's version.
  await row(page, "web").click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  await expect(await editorOf(page, "Deployment")).not.toContainText("replicas: 5");
});

test("switching view or object asks; switching tabs keeps the edit", async ({ page }) => {
  await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });

  // Another tab of the panel and back: the edit is still there.
  await page.locator("aside").getByRole("tab", { name: "Overview" }).click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  await expect(await editorOf(page, "Deployment")).toContainText("replicas: 5");

  // Another view: asks, Escape keeps editing.
  await page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("aside .title")).toContainText("demo/web");

  // Another object: asks, and discarding opens it.
  await row(page, "api").click();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator("aside .title")).toContainText("api");
});

test("switching context with unsaved edits asks first", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  const context = page.getByRole("combobox", { name: "Cluster context" });
  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });

  await context.selectOption("prod");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(context).toHaveValue("kind-dev");
  expect(await fake.calls("cmdSetContext")).toHaveLength(0);
  await expect(editor).toContainText("replicas: 5");

  await context.selectOption("prod");
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator("aside")).toHaveCount(0);
  expect(await fake.lastCall("cmdSetContext")).toEqual({ name: "prod" });
});

test("Reload with unsaved edits asks first", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await button(page, "Reload").click();
  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  expect(await fake.calls("cmdGetResourceYaml")).toHaveLength(1);
  await expect(editor).toContainText("replicas: 5");

  await button(page, "Reload").click();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).not.toContainText("replicas: 5");
  expect(await fake.calls("cmdGetResourceYaml")).toHaveLength(2);
});

test("a locked Secret is read-only until its values are revealed", async ({ page }) => {
  const fake = await openYaml(page, "Secrets", "db-creds");
  const aside = page.locator("aside");
  const editor = await editorOf(page, "Secret");
  await expect(editor).toContainText("password: <hidden>");
  await expect(editor).not.toBeEditable();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(button(page, "Review & save…")).toBeDisabled();
  await expect(aside.getByText("Values are hidden. Reveal them to edit this Secret.")).toBeVisible();

  await button(page, "Reveal values").click();
  await expect(editor).toContainText("password: hunter2");
  await expect(editor).toBeEditable();
  expect((await fake.lastCall("cmdGetResourceYaml")).reveal).toBe(true);

  await button(page, "Hide values").click();
  await expect(editor).toContainText("password: <hidden>");
  await expect(editor).not.toBeEditable();
  expect((await fake.lastCall("cmdGetResourceYaml")).reveal).toBe(false);
});

test("a failed load leaves nothing to review", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await fake.failNext("cmdGetResourceYaml", 'deployments.apps "web" not found');
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  await expect(page.locator("aside").getByText('Could not load YAML: deployments.apps "web" not found')).toBeVisible();
  await expect(button(page, "Review & save…")).toBeDisabled();
});

test("Enter after a key that opens a block indents the next line (#101)", async ({ page }) => {
  await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  // Real key presses, so the editor's Enter command runs.
  await page.keyboard.type("spec:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("template:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("x: 1");
  await page.keyboard.press("Enter");
  await page.keyboard.type("y: 2");
  const text = await editor.evaluate((el) => (el as HTMLElement).innerText);
  expect(text).toContain("spec:\n  template:\n    x: 1\n    y: 2");
});

test("the diff's unchanged-lines bar draws its chevrons, no font glyph (#101)", async ({ page }) => {
  // A long object, so the diff collapses the unchanged middle (the init
  // function runs in the page: no closures).
  await openApp(page, (c) => {
    const labels = Array.from({ length: 20 }, (_, i) => `    l${i}: "v"`).join("\n");
    c.yaml["apps/v1/deployments|demo/web"] =
      `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: demo\n  labels:\n${labels}\n`;
  });
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  const editor = await editorOf(page, "Deployment");
  await append(page, editor, "spec:\n  replicas: 5\n");
  await button(page, "Review & save…").click();
  const bar = page.locator("aside .cm-collapsedLines").first();
  await expect(bar).toContainText("unchanged lines");
  const marks = await bar.evaluate((el) =>
    ["::before", "::after"].map((p) => {
      const s = getComputedStyle(el, p);
      return { content: s.content, border: s.borderRightStyle };
    }),
  );
  expect(marks).toEqual([
    { content: '""', border: "solid" },
    { content: '""', border: "solid" },
  ]);
});

test("the editor follows the theme; its cursor and active line number stay visible", async ({ page }) => {
  await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  const colours = () =>
    page.evaluate(() => {
      const css = (sel: string, prop: string) =>
        getComputedStyle(document.querySelector(`aside ${sel}`) as Element).getPropertyValue(prop);
      return {
        background: css(".cm-editor", "background-color"),
        gutter: css(".cm-gutters", "background-color"),
        activeNumber: css(".cm-lineNumbers .cm-activeLineGutter", "color"),
        cursor: css(".cm-cursor", "border-left-color"),
        key: css(".cm-line span", "color"),
      };
    });

  // Dark: light text on the dark editor. (Set explicitly: the test browser
  // may prefer the light scheme.)
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  expect(await colours()).toEqual({
    background: "rgb(11, 14, 20)",
    gutter: "rgb(11, 14, 20)",
    activeNumber: "rgb(214, 220, 230)",
    cursor: "rgb(214, 220, 230)",
    key: "rgb(127, 200, 255)",
  });

  // Light: what Settings → Theme → Light sets. Dark text on a light editor.
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  expect(await colours()).toEqual({
    background: "rgb(255, 253, 248)",
    gutter: "rgb(255, 253, 248)",
    activeNumber: "rgb(27, 33, 48)",
    cursor: "rgb(27, 33, 48)",
    key: "rgb(11, 92, 173)",
  });
});

test("after typing, the editor is back at its left edge: column-0 keys aren't cut by the gutter (#153)", async ({ page }) => {
  // A long line, like kubectl's last-applied-configuration annotation.
  await openApp(page, (c) => {
    const long = `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"annotations":{},"name":"web","namespace":"demo"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"web"}}}}`;
    c.yaml["apps/v1/deployments|demo/web"] =
      `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      ${long}\n  name: web\n  namespace: demo\ndata:\n  alpha: one\n  beta: two\n`;
  });
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  const editor = await editorOf(page, "Deployment");
  const scroller = page.locator("aside .cm-scroller");
  // Read the end of the long line: the view scrolls sideways.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect.poll(() => scroller.evaluate((e) => e.scrollLeft)).toBeGreaterThan(100);
  // Then type on a short line. CodeMirror alone scrolls back only until the
  // cursor shows, 5 px from the gutter, and leaves the keys' start hidden.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("gamma: three");
  expect(await editor.evaluate((el) => (el as HTMLElement).innerText)).toContain("beta: two\n  gamma: three");
  await expect.poll(() => scroller.evaluate((e) => e.scrollLeft)).toBe(0);
  const edges = await scroller.evaluate((e) => {
    const line = Array.from(e.querySelectorAll(".cm-line")).find((l) => l.textContent === "apiVersion: apps/v1")!;
    const text = document.createRange();
    text.selectNodeContents(line);
    return { text: text.getBoundingClientRect().left, gutter: e.querySelector(".cm-gutters")!.getBoundingClientRect().right };
  });
  expect(edges.text).toBeGreaterThanOrEqual(edges.gutter);
});

test("closing the window or quitting with unsaved edits asks first (#173)", async ({ page }) => {
  const fake = await openYaml(page, "Deployments", "web");
  const editor = await editorOf(page, "Deployment");
  const lastReport = async () => (await fake.calls("cmdSetUnsaved")).at(-1);
  // Nothing unsaved yet: the backend is told so.
  await expect.poll(lastReport).toEqual({ unsaved: false });
  await append(page, editor, "spec:\n  replicas: 5\n");
  await expect.poll(lastReport).toEqual({ unsaved: true });
  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });

  // The backend stopped a close: Keep editing leaves the window open.
  await page.evaluate(() => window.__fake.emitUnsavedCloseRequested(false));
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("replicas: 5");
  expect(await fake.calls("cmdDiscardAndClose")).toHaveLength(0);

  // A stopped quit: Discard goes on quitting.
  await page.evaluate(() => window.__fake.emitUnsavedCloseRequested(true));
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect.poll(() => fake.calls("cmdDiscardAndClose")).toEqual([{ quit: true }]);
  await expect.poll(lastReport).toEqual({ unsaved: false });
});
