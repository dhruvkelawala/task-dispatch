import type { PluginConfig, Task } from "./types";
import type { PreparedStatementLike } from "./runtime-types";
import {
  applyFailedReviewCompletion,
  applySuccessfulReviewCompletion,
  buildReviewTaskDescription,
  buildReviewTaskTitle,
  parseReviewSummary,
  resolveProjectIdForRepo,
  REVIEW_DEBOUNCE_WINDOW_MS,
  shouldAdvanceReviewCursor,
  transitionPendingReviewState,
  type ReviewRequest,
  type ReviewStateRow,
} from "./review";

type ReviewStatements = {
  getReviewStateByRepo: PreparedStatementLike<ReviewStateRow | undefined>;
  getReviewStateByActiveTaskId: PreparedStatementLike<ReviewStateRow | undefined>;
  upsertReviewState: PreparedStatementLike;
  getReviewDeliveryByKey: PreparedStatementLike<ReviewDeliveryRow | undefined>;
  getReviewDeliveryByRepoSha: PreparedStatementLike<ReviewDeliveryRow | undefined>;
  upsertReviewDelivery: PreparedStatementLike;
};

type ActivatedReviewWindow = {
  taskId: string;
  fromSha: string;
  toSha: string;
};

export type ReviewDeliveryRow = {
  delivery_key: string;
  repo: string;
  sha: string;
  task_id: string | null;
  status: string;
  accepted_at: number;
};

type ReviewTaskRecordPayload = {
  title: string;
  description: string;
  agent: string;
  projectId: string;
  cwd: string;
  chainId: string;
  qaRequired: boolean;
};

type ReviewTaskRecordOptions = {
  forceStatus: "pending" | "ready";
  autoDispatchReady: boolean;
  eventPayload: Record<string, unknown>;
};

type ReviewTaskWindowUpdate = {
  title: string;
  description: string;
  projectId: string | null;
  cwd: string | null;
  agent: string;
};

type ReviewRuntimeDeps = {
  config: PluginConfig;
  defaultAgent: string;
  defaultCwd: string;
  reviewTimers: Map<string, ReturnType<typeof setTimeout>>;
  db: {
    prepare: (sql: string) => PreparedStatementLike;
    transaction: <TArgs extends unknown[]>(
      fn: (...args: TArgs) => void,
    ) => (...args: TArgs) => void;
  };
  stmts: ReviewStatements;
  loadTask: (id: string) => Task | null;
  createTaskRecord: (body: ReviewTaskRecordPayload, options: ReviewTaskRecordOptions) => Task;
  recordTaskEvent: (
    taskId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ) => void;
  onTaskChanged: (taskId: string) => void;
  resolveReviewAgentId: (config: PluginConfig, projectId: string, fallbackAgent: string) => string;
};

