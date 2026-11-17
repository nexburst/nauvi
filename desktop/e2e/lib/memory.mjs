// Memory of the app's processes, read from /proc (Linux): for the
// idle-memory scenario (#341, #353).

import { readdirSync, readFileSync } from "node:fs";

/** kB from a "Name:   1234 kB" line of a /proc file, or 0. */
function kb(path, field) {
  try {
    const m = readFileSync(path, "utf8").match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** pid -> parent pid for every process. */
function parents() {
  const map = new Map();
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      // The comm field may hold spaces and parentheses: split after the last ")".
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      map.set(Number(pid), ppid);
    } catch {
      /* gone */
    }
  }
  return map;
}

/** `root` and all its descendants. */
function tree(root) {
  const ppid = parents();
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const [pid, parent] of ppid) if (parent === out[i]) out.push(pid);
  }
  return out;
}

/** RSS and PSS (kB) of the app's processes, grouped by kind. */
export function measure(root) {
  const groups = { core: [], web: [], network: [], other: [] };
  for (const pid of tree(root)) {
    let comm;
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      continue;
    }
    const p = { pid, comm, rss: kb(`/proc/${pid}/status`, "VmRSS"), pss: kb(`/proc/${pid}/smaps_rollup`, "Pss") };
    // comm is cut at 15 characters: WebKitWebProces, WebKitNetworkPr.
    if (pid === root) groups.core.push(p);
    else if (comm.startsWith("WebKitWebProc")) groups.web.push(p);
    else if (comm.startsWith("WebKitNetwork")) groups.network.push(p);
    else groups.other.push(p);
  }
  const sum = (list, key) => list.reduce((n, p) => n + p[key], 0);
  const row = (list) => ({ rss: sum(list, "rss"), pss: sum(list, "pss"), count: list.length });
  const all = Object.values(groups).flat();
  return {
    core: row(groups.core),
    web: row(groups.web),
    network: row(groups.network),
    other: row(groups.other),
    coreAndWeb: row([...groups.core, ...groups.web]),
    total: row(all),
    processes: all,
  };
}

/**
 * The biggest mappings of `pid` by RSS, grouped by backing file (anonymous
 * memory by permissions): where the memory is, for #353. kB.
 */
export function topMappings(pid, n = 12) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/smaps`, "utf8");
  } catch {
    return [];
  }
  const groups = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^[0-9a-f]+-[0-9a-f]+ (\S+) \S+ \S+ \S+\s*(.*)$/);
    if (head) {
      const file = head[2].trim();
      const name = file ? file.split("/").pop() : `[anon ${head[1]}]`;
      cur = groups.get(name) ?? { name, rss: 0, pss: 0, maps: 0 };
      cur.maps++;
      groups.set(name, cur);
      continue;
    }
    const field = line.match(/^(Rss|Pss):\s+(\d+) kB/);
    if (field && cur) cur[field[1].toLowerCase()] += Number(field[2]);
  }
  return [...groups.values()].sort((a, b) => b.rss - a.rss).slice(0, n);
}
