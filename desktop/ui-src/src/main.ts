import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { plainInputs } from "./lib/plainInputs";

// No autocorrect or autocapitalisation in any field (#176).
plainInputs(document.body);
const app = mount(App, { target: document.getElementById("app")! });

export default app;
