#!/bin/sh
# Dockhand Self-Update Sidecar
# Dockhand pre-creates the new container. This script just does:
#   stop old → rm old → rename new → connect networks → start → verify
#
# Required env vars:
#   OLD_CONTAINER_ID   - Container ID of the running Dockhand to replace
#   NEW_CONTAINER_ID   - Container ID of the pre-created replacement
#   CONTAINER_NAME     - Original container name to restore after rename
#   NETWORKS           - Space-separated network names (optional)
#   NETWORK_OPTS_<net> - Per-network flags for docker network connect (optional)
#
# Optional:
#   STOP_TIMEOUT       - Timeout for stopping container (default: 30)
#
# Rollback mode (ROLLBACK=1, used for remote Hawser agents):
#   stop old → rename old aside → rename new → connect networks → start → verify
#   → remove old. If verification fails, the new container is removed and the old
#   one is renamed back and restarted.
#   VERIFY_TIMEOUT     - Seconds to wait for the new container to verify (default: 90)
#   VERIFY_SETTLE      - Seconds to wait after start before the first check (default: 5)
#   VERIFY_INTERVAL    - Seconds between checks (default: 3)
#   VERIFY_EXEC        - Command run in the new container via `docker exec sh -c`;
#                        must exit 0 for the container to count as verified (optional)
#   Exit codes: 0 updated, 1 failed before anything changed, 2 rolled back,
#               3 rollback failed (manual intervention required)

set -e

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
error() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >&2; }

[ -z "$OLD_CONTAINER_ID" ] && { error "OLD_CONTAINER_ID not set"; exit 1; }
[ -z "$NEW_CONTAINER_ID" ] && { error "NEW_CONTAINER_ID not set"; exit 1; }
[ -z "$CONTAINER_NAME" ]   && { error "CONTAINER_NAME not set"; exit 1; }

STOP_TIMEOUT="${STOP_TIMEOUT:-30}"

connect_networks() {
    [ -n "$NETWORKS" ] || return 0
    for NET in $NETWORKS; do
        OPTS_VAR="NETWORK_OPTS_$(echo "$NET" | tr '.-' '__')"
        OPTS=$(eval echo "\$$OPTS_VAR" 2>/dev/null || true)
        log "Connecting to network $NET ${OPTS:+($OPTS)}"
        # shellcheck disable=SC2086
        docker network connect $OPTS "$NET" "$1" || log "  Warning: failed to connect to $NET"
    done
    log "Networks connected"
}

