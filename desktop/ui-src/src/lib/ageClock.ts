// One shared once-a-second timer for ages (#380): the live tables and the
// detail panel subscribe, and each decides with `ageRedrawMs` whether its
// ages need redrawing. The timer runs only while someone listens.

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Call `fn` every second with the time; returns the unsubscribe function. */
export function onAgeTick(fn: Listener): () => void {
  listeners.add(fn);
  timer ??= setInterval(() => {
    const now = Date.now();
    for (const l of listeners) l(now);
  }, 1000);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Whether the shared timer is running (for tests). */
export function ageTickRunning(): boolean {
  return timer !== null;
}
