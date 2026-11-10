type Finish = () => void;
type Waiter = (finish: Finish) => void;

// One process-wide SQL worker; tabs can enqueue runs without blocking each
// other's editor or result grid.
export function createSqlRunQueue() {
  let running = false;
  const waiters = new Set<Waiter>();
  function finish() {
    const next = waiters.values().next().value;
    if (next) {
      waiters.delete(next);
      next(finish);
    } else {
      running = false;
    }
  }
  return {
    get busy() {
      return running;
    },
    enter(signal: AbortSignal): Promise<Finish> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (!running) {
        running = true;
        return Promise.resolve(finish);
      }
      return new Promise((resolve, reject) => {
        const acquire: Waiter = (release) => {
          signal.removeEventListener("abort", abort);
          resolve(release);
        };
        const abort = () => {
          waiters.delete(acquire);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        waiters.add(acquire);
      });
    },
  };
}

export type SqlRunQueue = ReturnType<typeof createSqlRunQueue>;
