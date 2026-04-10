import { sendError, sendJson } from "./tasks";
import type { HttpResponseLike } from "../runtime-types";

export function handleSchedulesNotImplemented(res: HttpResponseLike): void {
  sendError(res, 501, "Schedules route wiring happens in plugin index");
}

export function listSchedules(rows: unknown[]): unknown[] {
  return rows;
}

export function ok(res: HttpResponseLike, payload: unknown): void {
  sendJson(res, payload, 200);
}
