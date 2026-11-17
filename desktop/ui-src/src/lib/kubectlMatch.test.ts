import { describe, expect, it } from "vitest";
import type { KubectlMatch } from "./bindings";
import { kubectlIntro, offerState } from "./kubectlMatch";

const base: KubectlMatch = {
  enabled: true,
  server: "v1.31.2",
  installed: "v1.28.0",
  skew: true,
  downloaded: false,
  url: "https://dl.k8s.io/release/v1.31.2/bin/linux/amd64/kubectl",
  note: "",
};

describe("offerState", () => {
  it("offers the server's version when the skew is too large", () => {
    const s = offerState(base, "");
    expect(s.kind).toBe("offer");
    if (s.kind !== "offer") return;
    expect(s.version).toBe("v1.31.2");
    expect(s.text).toContain("Your kubectl v1.28.0");
    expect(s.text).toContain("dl.k8s.io");
    expect(s.text).toContain("SHA-256");
  });

  it("says when no kubectl was found", () => {
    const s = offerState({ ...base, installed: "" }, "");
    expect(s.kind === "offer" && s.text.startsWith("No kubectl was found")).toBe(true);
  });

  it("shows nothing when off, close enough, or already used", () => {
    expect(offerState({ ...base, enabled: false }, "").kind).toBe("none");
    expect(offerState({ ...base, skew: false }, "").kind).toBe("none");
    expect(offerState({ ...base, downloaded: true }, "v1.31.2").kind).toBe("none");
  });

  it("points at a new terminal when downloaded but not used here", () => {
    const s = offerState({ ...base, downloaded: true }, "");
    expect(s.kind).toBe("ready");
  });

  it("explains why there is nothing to offer", () => {
    const s = offerState({ ...base, server: "", url: "", skew: false, note: "forbidden" }, "");
    expect(s).toEqual({ kind: "note", text: "No matching kubectl to offer: forbidden" });
  });
});

describe("kubectlIntro", () => {
  it("names the version, or says nothing", () => {
    expect(kubectlIntro("")).toBe("");
    expect(kubectlIntro("v1.31.2")).toContain("kubectl v1.31.2");
  });
});
