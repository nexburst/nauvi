import { describe, expect, it } from "vitest";
import { appLink, describeAppLink, findAppLinks, webLink } from "./terminalLinks";

describe("webLink", () => {
  it("allows http and https", () => {
    expect(webLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(webLink("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(webLink(" HTTPS://Example.com ")).toBe("https://example.com/");
  });

  it("ignores other schemes", () => {
    for (const uri of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "ftp://example.com",
      "vscode://file/etc/passwd",
      "mailto:a@example.com",
      "tauri://localhost",
      "ipc://localhost",
    ]) {
      expect(webLink(uri), uri).toBeNull();
    }
  });

  it("ignores relative and broken links", () => {
    expect(webLink("")).toBeNull();
    expect(webLink("/etc/passwd")).toBeNull();
    expect(webLink("example.com")).toBeNull();
    expect(webLink("http://")).toBeNull();
  });

  it("ignores links with credentials", () => {
    expect(webLink("https://github.com@evil.example/")).toBeNull();
    expect(webLink("https://u:p@example.com/")).toBeNull();
  });
});

describe("nauvi:// links in an Ask AI terminal (#548)", () => {
  it("knows a link to hand to the backend", () => {
    expect(appLink(" nauvi://kind/core/v1/Pod/demo/web ")).toBe("nauvi://kind/core/v1/Pod/demo/web");
    expect(appLink("NAUVI://kind/core/v1/Pod/demo/web")).toBe("NAUVI://kind/core/v1/Pod/demo/web");
    expect(appLink("https://example.com")).toBeNull();
    expect(appLink("nauvi:kind")).toBeNull();
    expect(appLink(`nauvi://${"a".repeat(2050)}`)).toBeNull();
  });

  it("finds links in a line of text, without the sentence's punctuation", () => {
    const line = "Pod demo/web crashed (nauvi://kind/core/v1/Pod/demo/web). See nauvi://kind/apps/v1/Deployment/demo/web.";
    const found = findAppLinks(line);
    expect(found.map((f) => f.uri)).toEqual([
      "nauvi://kind/core/v1/Pod/demo/web",
      "nauvi://kind/apps/v1/Deployment/demo/web",
    ]);
    for (const f of found) expect(line.slice(f.start, f.end)).toBe(f.uri);
    expect(findAppLinks("no links here, https://example.com")).toEqual([]);
    // Stops at what a link can't hold.
    expect(findAppLinks("`nauvi://kind/core/v1/Pod/demo/web`")[0].uri).toBe("nauvi://kind/core/v1/Pod/demo/web");
    expect(findAppLinks("nauvi://a%20b/core/v1/Node/_/n1?x=1")[0].uri).toBe("nauvi://a%20b/core/v1/Node/_/n1");
  });

  it("says where a link goes, in printable text", () => {
    expect(describeAppLink("nauvi://kind-nauvi-test/core/v1/Pod/demo/web")).toBe(
      "Open Pod demo/web (kind-nauvi-test) in nauvi",
    );
    expect(describeAppLink("nauvi://a%20b/core/v1/Node/_/n1")).toBe("Open Node n1 (a b) in nauvi");
    expect(describeAppLink("nauvi://x/core/v1/Pod/demo/%E2%80%AEweb")).toBe("Open Pod demo/?web (x) in nauvi");
    expect(describeAppLink("nauvi://short")).toBe("Open in nauvi: nauvi://short");
  });
});
