import { sendError, sendJson } from "./tasks";

export function handleSchedulesNotImplemented(res: any): void {
  sendError(res, 501, "Schedules route wiring happens in plugin index");
}

export function listSchedules(rows: unknown[]): unknown[] {
  return rows;
}

export function ok(res: any, payload: unknown): void {
  sendJson(res, payload, 200);
}
