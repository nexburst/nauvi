import { describe, expect, it } from "vitest";
import { webLink } from "./terminalLinks";

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
