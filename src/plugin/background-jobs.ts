export type BackgroundJob = {
  kind: string;
  taskId: string;
};

type RunningJob<TJob extends BackgroundJob> = {
  job: TJob;
  label: string;
  startedAt: number;
  cancelled?: boolean;
};

export function createBackgroundJobQueue<TJob extends BackgroundJob>(params: {
  runJob: (job: TJob) => Promise<void> | void;
  log?: (message: string) => void;
  maxConcurrentJobs?: number;
  timeoutMs?: number | ((job: TJob) => number);
}) {
  const pending: TJob[] = [];
  const inFlightByKind = new Map<string, Set<string>>();
  const running = new Map<string, RunningJob<TJob>>();
  const runningPromises = new Map<string, Promise<void>>();
  const abortControllers = new Map<string, AbortController>();
  const maxConcurrentJobs = Math.max(1, Math.floor(params.maxConcurrentJobs ?? 3));
  let drainingPromise: Promise<void> | null = null;

  const inFlightSet = (kind: string): Set<string> => {
    const existing = inFlightByKind.get(kind);
    if (existing) return existing;
    const created = new Set<string>();
    inFlightByKind.set(kind, created);
    return created;
  };

  const labelFor = (job: TJob): string => `${job.kind}:${job.taskId}`;
  const timeoutFor = (job: TJob): number => {
    const configured =
      typeof params.timeoutMs === "function" ? params.timeoutMs(job) : params.timeoutMs;
    return Math.max(1_000, Math.floor(configured ?? 5 * 60_000));
  };

  const finish = (job: TJob, label: string): void => {
    running.delete(label);
    runningPromises.delete(label);
    abortControllers.delete(label);
    inFlightSet(job.kind).delete(job.taskId);
  };

  const runWithTimeout = async (job: TJob, label: string): Promise<void> => {
    const timeoutMs = timeoutFor(job);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const entry = running.get(label);
    try {
      params.log?.(`[QUEUE] running ${label}`);
      await Promise.race([
        Promise.resolve(params.runJob(job)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`background job timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
      params.log?.(`[QUEUE] completed ${label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wasCancelled = entry?.cancelled;
      params.log?.(`[QUEUE] ${wasCancelled ? "cancelled" : "failed"} ${label}: ${message}`);
    } finally {
      if (timeout) clearTimeout(timeout);
      finish(job, label);
    }
  };

  function startAvailableJobs(): void {
    while (pending.length > 0 && running.size < maxConcurrentJobs) {
      const job = pending.shift();
      if (!job) continue;
      const label = labelFor(job);
      if (running.has(label)) continue;
      running.set(label, { job, label, startedAt: Date.now() });
      const promise = runWithTimeout(job, label);
      runningPromises.set(label, promise);
    }
  }

  async function drainLoop(): Promise<void> {
    while (pending.length > 0 || running.size > 0) {
      startAvailableJobs();
      const active = Array.from(runningPromises.values());
      if (active.length === 0) break;
      await Promise.race(active);
    }
  }

  function drainOnce(): Promise<void> {
    if (!drainingPromise) {
      drainingPromise = drainLoop().finally(() => {
        drainingPromise = null;
      });
    }
    return drainingPromise;
  }

  function cancel(taskId: string, kind?: string): boolean {
    // Find and remove from pending
    for (let idx = pending.length - 1; idx >= 0; idx -= 1) {
      const job = pending[idx];
      if (job?.taskId === taskId && (!kind || job.kind === kind)) {
        pending.splice(idx, 1);
        inFlightSet(job.kind).delete(taskId);
        params.log?.(`[QUEUE] cancelled pending ${labelFor(job)}`);
        return true;
      }
    }

    // Find and flag running job
    for (const [label, entry] of running) {
      if (entry.job.taskId === taskId && (!kind || entry.job.kind === kind)) {
        entry.cancelled = true;
        const ac = abortControllers.get(label);
        if (ac) ac.abort();
        params.log?.(`[QUEUE] cancelling running ${label}`);
        // Don't call finish here — runWithTimeout will do it in its finally block
        return true;
      }
    }

    // Clean up in-flight set even if not found in running/pending
    if (kind) {
      inFlightSet(kind).delete(taskId);
    } else {
      for (const set of inFlightByKind.values()) {
        set.delete(taskId);
      }
    }
    return false;
  }

  function forceDrain(): { cancelled: string[]; drained: number } {
    const cancelled: string[] = [];
    const now = Date.now();

    // Cancel running jobs that exceeded their timeout
    for (const [label, entry] of running) {
      const elapsed = now - entry.startedAt;
      const timeout = timeoutFor(entry.job);
      if (elapsed > timeout) {
        entry.cancelled = true;
        const ac = abortControllers.get(label);
        if (ac) ac.abort();
        cancelled.push(label);
        params.log?.(
          `[QUEUE] force-cancelled overdue ${label} (${Math.round(elapsed / 1000)}s > ${Math.round(timeout / 1000)}s)`,
        );
      }
    }

    // Drain pending
    const before = pending.length;
    void drainOnce();
    return { cancelled, drained: before - pending.length };
  }

  return {
    enqueue(job: TJob): boolean {
      const inFlight = inFlightSet(job.kind);
      if (inFlight.has(job.taskId)) {
        return false;
      }
      inFlight.add(job.taskId);
      pending.push(job);
      params.log?.(`[QUEUE] queued ${labelFor(job)}`);
      return true;
    },

    clear(job: Pick<TJob, "kind" | "taskId">): void {
      inFlightSet(job.kind).delete(job.taskId);
      for (let idx = pending.length - 1; idx >= 0; idx -= 1) {
        const queued = pending[idx];
        if (queued?.kind === job.kind && queued.taskId === job.taskId) {
          pending.splice(idx, 1);
        }
      }
    },

    cancel,

    forceDrain,

    drainOnce,

    getAbortController(taskId: string): AbortController | undefined {
      for (const [label, entry] of running) {
        if (entry.job.taskId === taskId) {
          let ac = abortControllers.get(label);
          if (!ac) {
            ac = new AbortController();
            abortControllers.set(label, ac);
          }
          return ac;
        }
      }
      return undefined;
    },

    status() {
      const now = Date.now();
      return {
        pending: pending.map((job) => ({ ...job, label: labelFor(job) })),
        running: Array.from(running.values()).map((entry) => ({
          kind: entry.job.kind,
          taskId: entry.job.taskId,
          label: entry.label,
          startedAt: entry.startedAt,
          ageMs: now - entry.startedAt,
          cancelled: entry.cancelled || false,
        })),
        maxConcurrentJobs,
      };
    },
  };
}
