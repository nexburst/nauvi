<script lang="ts">
  import { app } from "../stores/app.svelte";
  import { settings } from "../stores/settings.svelte";
  import { hhmmss, zoneSuffix } from "../timeZone";

  const zone = $derived(settings.current.time_zone);
</script>

<footer>
  <span>{app.count}</span>
  <span>{app.updatedAt ? `Updated ${hhmmss(app.updatedAt, zone)}${zoneSuffix(zone)}` : ""}</span>
</footer>

<style>
  footer {
    display: flex;
    gap: 16px;
    padding: 6px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-muted);
    font-size: 12px;
    flex-shrink: 0;
  }
</style>
