import { mount } from "svelte";
import "../app.css";
import App from "../App.svelte";
import { installFakeBackend } from "./fake-backend";
import { defaultCluster } from "./fixtures/cluster";
import { plainInputs } from "../lib/plainInputs";
import { suppressEngineMenu } from "../lib/engineMenu";
import { forwardUiErrors } from "../lib/uiErrors";
import { setChartPinned } from "../lib/stores/chart.svelte";

// Test-only entry, served by Vite at /test.html for the Playwright tests (like
// bench.html, it is not part of the production build, which only bundles
// index.html): the real app on top of the fake backend.
// The tests drive the chart of kinds pinned as a column, unless one asks
// for the summoned chart before the app mounts, or for a first launch
// ("nauvi.test.first-launch": the layout the app picks by itself, #490).
if (localStorage.getItem("nauvi.chart.pinned") === null && localStorage.getItem("nauvi.test.first-launch") === null)
  setChartPinned(true);
// Likewise Settings: every section on one page, unless a test picks one.
if (localStorage.getItem("nauvi.settings.section") === null) localStorage.setItem("nauvi.settings.section", "all");
const cluster = defaultCluster();
const fake = installFakeBackend(cluster);
window.__fakeInit?.(cluster, fake);
// No autocorrect or autocapitalisation in any field (#176).
plainInputs(document.body);
suppressEngineMenu(window);
// Uncaught errors go to the app log (#208).
forwardUiErrors(window);
mount(App, { target: document.getElementById("app")! });
