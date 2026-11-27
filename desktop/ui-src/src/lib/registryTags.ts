// Available tags (#539): how the pod and workload panels show a registry's
// newer tags (`cmd_registry_tags`).

import type { TagGroup, TagReport } from "./bindings";

/** One group of newer tags, as the panel lists it. */
export interface TagSection {
  id: "patch" | "minor" | "major" | "other";
  title: string;
  /** What the step means for an update. */
  hint: string;
  group: TagGroup;
}

/** The registry as the user knows it. */
export function registryName(registry: string): string {
  return registry === "docker.io" ? "Docker Hub" : registry;
}

/** The registry an image names (`docker.io` when it names none), as
 *  `ImageRef::parse` reads it. */
export function imageRegistry(image: string): string {
  const first = image.trim().split("/")[0];
  const named = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return named ? first.toLowerCase() : "docker.io";
}

/** `sha256:` and the first 12 hex digits. */
export function shortDigest(d: string): string {
  return d.startsWith("sha256:") ? d.slice(0, 7 + 12) : d;
}

/** The day of an RFC 3339 time (`2026-10-01`), `""` if none. */
export function tagDay(updated: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : "";
}

/** The groups that have tags, in the order the panel shows them. */
export function tagSections(r: TagReport): TagSection[] {
  const all: TagSection[] = [
    { id: "patch", title: "Newer patch", hint: "safe to update", group: r.patch },
    { id: "minor", title: "Newer minor", hint: "new features", group: r.minor },
    { id: "major", title: "Newer major", hint: "may break things", group: r.major },
    { id: "other", title: "Not versions", hint: "", group: r.other },
  ];
  return all.filter((s) => s.group.tags.length > 0);
}

/** What the registry says about the running tag itself (`""`: nothing known). */
export function tagStateText(r: TagReport): string {
  switch (r.state) {
    case "updated":
      return `This tag was updated in the registry: ${r.tag} now points to ${shortDigest(r.registry_digest)}, the container runs ${shortDigest(r.running_digest)}.`;
    case "unchanged":
      return `${r.tag} still points to what the container runs.`;
    case "gone":
      return `The registry no longer has the tag ${r.tag}.`;
    default:
      return "";
  }
}

/** The line under the image when there is nothing newer to list. */
export function emptyText(r: TagReport): string {
  if (!r.version) return `The tag ${r.tag || "(none)"} is not a version, so there is nothing to compare it with.`;
  if (r.patch.tags.length + r.minor.tags.length + r.major.tags.length > 0) return "";
  return r.variant ? `No newer versions with the variant ${r.variant}.` : "No newer versions.";
}

/** `1,234 tags on Docker Hub` and whether the list was cut. */
export function countText(r: TagReport): string {
  const n = r.tag_count.toLocaleString("en-US");
  const tags = `${n} tag${r.tag_count === 1 ? "" : "s"}`;
  return `${tags}${r.truncated ? " read (the list is longer)" : ""} on ${registryName(r.registry)}`;
}