export function createReviewRuntime(deps: ReviewRuntimeDeps) {
  function getReviewState(repo: string): ReviewStateRow {
    return (
      deps.stmts.getReviewStateByRepo.get(repo) || {
        repo,
        last_reviewed_sha: null,
        last_review_at: null,
        pending_from_sha: null,
        pending_to_sha: null,
        pending_task_id: null,
        pending_updated_at: null,
        active_from_sha: null,
        active_to_sha: null,
        active_task_id: null,
      }
    );
  }

  function saveReviewState(nextState: ReviewStateRow): void {
    deps.stmts.upsertReviewState.run({
      repo: nextState.repo,
      last_reviewed_sha: nextState.last_reviewed_sha || null,
      last_review_at: nextState.last_review_at || null,
      pending_from_sha: nextState.pending_from_sha || null,
      pending_to_sha: nextState.pending_to_sha || null,
      pending_task_id: nextState.pending_task_id || null,
      pending_updated_at: nextState.pending_updated_at || null,
      active_from_sha: nextState.active_from_sha || null,
      active_to_sha: nextState.active_to_sha || null,
      active_task_id: nextState.active_task_id || null,
    });
  }

  function getReviewDelivery(deliveryKey: string): ReviewDeliveryRow | undefined {
    return deps.stmts.getReviewDeliveryByKey.get(deliveryKey);
  }

  function getReviewDeliveryForRepoSha(repo: string, sha: string): ReviewDeliveryRow | undefined {
    return deps.stmts.getReviewDeliveryByRepoSha.get(repo, sha);
  }

  function saveReviewDelivery(delivery: ReviewDeliveryRow): void {
    deps.stmts.upsertReviewDelivery.run({
      delivery_key: delivery.delivery_key,
      repo: delivery.repo,
      sha: delivery.sha,
      task_id: delivery.task_id || null,
      status: delivery.status,
      accepted_at: delivery.accepted_at,
    });
  }

  function extractReviewRangeFromTask(
    taskId: string | null | undefined,
  ): { fromSha: string; toSha: string } | null {
    const task = taskId ? deps.loadTask(taskId) : null;
    const description = task?.description;
    if (typeof description !== "string") {
      return null;
    }
    const match = description.match(/\bRange:\s+([0-9a-f^]+)\.\.([0-9a-f]+)\b/i);
    if (!match) {
      return null;
    }
    return {
      fromSha: match[1]!,
      toSha: match[2]!,
    };
  }

  function updateReviewTaskWindow(taskId: string, payload: ReviewTaskWindowUpdate): void {
    deps.db
      .prepare(
        "UPDATE tasks SET title = @title, description = @description, project_id = @project_id, cwd = @cwd, agent = @agent, updated_at = @updated_at WHERE id = @id",
      )
      .run({
        id: taskId,
        title: payload.title,
        description: payload.description,
        project_id: payload.projectId,
        cwd: payload.cwd,
        agent: payload.agent,
        updated_at: Date.now(),
      });
  }

  function createPendingReviewTask(
    reviewRequest: ReviewRequest,
    projectId: string,
    fromSha: string,
    toSha: string,
  ): Task {
    const project = deps.config.projects?.[projectId] || {};
    const reviewAgent = deps.resolveReviewAgentId(
      deps.config,
      projectId,
      project.defaultAgent || deps.defaultAgent,
    );
    return deps.createTaskRecord(
      {
        title: buildReviewTaskTitle(reviewRequest.repo, toSha),
        description: buildReviewTaskDescription({
          repo: reviewRequest.repo,
          projectId,
          fromSha,
          toSha,
          branch: reviewRequest.branch,
          pusher: reviewRequest.pusher,
          compareUrl: reviewRequest.compareUrl,
        }),
        agent: reviewAgent,
        projectId,
        cwd: project.cwd || deps.defaultCwd,
        chainId: `review:${reviewRequest.repo}`,
        qaRequired: false,
      },
      {
        forceStatus: "pending",
        autoDispatchReady: false,
        eventPayload: {
          reviewRepo: reviewRequest.repo,
          reviewRange: `${fromSha}..${toSha}`,
        },
      },
    );
  }

  function clearReviewTimer(repo: string): void {
    const timer = deps.reviewTimers.get(repo);
    if (timer) {
      clearTimeout(timer);
      deps.reviewTimers.delete(repo);
    }
  }

  function dispatchPendingReview(repo: string): void {
    clearReviewTimer(repo);
    const state = getReviewState(repo);
    const nextState = transitionPendingReviewState(state);
    if (!nextState || !state.pending_task_id || !state.pending_from_sha || !state.pending_to_sha) {
      return;
    }
    const activatedReview: ActivatedReviewWindow = {
      taskId: state.pending_task_id,
      fromSha: state.pending_from_sha,
      toSha: state.pending_to_sha,
    };
    const transition = deps.db.transaction(() => {
      saveReviewState(nextState);
    });
    transition();

    deps.db
      .prepare(
        "UPDATE tasks SET status = 'ready', error = NULL, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: activatedReview.taskId, updated_at: Date.now() });
    deps.recordTaskEvent(activatedReview.taskId, "review.activated", {
      repo,
      reviewRange: `${activatedReview.fromSha}..${activatedReview.toSha}`,
    });
    deps.onTaskChanged(activatedReview.taskId);
  }

  function armReviewTimer(repo: string): void {
    clearReviewTimer(repo);
    const state = getReviewState(repo);
    if (!state.pending_task_id || !state.pending_updated_at) {
      return;
    }
    const dueAt = Number(state.pending_updated_at) + REVIEW_DEBOUNCE_WINDOW_MS;
    const delayMs = Math.max(0, dueAt - Date.now());
    const timer = setTimeout(() => {
      dispatchPendingReview(repo);
    }, delayMs);
    timer.unref?.();
    deps.reviewTimers.set(repo, timer);
  }

  function finalizeReviewTask(task: Task): void {
    const reviewState = deps.stmts.getReviewStateByActiveTaskId.get(task.id);
    if (!reviewState) {
      return;
    }

    const parsedSummary = parseReviewSummary(task.output || "");
    const succeeded = task.status === "done" && shouldAdvanceReviewCursor(parsedSummary);
    const now = Date.now();

    if (succeeded) {
      saveReviewState(applySuccessfulReviewCompletion(reviewState, now));
      deps.recordTaskEvent(task.id, "review.cursor_advanced", {
        repo: reviewState.repo,
        lastReviewedSha: reviewState.active_to_sha,
      });
      if (reviewState.pending_task_id) {
        armReviewTimer(reviewState.repo);
      }
      return;
    }

    const mergedFrom = reviewState.active_from_sha || reviewState.pending_from_sha;
    const mergedTo = reviewState.pending_to_sha || reviewState.active_to_sha;
    let pendingTaskId = reviewState.pending_task_id;

    if (!pendingTaskId && mergedFrom && mergedTo) {
      const projectId = resolveProjectIdForRepo(deps.config, reviewState.repo);
      if (projectId) {
        const retryTask = createPendingReviewTask(
          {
            repo: reviewState.repo,
            beforeSha: mergedFrom,
            sha: mergedTo,
            branch: "main",
            pusher: "system",
            compareUrl: null,
            deliveryKey: `retry:${reviewState.repo}:${mergedTo}:${now}`,
          },
          projectId,
          mergedFrom,
          mergedTo,
        );
        pendingTaskId = retryTask.id;
      }
    }

    if (pendingTaskId && mergedFrom && mergedTo) {
      const projectId = resolveProjectIdForRepo(deps.config, reviewState.repo);
      const project = projectId ? deps.config.projects?.[projectId] || {} : {};
      const reviewAgent = deps.resolveReviewAgentId(
        deps.config,
        projectId || task.projectId || "",
        project.defaultAgent || task.agent || deps.defaultAgent,
      );
      updateReviewTaskWindow(pendingTaskId, {
        title: buildReviewTaskTitle(reviewState.repo, mergedTo),
        description: buildReviewTaskDescription({
          repo: reviewState.repo,
          projectId: projectId || task.projectId || "unknown-project",
          fromSha: mergedFrom,
          toSha: mergedTo,
          branch: "main",
          pusher: "system",
          compareUrl: null,
        }),
        projectId: projectId || task.projectId,
        cwd: project.cwd || task.cwd || deps.defaultCwd,
        agent: reviewAgent,
      });
    }

    const failedState = applyFailedReviewCompletion(reviewState, now);
    saveReviewState({
      ...failedState,
      pending_from_sha: mergedFrom,
      pending_to_sha: mergedTo,
      pending_task_id: pendingTaskId || null,
      pending_updated_at: now,
    });
    deps.recordTaskEvent(task.id, "review.cursor_not_advanced", {
      repo: reviewState.repo,
      status: task.status,
      reviewOutcome: parsedSummary?.reviewOutcome || null,
    });
    if (pendingTaskId) {
      armReviewTimer(reviewState.repo);
    }
  }

  return {
    getReviewState,
    saveReviewState,
    getReviewDelivery,
    getReviewDeliveryForRepoSha,
    saveReviewDelivery,
    extractReviewRangeFromTask,
    updateReviewTaskWindow,
    createPendingReviewTask,
    clearReviewTimer,
    dispatchPendingReview,
    armReviewTimer,
    finalizeReviewTask,
  };
}
