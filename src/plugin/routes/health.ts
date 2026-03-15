import { sendJson } from "./tasks";

export function handleHealthRoute(
  res: any,
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
