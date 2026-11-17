<script lang="ts">
  import { app } from "../stores/app.svelte";
  import ClusterTree from "./ClusterTree.svelte";
  import SidebarKinds from "./SidebarKinds.svelte";
</script>

<!-- The cluster tree (ADR 0007), the shown cluster's resource groups inside
     its node. Without kubeconfig contexts (in-cluster): just the groups. -->
<nav>
  {#if app.contexts.length > 0}
    <ClusterTree />
  {:else}
    <SidebarKinds />
  {/if}
</nav>

<style>
  nav {
    width: 200px;
    flex-shrink: 0;
    background: var(--bg-raised);
    border-right: 1px solid var(--border);
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
  }
</style>
