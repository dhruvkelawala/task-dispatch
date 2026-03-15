#!/bin/bash
# Usage: DISPATCH_API_KEY=... HEARTBEAT_AGENT_ID=sumodeus HEARTBEAT_STATUS=success ... bash scripts/log-heartbeat.sh

if [ -z "${DISPATCH_API_KEY}" ]; then
  echo "DISPATCH_API_KEY is required"
  exit 1
fi

curl -s -X POST http://127.0.0.1:18789/api/heartbeats \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: ${DISPATCH_API_KEY}" \
  -d "{\"agentId\": \"${HEARTBEAT_AGENT_ID}\", \"status\": \"${HEARTBEAT_STATUS}\", \"action\": \"${HEARTBEAT_ACTION}\", \"detail\": \"${HEARTBEAT_DETAIL}\"}"