if [ "$ROLLBACK" = "1" ]; then
    PREVIOUS_NAME="${CONTAINER_NAME}-previous"
    VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-90}"
    VERIFY_SETTLE="${VERIFY_SETTLE:-5}"
    VERIFY_INTERVAL="${VERIFY_INTERVAL:-3}"
    OLD_RENAMED=0

    # Restore the old container and exit 2, or exit 3 if that fails too
    rollback() {
        trap - EXIT
        log "Rolling back to the previous container..."
        log "Last log lines of the new container:"
        docker logs --tail 50 "$NEW_CONTAINER_ID" 2>&1 | sed 's/^/  [new] /' || true
        docker rm -f "$NEW_CONTAINER_ID" >/dev/null 2>&1 || true

        if [ "$OLD_RENAMED" = "1" ] && ! docker rename "$OLD_CONTAINER_ID" "$CONTAINER_NAME"; then
            error "Rollback failed: manual intervention required. The previous container is ${OLD_CONTAINER_ID:0:12} ($PREVIOUS_NAME)"
            exit 3
        fi
        if ! docker start "$OLD_CONTAINER_ID" >/dev/null; then
            error "Rollback failed: manual intervention required. Could not start the previous container ${OLD_CONTAINER_ID:0:12} ($PREVIOUS_NAME)"
            exit 3
        fi
        log "Rolled back: previous container is running again"
        exit 2
    }

    # Succeeds once the new container is running without restarts, healthy (if it
    # has a health check) and VERIFY_EXEC (if set) passes; fails when it is not
    # running, unhealthy, or VERIFY_TIMEOUT runs out.
    verify() {
        sleep "$VERIFY_SETTLE"
        DEADLINE=$(( $(date +%s) + VERIFY_TIMEOUT ))
        while :; do
            STATE=$(docker inspect -f '{{.State.Status}}' "$NEW_CONTAINER_ID" 2>/dev/null || echo "missing")
            RESTARTS=$(docker inspect -f '{{.RestartCount}}' "$NEW_CONTAINER_ID" 2>/dev/null || echo "0")
            if [ "$STATE" != "running" ] || [ "$RESTARTS" != "0" ]; then
                error "Container state: $STATE, restarts: $RESTARTS (expected running, 0)"
                return 1
            fi
            HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NEW_CONTAINER_ID" 2>/dev/null || true)
            if [ "$HEALTH" = "unhealthy" ]; then
                error "Container reported unhealthy"
                return 1
            fi
            if [ -z "$HEALTH" ] || [ "$HEALTH" = "healthy" ]; then
                if [ -z "$VERIFY_EXEC" ] || docker exec "$NEW_CONTAINER_ID" sh -c "$VERIFY_EXEC" >/dev/null 2>&1; then
                    return 0
                fi
            fi
            if [ "$(date +%s)" -ge "$DEADLINE" ]; then
                error "Verification timed out after ${VERIFY_TIMEOUT}s (health: ${HEALTH:-none})"
                return 1
            fi
            sleep "$VERIFY_INTERVAL"
        done
    }

    log "Starting update of $CONTAINER_NAME (rollback enabled)"
    log "  Old: ${OLD_CONTAINER_ID:0:12}, New: ${NEW_CONTAINER_ID:0:12}, Name: $CONTAINER_NAME"

    log "Stopping container (timeout: ${STOP_TIMEOUT}s)..."
    docker stop -t "$STOP_TIMEOUT" "$OLD_CONTAINER_ID" >/dev/null || { error "Failed to stop container"; exit 1; }
    log "Container stopped"

    # From here on the old container is down, so any unexpected exit must restore it
    trap rollback EXIT

    log "Renaming old container to $PREVIOUS_NAME..."
    docker rename "$OLD_CONTAINER_ID" "$PREVIOUS_NAME" || { error "Failed to rename old container"; rollback; }
    OLD_RENAMED=1
    log "Old container kept as $PREVIOUS_NAME"

    log "Renaming container..."
    docker rename "$NEW_CONTAINER_ID" "$CONTAINER_NAME" || { error "Failed to rename container"; rollback; }
    log "Container renamed to $CONTAINER_NAME"

    connect_networks "$NEW_CONTAINER_ID"

    log "Starting container..."
    docker start "$NEW_CONTAINER_ID" >/dev/null || { error "Failed to start container"; rollback; }
    log "Container started"

    log "Verifying container (timeout: ${VERIFY_TIMEOUT}s)..."
    verify || rollback
    log "Container verified"

    trap - EXIT
    log "Removing previous container..."
    if docker rm "$OLD_CONTAINER_ID" >/dev/null; then
        log "Previous container removed"
    else
        log "  Warning: failed to remove previous container $PREVIOUS_NAME"
    fi
    log "Update completed successfully!"
    exit 0
fi

log "Starting Dockhand update"
log "  Old: ${OLD_CONTAINER_ID:0:12}, New: ${NEW_CONTAINER_ID:0:12}, Name: $CONTAINER_NAME"

log "Stopping container (timeout: ${STOP_TIMEOUT}s)..."
docker stop -t "$STOP_TIMEOUT" "$OLD_CONTAINER_ID" || { error "Failed to stop container"; exit 1; }
log "Container stopped"

log "Removing old container..."
docker rm "$OLD_CONTAINER_ID" || { error "Failed to remove old container"; exit 1; }
log "Old container removed"

log "Renaming container..."
docker rename "$NEW_CONTAINER_ID" "$CONTAINER_NAME" || { error "Failed to rename container"; exit 1; }
log "Container renamed to $CONTAINER_NAME"

connect_networks "$NEW_CONTAINER_ID"

log "Starting container..."
docker start "$NEW_CONTAINER_ID" || { error "Failed to start container"; exit 1; }

sleep 2
STATE=$(docker inspect -f '{{.State.Status}}' "$NEW_CONTAINER_ID" 2>/dev/null)
if [ "$STATE" = "running" ]; then
    log "Container is running"
    log "Update completed successfully!"
else
    error "Container state: $STATE (expected running)"
    exit 1
fi
