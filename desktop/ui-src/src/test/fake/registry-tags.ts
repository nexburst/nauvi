// Available tags (`commands/registry_tags.rs`, #539). `cluster.registryTags`
// gives the answer by image: a report, or a string the command fails with.
// An image without one gets `nginx:1.27`'s report with its own name, so any
// container shows something. Refused with the setting off, like the backend.

import type { ContainerImage, TagReport } from "../../lib/bindings";
import type { AreaHandlers, FakeState } from "./state";

const none = { tags: [], more: 0 };

/** The default answer: `nginx:1.27` on Docker Hub, with dates. */
export function nginxReport(image = "nginx:1.27"): TagReport {
  return {
    image,
    registry: "docker.io",
    repository: "library/nginx",
    tag: "1.27",
    version: "1.27",
    variant: "",
    patch: none,
    minor: { tags: [{ tag: "1.29", updated: "2026-10-14T09:00:00Z" }, { tag: "1.28", updated: "2026-04-02T09:00:00Z" }], more: 0 },
    major: none,
    other: { tags: [{ tag: "latest", updated: "" }, { tag: "alpine", updated: "" }], more: 0 },
    tag_count: 812,
    truncated: false,
    state: "unknown",
    registry_digest: "",
    running_digest: "",
    fetched_at: 0,
  };
}

const SETTING = 'Turn on "Show available tags" in Settings first.';

export function registryTagsHandlers(s: FakeState) {
  return {
    cmdRegistryTags: async (image: string, _imageId: string, _refresh: boolean) => {
      if (!s.cluster.settings.registry_tags) throw SETTING;
      await new Promise((r) => setTimeout(r, 100));
      const answer = s.cluster.registryTags?.[image];
      if (typeof answer === "string") throw answer;
      return answer ?? nginxReport(image);
    },
    cmdWorkloadImages: (_resource: unknown, _namespace: string, name: string): ContainerImage[] => {
      if (!s.cluster.settings.registry_tags) return [];
      return s.cluster.workloadImages?.[name] ?? [{ container: name, image: "nginx:1.27", kind: "regular" }];
    },
  } satisfies AreaHandlers;
}
