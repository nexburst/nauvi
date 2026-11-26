<script lang="ts">
  // The health check of the views that watch nothing (#469): while one is
  // shown, ask every HEALTH_EVERY_MS whether the cluster answers, and say
  // so in the header and the banner, as a watch would. Draws nothing; it
  // stops when the view or the window goes away, and skips its checks
  // while the window is hidden (one more runs when it shows again).
  import { onDestroy, untrack } from "svelte";
  import { api, visibleCluster } from "../cluster";
  import { HEALTH_EVERY_MS, healthError, isProbeFailure, isReachabilityError } from "../health";
  import { app, currentContextName, setStatus, showError } from "../stores/app.svelte";

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every (re)start: an answer of an older run is dropped. */
  let run = 0;
  /** The banner message this check set, so it clears only its own. */
  let shown = "";

  function clearError() {
    if (shown && app.error === shown) showError("");
    shown = "";
  }

  function schedule(id: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void check(id), HEALTH_EVERY_MS);
  }

  async function check(id: number) {
    timer = null;
    if (id !== run) return;
    if (document.visibilityState === "hidden") return schedule(id);
    const cluster = visibleCluster();
    try {
      await api(cluster).cmdClusterHealth();
      if (id !== run || cluster !== visibleCluster()) return;
      if (app.status.ok !== true || app.status.text !== "Live") setStatus(true, "Live");
      clearError();
      // The cluster answers: another view's "cannot reach" banner is wrong now.
      if (isReachabilityError(app.error)) showError("");
    } catch (e) {
      if (id !== run || cluster !== visibleCluster()) return;
      const err = healthError(e);
      setStatus(false, err.status);
      shown = err.message;
      showError(err.message);
      // A failed login or certificate: checking again would run the login
      // command again (a browser, for some plugins). Refresh, a cluster
      // switch or the window showing again starts over.
      if (!isProbeFailure(e)) return;
    }
    schedule(id);
  }

  function start() {
    const id = ++run;
    void check(id);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") start();
  }

  // At once, and again on Refresh and when the window shows another cluster.
  $effect(() => {
    void app.refreshNonce;
    void currentContextName();
    untrack(start);
  });

  document.addEventListener("visibilitychange", onVisibility);

  onDestroy(() => {
    run++;
    if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    clearError();
  });
</script>
