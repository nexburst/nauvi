<script lang="ts">
  import type { PanelActionId } from "../actions";

  /** A 16px line icon for a detail panel action (#218). Drawn on a 24-unit
   *  grid in `currentColor`, so it follows the theme and the button's state. */
  let { id }: { id: PanelActionId } = $props();

  const terminal = ["M4 17l6-5-6-5", "M12 19h8"];
  const PATHS: Record<PanelActionId, string[]> = {
    logs: ["M4 5h16", "M4 10h16", "M4 15h10", "M4 20h7"],
    shell: terminal,
    nodeShell: terminal,
    attach: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 0 1-12 0Z", "M12 18v4"],
    edit: ["M13 21h8", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"],
    link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
    delete: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v5", "M14 11v5"],
    forceDelete: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M9.5 10.5l5 5", "M14.5 10.5l-5 5"],
    scale: ["M7 9l5-5 5 5", "M7 15l5 5 5-5"],
    restart: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
    cordon: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z", "M5.6 5.6l12.8 12.8"],
    uncordon: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z", "M8 12l3 3 5-6"],
    drain: ["M10 3H5v18h5", "M15 17l5-5-5-5", "M20 12H9"],
    evict: ["M14 3h5v18h-5", "M9 17l-5-5 5-5", "M4 12h11"],
    trigger: ["M7 4l13 8-13 8Z"],
    suspend: ["M8 5v14", "M16 5v14"],
    resume: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z", "M10 8l6 4-6 4Z"],
    portForward: ["M16 3l4 4-4 4", "M20 7H4", "M8 21l-4-4 4-4", "M4 17h16"],
    debug: [
      "M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0Z",
      "M12 11v7",
      "M4 13h4",
      "M16 13h4",
      "M5 7l3 2",
      "M19 7l-3 2",
      "M5 19l3-2",
      "M19 19l-3-2",
      "M10 5L9 3",
      "M14 5l1-2",
    ],
  };
</script>

<svg
  viewBox="0 0 24 24"
  width="16"
  height="16"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each PATHS[id] ?? [] as d, i (i)}
    <path {d} />
  {/each}
</svg>
