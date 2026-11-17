import { describe, expect, it } from "vitest";
import { csvField, csvFilename, savedNote, tableCsv, toCsv } from "./csv";
import { columnsFor, EMPTY_METRICS } from "./columns";
import type { Row } from "./columns";
import type { ResourceKind } from "./bindings";

describe("csvField (#221)", () => {
  it("leaves plain text alone", () => {
    expect(csvField("web-1")).toBe("web-1");
    expect(csvField("")).toBe("");
    expect(csvField("1/2")).toBe("1/2");
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("one\ntwo")).toBe('"one\ntwo"');
    expect(csvField("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it("neutralises cells a spreadsheet would run as a formula", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("\t=1")).toBe("'\t=1");
    expect(csvField("\r=1")).toBe('"\'\r=1"');
    // Prefixed and then quoted: the quote does not hide the formula.
    expect(csvField('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    // Also after leading whitespace, which some spreadsheets trim.
    expect(csvField(" =1")).toBe("' =1");
    expect(csvField("  +1")).toBe("'  +1");
    expect(csvField(' =HYPERLINK("http://x","y")')).toBe('"\' =HYPERLINK(""http://x"",""y"")"');
    expect(csvField("\n=cmd")).toBe("\"'\n=cmd\"");
    expect(csvField("\t")).toBe("'\t");
    // Not when the formula character comes after text.
    expect(csvField("a=1")).toBe("a=1");
    expect(csvField(" a=1")).toBe(" a=1");
  });
});

describe("toCsv", () => {
  it("ends every record with CRLF", () => {
    expect(
      toCsv([
        ["a", "b"],
        ["1", "2"],
      ]),
    ).toBe("a,b\r\n1,2\r\n");
    expect(toCsv([])).toBe("");
  });
});

const col = (key: string, label: string, kind: "text" | "age" = "text") => ({
  key,
  label,
  kind,
  json_path: "",
});

const kindOf = (kind: string, columns: ReturnType<typeof col>[]): ResourceKind =>
  ({
    id: `v1/${kind.toLowerCase()}s`,
    label: `${kind}s`,
    resource: {
      group: "",
      version: "v1",
      kind,
      plural: `${kind.toLowerCase()}s`,
      namespaced: true,
    },
    columns,
    actions: [],
  }) as unknown as ResourceKind;

const rowOf = (name: string, cells: string[], created = 0): Row =>
  ({
    key: `ns/${name}`,
    namespace: "ns",
    name,
    cells,
    created,
    status: "",
    problem: "",
  }) as unknown as Row;

describe("tableCsv", () => {
  it("writes the given columns' labels and the cells as shown, in row order", () => {
    const kind = kindOf("Pod", [col("name", "Name"), col("namespace", "Namespace"), col("status", "Status")]);
    const cols = columnsFor(kind).filter((c) => c.key !== "namespace");
    const csv = tableCsv(cols, [rowOf("b", ["b", "ns", "Running"]), rowOf("a", ["a", "ns", "=cmd"])], {
      metrics: EMPTY_METRICS,
      now: 0,
    });
    expect(csv).toBe("Name,Status\r\nb,Running\r\na,'=cmd\r\n");
  });

  it("writes ages as the table shows them", () => {
    const kind = kindOf("Pod", [col("name", "Name"), col("age", "Age", "age")]);
    const csv = tableCsv(columnsFor(kind), [rowOf("a", ["a", ""], 1000)], {
      metrics: EMPTY_METRICS,
      now: 1_000_000 + 3600_000,
    });
    expect(csv.split("\r\n")[1]).toMatch(/^a,\d+[smhd]/);
  });

  it("exports a Secret's columns only: name, type and key count, never values", () => {
    // The Secrets table's cells (`src/resources/columns.rs`): no data values.
    const kind = kindOf("Secret", [
      col("name", "Name"),
      col("namespace", "Namespace"),
      col("type", "Type"),
      col("data", "Data"),
    ]);
    const csv = tableCsv(columnsFor(kind), [rowOf("db", ["db", "ns", "Opaque", "2"])], {
      metrics: EMPTY_METRICS,
      now: 0,
    });
    expect(csv).toBe("Name,Namespace,Type,Data\r\ndb,ns,Opaque,2\r\n");
  });
});

describe("csvFilename", () => {
  const at = new Date("2026-11-16T10:30:05.123Z");
  it("names the kind, the context and the time", () => {
    expect(csvFilename("Pods", "kind-nauvi-test", at)).toBe("pods_kind-nauvi-test_2026-11-16T10-30-05Z.csv");
  });
  it("replaces characters that are not safe in file names", () => {
    expect(csvFilename("HPAs", "arn:aws:eks:eu/prod", at)).toBe("hpas_arn-aws-eks-eu-prod_2026-11-16T10-30-05Z.csv");
    expect(csvFilename("Pods", "", at)).toBe("pods_2026-11-16T10-30-05Z.csv");
    expect(csvFilename("Pods", "../..", at)).toBe("pods_2026-11-16T10-30-05Z.csv");
  });
});

describe("savedNote", () => {
  it("names the folder and the file", () => {
    expect(savedNote(3, "/home/me/Downloads/pods.csv")).toBe("Saved 3 rows to Downloads/pods.csv");
    expect(savedNote(1, "C:\\Users\\me\\Desktop\\pods.csv")).toBe("Saved 1 row to Desktop/pods.csv");
    expect(savedNote(0, "pods.csv")).toBe("Saved 0 rows to pods.csv");
  });
});
