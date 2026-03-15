#!/bin/bash
# Usage: HEARTBEAT_AGENT_ID=sumodeus HEARTBEAT_STATUS=success ... bash scripts/log-heartbeat.sh

curl -s -X POST http://127.0.0.1:18789/api/heartbeats \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6' \
  -d "{\"agentId\": \"${HEARTBEAT_AGENT_ID}\", \"status\": \"${HEARTBEAT_STATUS}\", \"action\": \"${HEARTBEAT_ACTION}\", \"detail\": \"${HEARTBEAT_DETAIL}\"}"
