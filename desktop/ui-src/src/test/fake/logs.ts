// Pod and workload log streams, and saving logs (`commands/logs.rs`).

import { startStream } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function logsHandlers(s: FakeState) {
  return {
    cmdStreamPodLogs: (_namespace, _name, _container, _previous, _tail, _since, _timestamps, id) => startStream(s, id),
    cmdStreamWorkloadLogs: (_kind, _namespace, _name, _options, id) => startStream(s, id),
    cmdStreamPodAllLogs: (_namespace, _name, _options, id) => startStream(s, id),
    cmdStopLogs: (id) => {
      s.logStreams.delete(id);
      return null;
    },
    cmdSaveLogs: (filename) => `/home/tester/Downloads/${filename}`,
  } satisfies AreaHandlers;
}
