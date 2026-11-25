import { describe, expect, it } from "vitest";
import { parseRawUpload, rawText, rawUpload } from "./rawIpc";

describe("raw IPC text", () => {
  it("decodes a raw reply, multi-byte characters included", () => {
    const bytes = new TextEncoder().encode("kind: Pod\nname: ü-€\n");
    expect(rawText(bytes.buffer)).toBe("kind: Pod\nname: ü-€\n");
    expect(rawText(bytes)).toBe("kind: Pod\nname: ü-€\n");
    expect(rawText("as json")).toBe("as json");
    expect(rawText(new ArrayBuffer(0))).toBe("");
  });

  it("decodes the byte array a postMessage fallback delivers", () => {
    const bytes = Array.from(new TextEncoder().encode("kind: Pod\nname: ü-€\n"));
    expect(rawText(bytes)).toBe("kind: Pod\nname: ü-€\n");
    expect(rawText([])).toBe("");
  });

  it("sends the head on the first line and the body after it", () => {
    const up = rawUpload("web_app.log", "line 1\nline ü\n");
    expect(new TextDecoder().decode(up)).toBe("web_app.log\nline 1\nline ü\n");
    expect(parseRawUpload(up)).toEqual({ head: "web_app.log", body: "line 1\nline ü\n" });
  });

  it("keeps the head on one line", () => {
    expect(parseRawUpload(rawUpload("a\nb\r.log", "x"))).toEqual({ head: "a_b_.log", body: "x" });
    expect(parseRawUpload(rawUpload("empty.log", ""))).toEqual({ head: "empty.log", body: "" });
  });
});
