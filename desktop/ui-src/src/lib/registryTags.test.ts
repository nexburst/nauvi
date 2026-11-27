import { describe, expect, it } from "vitest";
import type { TagReport } from "./bindings";
import { countText, emptyText, imageRegistry, registryName, shortDigest, tagDay, tagSections, tagStateText } from "./registryTags";

const none = { tags: [], more: 0 };
const base: TagReport = {
  image: "mongo:7.0.1-jammy",
  registry: "docker.io",
  repository: "library/mongo",
  tag: "7.0.1-jammy",
  version: "7.0.1",
  variant: "-jammy",
  patch: { tags: [{ tag: "7.0.2-jammy", updated: "2026-10-01T10:00:00Z" }], more: 0 },
  minor: none,
  major: { tags: [{ tag: "8.0.0-jammy", updated: "" }], more: 2 },
  other: { tags: [{ tag: "latest", updated: "" }], more: 0 },
  tag_count: 1234,
  truncated: false,
  state: "unknown",
  registry_digest: "",
  running_digest: "",
  fetched_at: 0,
};

describe("registry tags", () => {
  it("lists the groups that have tags, patch first", () => {
    expect(tagSections(base).map((s) => s.id)).toEqual(["patch", "major", "other"]);
    expect(tagSections(base)[1].hint).toBe("may break things");
  });

  it("says when the tag was pushed again or is gone", () => {
    const a = `sha256:${"a".repeat(64)}`;
    const b = `sha256:${"b".repeat(64)}`;
    expect(tagStateText({ ...base, state: "updated", registry_digest: a, running_digest: b })).toBe(
      "This tag was updated in the registry: 7.0.1-jammy now points to sha256:aaaaaaaaaaaa, the container runs sha256:bbbbbbbbbbbb.",
    );
    expect(tagStateText({ ...base, state: "unchanged" })).toContain("still points to");
    expect(tagStateText({ ...base, state: "gone" })).toBe("The registry no longer has the tag 7.0.1-jammy.");
    expect(tagStateText(base)).toBe("");
  });

  it("explains an empty result", () => {
    expect(emptyText(base)).toBe("");
    expect(emptyText({ ...base, patch: none, major: none })).toBe("No newer versions with the variant -jammy.");
    expect(emptyText({ ...base, patch: none, major: none, variant: "" })).toBe("No newer versions.");
    expect(emptyText({ ...base, tag: "latest", version: "" })).toContain("The tag latest is not a version");
  });

  it("formats names, digests, days and counts", () => {
    expect(registryName("docker.io")).toBe("Docker Hub");
    expect(imageRegistry("mongo:7")).toBe("docker.io");
    expect(imageRegistry("bitnami/redis:7")).toBe("docker.io");
    expect(imageRegistry("ghcr.io/o/app:1")).toBe("ghcr.io");
    expect(imageRegistry("localhost:5000/app")).toBe("localhost:5000");
    expect(registryName("ghcr.io")).toBe("ghcr.io");
    expect(shortDigest("sha256:0123456789abcdef")).toBe("sha256:0123456789ab");
    expect(tagDay("2026-10-01T10:00:00Z")).toBe("2026-10-01");
    expect(tagDay("")).toBe("");
    expect(countText(base)).toBe("1,234 tags on Docker Hub");
    expect(countText({ ...base, tag_count: 1, truncated: true, registry: "ghcr.io" })).toBe(
      "1 tag read (the list is longer) on ghcr.io",
    );
  });
});
