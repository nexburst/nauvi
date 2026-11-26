<script lang="ts">
  import type { Snippet } from "svelte";
  import CalmWater from "./CalmWater.svelte";

  /**
   * Why a list is empty and what to do about it (#485): a title, a line of
   * detail and the actions (buttons) as children. One per list, never two.
   */
  interface Props {
    title: string;
    detail?: string;
    mark?: "buoy" | "lighthouse";
    reason?: string;
    children?: Snippet;
  }
  let { title, detail = "", mark = "buoy", reason = "", children }: Props = $props();
</script>

<div class="empty-state" data-testid="empty-state" data-reason={reason || undefined}>
  <CalmWater {mark}>
    <p class="title">{title}</p>
    {#if detail}
      <p class="detail">{detail}</p>
    {/if}
    {#if children}
      <div class="actions">{@render children()}</div>
    {/if}
  </CalmWater>
</div>

<style>
  .empty-state {
    max-width: 560px;
    padding: 0 16px;
  }
  p {
    margin: 0;
  }
  .title {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }
  .detail {
    margin-top: 2px;
    font-size: var(--text-base);
    line-height: 1.45;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
</style>
