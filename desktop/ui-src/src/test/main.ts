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
// for the summoned chart (the app's default) before the app mounts.
if (localStorage.getItem("nauvi.chart.pinned") === null) setChartPinned(true);
const cluster = defaultCluster();
const fake = installFakeBackend(cluster);
window.__fakeInit?.(cluster, fake);
// No autocorrect or autocapitalisation in any field (#176).
plainInputs(document.body);
suppressEngineMenu(window);
// Uncaught errors go to the app log (#208).
forwardUiErrors(window);
mount(App, { target: document.getElementById("app")! });
