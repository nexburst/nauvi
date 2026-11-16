<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import ActionBar from "./ActionBar.svelte";
  import ConditionsTable from "./ConditionsTable.svelte";
  import ContainerCard from "./ContainerCard.svelte";
  import DetailNotices from "./DetailNotices.svelte";
  import EventsTable from "./EventsTable.svelte";
  import MetaSection from "./MetaSection.svelte";
  import PortForward from "./PortForward.svelte";
  import RelatedGroups from "./RelatedGroups.svelte";
  import UsageCharts from "./UsageCharts.svelte";
  import YamlEditor from "./YamlEditor.svelte";
  import { closeDetail } from "../stores/detail.svelte";
  import type { DockTabSpec } from "../dock";
  import type { Target } from "../stores/detail.svelte";
  import { LiveDetail } from "../stores/live-detail.svelte";
  import { LiveRelated } from "../stores/related.svelte";

  /** The pod panel: the generic overview plus the pod section (containers,
   *  QoS, IPs...), the header of actions (logs and a shell in the dock,
   *  attach, edit, delete...), port-forward, and the YAML editor.
   *  Every other kind uses `GenericDetail`. */
  let { target }: { target: Target } = $props();
  const pod = $derived({ namespace: target.namespace, name: target.name });

  // The panel is remounted for every object, so `target` is fixed here.
  // svelte-ignore state_referenced_locally
  const live = new LiveDetail(target);
  const info = $derived(live.info);
  const extras = $derived(info?.pod ?? null);
  /** The Services that select the pod and the ConfigMaps, Secrets and PVCs
   *  it uses. */
  // svelte-ignore state_referenced_locally
  const related = new LiveRelated(target);
  $effect(() => {
    if (live.info) related.seen(live.info);
  });
  let portForward: PortForward | undefined = $state();

  onMount(() => {
    void live.start();
    void related.refresh();
  });
  onDestroy(() => {
    live.stop();
    related.stop();
  });

  /** The terminal opens in the first regular container. */
  const shellContainer = $derived(extras?.containers.find((c) => c.kind === "regular")?.name ?? null);

  /** The header's Logs and Shell know the containers once the details load;
   *  before that, the dock tab looks them up itself. */
  function dockSpec(spec: DockTabSpec): DockTabSpec {
    if (!extras) return spec;
    if (spec.type === "podLogs") return { ...spec, containers: $state.snapshot(extras.log_containers) };
    if (spec.type === "terminal") return { ...spec, container: shellContainer };
    return spec;
  }

  let yamlEl = $state<HTMLDivElement | null>(null);
  /** Edit: bring the YAML editor into view and give it the keyboard. */
  function showYaml() {
    yamlEl?.scrollIntoView({ block: "start", behavior: "smooth" });
    yamlEl?.querySelector<HTMLElement>(".cm-content")?.focus({ preventScroll: true });
  }
</script>

<aside data-testid="detail-panel">
  <div class="top">
    <div class="header">
      <span class="title">{pod.namespace}/{pod.name}</span>
      <button type="button" class="close" aria-label="Close details" onclick={closeDetail}>✕</button>
    </div>
    <ActionBar {target} disabled={live.deleted} onEdit={showYaml} {dockSpec} />
  </div>
  <DetailNotices {live} kind="Pod" />

  <div class="body">
    {#if live.deleted && !info}
      <!-- DetailNotices says it was deleted. -->
    {:else if live.loadError && !info}
      <p class="error-text">Could not load pod details: {live.loadError}</p>
    {:else if !info || !extras}
      <p class="muted">Loading…</p>
    {:else}
      <MetaSection {info}>
        <dt>Phase</dt>
        <dd class="phase-{extras.phase}">
          {extras.phase}{#if extras.reason}<span class="muted"> ({extras.reason})</span>{/if}
        </dd>
        {#if extras.message}
          <dt>Message</dt>
          <dd>{extras.message}</dd>
        {/if}
        <dt>Node</dt>
        <dd>{extras.node || "—"}</dd>
        <dt>Pod IPs</dt>
        <dd>{extras.pod_ips.join(", ") || "—"}</dd>
        {#if extras.host_ip}
          <dt>Host IP</dt>
          <dd>{extras.host_ip}</dd>
        {/if}
        <dt>QoS</dt>
        <dd>{extras.qos_class || "—"}</dd>
        {#if extras.priority_class}
          <dt>Priority</dt>
          <dd>{extras.priority_class}</dd>
        {/if}
        <dt>Service acct</dt>
        <dd>{extras.service_account || "—"}</dd>
      </MetaSection>

      <UsageCharts what="pods" namespace={target.namespace} name={target.name} />

      <h3>Containers</h3>
      {#each extras.containers as c (c.kind + "/" + c.name)}
        <ContainerCard container={c} disabled={live.deleted} onForward={(p) => portForward?.forward(p)} />
      {:else}
        <p class="muted">No containers.</p>
      {/each}

      <RelatedGroups {related} />
      <ConditionsTable conditions={info.conditions} />
      <EventsTable events={info.events} />
    {/if}
  </div>

  <PortForward bind:this={portForward} {pod} disabled={live.deleted} />
  <div class="yaml" bind:this={yamlEl}>
    <YamlEditor {target} />
  </div>
</aside>

<style>
  aside {
    width: min(var(--detail-width, 420px), 75vw);
    flex-shrink: 0;
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  /* Sections keep their natural height and the panel scrolls as a whole;
     without this the flex column squeezes them. */
  aside > :global(*) {
    flex-shrink: 0;
  }
  /* The title and the actions stay in view while the panel scrolls. */
  .top {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
  }
  .yaml {
    scroll-margin-top: 90px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px 2px;
    font-weight: 600;
    font-size: 13px;
    word-break: break-all;
  }
  .close {
    background: transparent;
    color: var(--text-muted);
    border: none;
    font-size: 14px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .close:hover {
    color: var(--text);
  }
  .body {
    padding: 12px 16px;
  }
  .body h3 {
    margin: 14px 0 8px;
    font-size: 13px;
  }
</style>
