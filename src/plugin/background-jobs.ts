export type BackgroundJob = {
  kind: string;
  taskId: string;
};

export function createBackgroundJobQueue<TJob extends BackgroundJob>(params: {
  runJob: (job: TJob) => Promise<void> | void;
  log?: (message: string) => void;
}) {
  const pending: TJob[] = [];
  const inFlightByKind = new Map<string, Set<string>>();
  let draining = false;

  const inFlightSet = (kind: string): Set<string> => {
    const existing = inFlightByKind.get(kind);
    if (existing) return existing;
    const created = new Set<string>();
    inFlightByKind.set(kind, created);
    return created;
  };

  const labelFor = (job: TJob): string => `${job.kind}:${job.taskId}`;

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

    async drainOnce(): Promise<void> {
      if (draining) {
        return;
      }
      draining = true;
      try {
        while (pending.length > 0) {
          const job = pending.shift();
          if (!job) continue;
          try {
            params.log?.(`[QUEUE] running ${labelFor(job)}`);
            await params.runJob(job);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            params.log?.(`[QUEUE] failed ${labelFor(job)}: ${message}`);
          } finally {
            inFlightSet(job.kind).delete(job.taskId);
          }
        }
      } finally {
        draining = false;
      }
    },
  };
}
