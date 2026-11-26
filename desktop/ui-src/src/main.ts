import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { plainInputs } from "./lib/plainInputs";
import { suppressEngineMenu } from "./lib/engineMenu";
import { retryOnWake } from "./lib/stores/wakeRetry";
import { forwardUiErrors } from "./lib/uiErrors";

// No autocorrect or autocapitalisation in any field (#176).
plainInputs(document.body);
// The engine's menu (Back, Reload) only in text fields, the editor and the terminal (#205).
suppressEngineMenu(window);
// Uncaught errors go to the app log (#208).
forwardUiErrors(window);
// A feed that stopped retrying starts again on a wake or when the network comes back (#526).
retryOnWake(window, document);
const app = mount(App, { target: document.getElementById("app")! });

export default app;
