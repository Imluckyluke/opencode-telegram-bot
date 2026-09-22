import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatAssistantRunFooter } from "../formatters/assistant-run-footer-formatter.js";
import { executeScheduledTask } from "./scheduled-task-executor-service.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { cleanupScheduledTaskSessionIgnores } from "./scheduled-task-session-ignore-service.js";
import { computeNextRunAt, isTaskDue } from "./scheduled-task-next-run-service.js";
import {
  getScheduledTask,
  listScheduledTasks,
  removeScheduledTask,
  replaceScheduledTasks,
  updateScheduledTask,
} from "../stores/scheduled-task-store.js";
import type { QueuedScheduledTaskDelivery, ScheduledTask } from "../types/scheduled-task.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TASK_DESCRIPTION_PREVIEW_LENGTH = 64;
const RESTART_INTERRUPTED_ERROR = "Interrupted by bot restart during scheduled task execution.";
const MAX_DEFERRED_DELIVERIES = 50;

export interface ScheduledTaskDeliverySender {
  send(delivery: QueuedScheduledTaskDelivery): Promise<boolean>;
}

function normalizeTaskPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= TASK_DESCRIPTION_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, TASK_DESCRIPTION_PREVIEW_LENGTH)}...`;
}

function calculateElapsedMs(startedAt: string, finishedAt: string): number {
  const startedAtMs = Date.parse(startedAt);
  const finishedAtMs = Date.parse(finishedAt);

  if (Number.isNaN(startedAtMs) || Number.isNaN(finishedAtMs)) {
    return 0;
  }

  return finishedAtMs - startedAtMs;
}

function buildSuccessDelivery(
  task: ScheduledTask,
  startedAt: string,
  runAt: string,
  resultText: string,
): QueuedScheduledTaskDelivery {
  return {
    taskId: task.id,
    scheduleSummary: task.scheduleSummary,
    prompt: task.prompt,
    runAt,
    status: "success",
    notificationText: t("task.run.success", {
      description: normalizeTaskPrompt(task.prompt),
    }),
    resultText,
    footerText: formatAssistantRunFooter({
      agent: task.agent,
      providerID: task.model.providerID,
      modelID: task.model.modelID,
      elapsedMs: calculateElapsedMs(startedAt, runAt),
    }),
  };
}

function buildErrorDelivery(
  task: ScheduledTask,
  runAt: string,
  errorMessage: string,
): QueuedScheduledTaskDelivery {
  return {
    taskId: task.id,
    scheduleSummary: task.scheduleSummary,
    prompt: task.prompt,
    runAt,
    status: "error",
    notificationText: t("task.run.error", {
      description: normalizeTaskPrompt(task.prompt),
      error: errorMessage,
    }),
  };
}

export class ScheduledTaskRuntime {
  private botApi: Bot<Context>["api"] | null = null;
  private chatId: number | null = null;
  private deliverySender: ScheduledTaskDeliverySender | null = null;
  private initialized = false;
  private timersByTaskId = new Map<string, ReturnType<typeof setTimeout>>();
  private runningTaskIds = new Set<string>();
  private cancelledTaskIds = new Set<string>();
  private deliveryQueue: QueuedScheduledTaskDelivery[] = [];
  private flushInProgress = false;

  async initialize(bot: Bot<Context>, deliverySender?: ScheduledTaskDeliverySender): Promise<void> {
    this.botApi = bot.api;
    this.chatId = config.telegram.allowedUserId;
    this.deliverySender = deliverySender ?? null;

    if (this.initialized) {
      return;
    }

    this.initialized = true;
    await cleanupScheduledTaskSessionIgnores();
    await this.recoverTasksOnStartup();
    await this.flushDeferredDeliveries();
  }

  registerTask(task: ScheduledTask): void {
    if (!this.initialized) {
      return;
    }

    this.scheduleTask(task);
  }

  removeTask(taskId: string): void {
    // User-initiated removal: in-flight runs must stop and stay silent.
    // Internal bookkeeping uses removeTaskState so normal completion still delivers.
    this.cancelledTaskIds.add(taskId);
    this.removeTaskState(taskId);
  }

  private removeTaskState(taskId: string): void {
    const timer = this.timersByTaskId.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timersByTaskId.delete(taskId);
    }

    this.runningTaskIds.delete(taskId);
    this.deliveryQueue = this.deliveryQueue.filter((delivery) => delivery.taskId !== taskId);
  }

  async flushDeferredDeliveries(): Promise<void> {
    if (
      this.flushInProgress ||
      !this.botApi ||
      this.chatId === null ||
      foregroundSessionState.isBusy() ||
      this.deliveryQueue.length === 0
    ) {
      return;
    }

    this.flushInProgress = true;

    try {
      // Attempt every queued delivery: one failing recipient must not
      // head-of-line-block the rest. Failures are requeued for a later flush.
      const failed: QueuedScheduledTaskDelivery[] = [];
      while (this.deliveryQueue.length > 0 && !foregroundSessionState.isBusy()) {
        const nextDelivery = this.deliveryQueue.shift();
        if (!nextDelivery) {
          break;
        }
        const sent = await this.sendDelivery(nextDelivery);
        if (!sent) {
          failed.push(nextDelivery);
        }
      }
      if (failed.length > 0) {
        this.deliveryQueue.push(...failed);
      }
    } finally {
      this.flushInProgress = false;
    }
  }

  shutdown(): void {
    for (const timer of this.timersByTaskId.values()) {
      clearTimeout(timer);
    }

    // In-flight runs are abandoned: their late completions must neither
    // reschedule (blocked via initialized) nor notify.
    for (const taskId of this.runningTaskIds) {
      this.cancelledTaskIds.add(taskId);
    }

    this.timersByTaskId.clear();
    this.runningTaskIds.clear();
    this.initialized = false;
  }

  __resetForTests(): void {
    for (const timer of this.timersByTaskId.values()) {
      clearTimeout(timer);
    }

    this.botApi = null;
    this.chatId = null;
    this.deliverySender = null;
    this.initialized = false;
    this.timersByTaskId.clear();
    this.runningTaskIds.clear();
    this.cancelledTaskIds.clear();
    this.deliveryQueue = [];
    this.flushInProgress = false;
  }

  private async recoverTasksOnStartup(): Promise<void> {
    const tasks = listScheduledTasks();
    if (tasks.length === 0) {
      return;
    }

    const now = new Date();
    let hasChanges = false;
    const normalizedTasks = tasks.map((task) => {
      const normalizedTask: ScheduledTask = { ...task, model: { ...task.model } };

      if (normalizedTask.lastStatus === "running") {
        normalizedTask.lastStatus = "error";
        normalizedTask.lastError = RESTART_INTERRUPTED_ERROR;
        if (normalizedTask.kind === "once") {
          // A one-time task interrupted mid-run may have partially executed:
          // keep the visible error and do NOT silently retry on boot.
          normalizedTask.nextRunAt = null;
        }
        hasChanges = true;
      }

      if (normalizedTask.kind === "cron") {
        if (!normalizedTask.nextRunAt || Number.isNaN(Date.parse(normalizedTask.nextRunAt))) {
          try {
            normalizedTask.nextRunAt = computeNextRunAt(normalizedTask, now);
          } catch (error) {
            logger.error(
              `[ScheduledTaskRuntime] Failed to recover next run for cron task: id=${normalizedTask.id}`,
              error,
            );
            normalizedTask.nextRunAt = null;
            normalizedTask.lastStatus = "error";
            normalizedTask.lastError =
              normalizedTask.lastError || "Failed to recover cron schedule.";
          }
          hasChanges = true;
        }
      } else {
        const runAtMs = Date.parse(normalizedTask.runAt);
        if (Number.isNaN(runAtMs)) {
          normalizedTask.nextRunAt = null;
          normalizedTask.lastStatus = "error";
          normalizedTask.lastError =
            normalizedTask.lastError || "Invalid one-time task runAt value.";
          hasChanges = true;
        } else if (normalizedTask.nextRunAt === null && normalizedTask.lastStatus === "idle") {
          normalizedTask.nextRunAt = new Date(runAtMs).toISOString();
          hasChanges = true;
        }
      }

      return normalizedTask;
    });

    if (hasChanges) {
      await replaceScheduledTasks(normalizedTasks);
    }

    for (const task of normalizedTasks) {
      this.scheduleTask(task);
    }
  }

  private scheduleTask(task: ScheduledTask): void {
    this.removeTaskTimer(task.id);

    // Never arm timers after shutdown: executions finishing late must not
    // resurrect scheduling. recoverTasksOnStartup runs while initialized.
    if (!this.initialized) {
      return;
    }

    if (!task.nextRunAt) {
      return;
    }

    const nextRunAtMs = Date.parse(task.nextRunAt);
    if (Number.isNaN(nextRunAtMs)) {
      logger.warn(
        `[ScheduledTaskRuntime] Invalid nextRunAt: id=${task.id}, value=${task.nextRunAt}`,
      );
      return;
    }

    const delayMs = nextRunAtMs - Date.now();
    if (delayMs <= 0) {
      this.startExecution(task.id);
      return;
    }

    const timeoutMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.timersByTaskId.delete(task.id);
      const currentTask = getScheduledTask(task.id);
      if (!currentTask) {
        return;
      }

      if (isTaskDue(currentTask)) {
        this.startExecution(task.id);
        return;
      }

      this.scheduleTask(currentTask);
    }, timeoutMs);

    this.timersByTaskId.set(task.id, timer);
  }

  private removeTaskTimer(taskId: string): void {
    const timer = this.timersByTaskId.get(taskId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.timersByTaskId.delete(taskId);
  }

  private startExecution(taskId: string): void {
    if (this.runningTaskIds.has(taskId)) {
      return;
    }

    const task = getScheduledTask(taskId);
    if (!task) {
      this.removeTaskState(taskId);
      return;
    }

    if (!isTaskDue(task)) {
      this.scheduleTask(task);
      return;
    }

    this.runningTaskIds.add(taskId);
    safeBackgroundTask({
      taskName: `scheduledTask.run.${taskId}`,
      task: async () => {
        await this.executeTask(taskId);
      },
      onError: (error) => {
        logger.error(`[ScheduledTaskRuntime] Scheduled task run crashed: id=${taskId}`, error);
        this.runningTaskIds.delete(taskId);
      },
    });
  }

  private async executeTask(taskId: string): Promise<void> {
    const taskSnapshot = getScheduledTask(taskId);
    if (!taskSnapshot) {
      this.removeTaskState(taskId);
      this.runningTaskIds.delete(taskId);
      return;
    }

    const startedAt = new Date().toISOString();
    let runningTask: ScheduledTask | null;
    try {
      runningTask = await updateScheduledTask(taskId, (task) => ({
        ...task,
        lastStatus: "running",
        lastError: null,
        lastRunAt: startedAt,
        runCount: task.runCount + 1,
      }));
    } catch (error) {
      // A failed store write must not strand the task in "running" with no
      // timer: drop the run and re-arm so it fires again later.
      logger.error(`[ScheduledTaskRuntime] Failed to mark task as running: id=${taskId}`, error);
      this.runningTaskIds.delete(taskId);
      const retryTask = getScheduledTask(taskId);
      if (retryTask) {
        this.scheduleTask(retryTask);
      }
      return;
    }

    if (!runningTask) {
      this.removeTaskState(taskId);
      this.runningTaskIds.delete(taskId);
      return;
    }

    try {
      const result = await executeScheduledTask(runningTask, {
        shouldCancel: () => this.cancelledTaskIds.has(taskId),
      });

      if (this.cancelledTaskIds.delete(taskId)) {
        // Removed or shut down mid-run: stay silent, no reschedule, no delivery.
        this.removeTaskState(taskId);
        return;
      }

      if (result.status === "success") {
        await this.handleSuccessfulExecution(
          runningTask,
          result.startedAt,
          result.finishedAt,
          result.resultText || "",
        );
      } else {
        await this.handleFailedExecution(
          runningTask,
          result.finishedAt,
          result.errorMessage || "Unknown error",
        );
      }
    } finally {
      this.runningTaskIds.delete(taskId);
    }
  }

  private async handleSuccessfulExecution(
    task: ScheduledTask,
    startedAt: string,
    finishedAt: string,
    resultText: string,
  ): Promise<void> {
    const delivery = buildSuccessDelivery(task, startedAt, finishedAt, resultText);

    if (task.kind === "once") {
      await removeScheduledTask(task.id);
      this.removeTaskState(task.id);
      await this.enqueueDelivery(delivery);
      return;
    }

    let nextRunAt: string | null;
    try {
      nextRunAt = computeNextRunAt(task, new Date(finishedAt));
    } catch (error) {
      logger.error(
        `[ScheduledTaskRuntime] Failed to compute next run after success: id=${task.id}`,
        error,
      );
      nextRunAt = null;
    }

    const updatedTask = await updateScheduledTask(task.id, (currentTask) => ({
      ...currentTask,
      lastStatus: "success",
      lastError: null,
      nextRunAt,
    }));

    if (updatedTask) {
      this.scheduleTask(updatedTask);
    }

    await this.enqueueDelivery(delivery);
  }

  private async handleFailedExecution(
    task: ScheduledTask,
    finishedAt: string,
    errorMessage: string,
  ): Promise<void> {
    const delivery = buildErrorDelivery(task, finishedAt, errorMessage);

    let nextRunAt: string | null = null;
    if (task.kind === "cron") {
      try {
        nextRunAt = computeNextRunAt(task, new Date(finishedAt));
      } catch (error) {
        logger.error(
          `[ScheduledTaskRuntime] Failed to compute next run after error: id=${task.id}`,
          error,
        );
      }
    }

    const updatedTask = await updateScheduledTask(task.id, (currentTask) => ({
      ...currentTask,
      lastStatus: "error",
      lastError: errorMessage,
      nextRunAt,
    }));

    if (updatedTask) {
      this.scheduleTask(updatedTask);
    }

    await this.enqueueDelivery(delivery);
  }

  private async enqueueDelivery(delivery: QueuedScheduledTaskDelivery): Promise<void> {
    // A flush in progress owns the send order: just append so deliveries stay ordered.
    if (this.flushInProgress) {
      this.pushDelivery(delivery);
      return;
    }

    if (
      this.deliveryQueue.length === 0 &&
      !foregroundSessionState.isBusy() &&
      (await this.sendDelivery(delivery))
    ) {
      return;
    }

    this.pushDelivery(delivery);
  }

  private pushDelivery(delivery: QueuedScheduledTaskDelivery): void {
    if (this.deliveryQueue.length >= MAX_DEFERRED_DELIVERIES) {
      const dropped = this.deliveryQueue.shift();
      logger.warn(
        `[ScheduledTaskRuntime] Deferred delivery queue full, dropping oldest: id=${dropped?.taskId}, status=${dropped?.status}`,
      );
    }

    this.deliveryQueue.push(delivery);
  }

  private async sendDelivery(delivery: QueuedScheduledTaskDelivery): Promise<boolean> {
    if (!this.botApi || this.chatId === null) {
      return false;
    }

    try {
      if (this.deliverySender) {
        return await this.deliverySender.send(delivery);
      }

      await this.botApi.sendMessage(this.chatId, delivery.notificationText);

      return true;
    } catch (error) {
      logger.error(
        `[ScheduledTaskRuntime] Failed to send delivery: id=${delivery.taskId}, status=${delivery.status}`,
        error,
      );
      return false;
    }
  }
}

export const scheduledTaskRuntime = new ScheduledTaskRuntime();
