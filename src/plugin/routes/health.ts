import { sendJson } from "./tasks";
import type { HttpResponseLike } from "../runtime-types";

export function handleHealthRoute(
  res: HttpResponseLike,
  payload: {
    activeSessions: number;
    maxConcurrentSessions: number;
    acpRuntimeAvailable: boolean;
    dbPath: string;
  },
): void {
  sendJson(res, {
    status: "ok",
    timestamp: Date.now(),
    activeSessions: payload.activeSessions,
    maxConcurrentSessions: payload.maxConcurrentSessions,
    acpRuntimeAvailable: payload.acpRuntimeAvailable,
    dbPath: payload.dbPath,
  });
}
