#!/usr/bin/env bash
# PM guard — portable readiness check and Claude-compatible Stop hook.
#
# Run with --check from any PM harness: no stdin or jq required, bounded
# plain text, exit 0 when clear / 1 when attention is needed. With no args,
# preserves the Stop-hook JSON contract below.
#
# Fires every time the PM session is about to go idle. Blocks the stop (the
# reason is fed back to the model as its next instruction) when the board has
# actionable state the PM has not handled:
#   - tickets sitting in review/ or blocked/ older than GRACE_MIN minutes
#     (the grace period lets a digest be handled or a conversation finish
#     without nagging on every turn boundary), or
#   - (pull mode) the supervisor is running but no `tigerteam events --wait`
#     waiter is armed for THIS board (the forgot-to-re-arm stall). In push
#     mode that waiter scan is skipped; digests land in .tigerteam/digests/.
#
# Installed by `tigerteam init` as `.tigerteam/scripts/pm-guard.sh`. Wiring
# into the assistant (e.g. `.claude/settings.local.json` Stop hook) is a
# deliberate user action — init never touches `.claude/`. See README
# "Keeping the PM loop alive".
#
# PM_GUARD_ROOT overrides the board root (tests). PM_GUARD_GRACE_MIN overrides
# the grace period (default 5). PM_GUARD_PUSH overrides push-mode detection
# (tests; `true`/`false`). When empty, the script runs
# `tigerteam config get pm.push_digests` (missing CLI → false).
set -u

check=false
case "${1:-}" in
  --check) check=true ;;
  "") ;;
  *) printf 'usage: pm-guard.sh [--check]\n' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf 'usage: pm-guard.sh [--check]\n' >&2
  exit 2
fi

# Hook mode remains fail-open if no board can be inspected.
unavailable() {
  if [ "$check" = "true" ]; then
    printf 'tigerteam PM guard: board unavailable; run from an initialized board or set PM_GUARD_ROOT.\n'
    exit 1
  fi
  exit 0
}

GRACE_MIN="${PM_GUARD_GRACE_MIN:-5}"
if [ -n "${PM_GUARD_ROOT:-}" ]; then
  ROOT="$PM_GUARD_ROOT"
else
  # in-container.sh idiom: board root is two levels above this script when
  # installed at .tigerteam/scripts/pm-guard.sh.
  cd "$(dirname "$0")/../.." 2>/dev/null || unavailable
  ROOT="$(pwd -P)"
fi
cd "$ROOT" 2>/dev/null || unavailable
ROOT="$(pwd -P)"
[ -d .tigerteam/board ] || unavailable

# Resolve the CLI once. Ownership inspection is deliberately delegated to its
# shared process-incarnation implementation; when an optional hook cannot find
# the CLI it fails open instead of recreating PID logic in shell.
tt="$(command -v tigerteam 2>/dev/null || true)"
[ -z "$tt" ] && [ -x "$HOME/.local/bin/tigerteam" ] && tt="$HOME/.local/bin/tigerteam"

# Push-mode detection (after ROOT is resolved). Anything other than true → false.
push="${PM_GUARD_PUSH:-}"
if [ -z "$push" ]; then
  # Hook environments may lack ~/.local/bin on PATH; a guard that cannot find
  # the CLI must not silently degrade to pull mode and nag for an impossible
  # re-arm, so fall back to the tool-install location before giving up.
  if [ -n "$tt" ]; then
    push="$("$tt" config get pm.push_digests 2>/dev/null || echo false)"
  else
    push=false
  fi
fi
push="$(printf '%s' "$push" | tr '[:upper:]' '[:lower:]')"
if [ "$push" != "true" ]; then
  push=false
fi

if [ "$check" != "true" ]; then
  input="$(cat 2>/dev/null || true)"
  # Loop guard: a Stop-hook-forced attempt must not block indefinitely.
  if printf '%s' "$input" | jq -e '.stop_hook_active == true' >/dev/null 2>&1; then
    exit 0
  fi
fi

review=$(find .tigerteam/board/review -maxdepth 1 -name 'T-*.md' -mmin "+$GRACE_MIN" 2>/dev/null | wc -l)
blocked=$(find .tigerteam/board/blocked -maxdepth 1 -name 'T-*.md' -mmin "+$GRACE_MIN" 2>/dev/null | wc -l)

sup=0
sup_unknown=""
probe_unavailable=""
if [ -n "$tt" ]; then
  tab="$(printf '\t')"
  daemon_row="$("$tt" --root "$ROOT" daemon-state supervisor 2>/dev/null)"
  daemon_rc=$?
  if [ "$daemon_rc" -ne 0 ]; then
    probe_unavailable="daemon-state probe exited $daemon_rc"
  else
    case "$daemon_row" in
      owned"$tab"*) sup=1 ;;
      stale"$tab"*) ;;
      unknown"$tab"*)
        daemon_reason=${daemon_row#*"$tab"}
        sup_unknown=${daemon_reason#*"$tab"}
        sup_unknown="$(printf '%.240s' "$sup_unknown")"
        ;;
      *) probe_unavailable="daemon-state probe returned an unrecognized row" ;;
    esac
  fi
else
  probe_unavailable="tigerteam CLI unavailable for daemon-state probe"
fi

# Board-scoped waiter: only count pids whose cwd is this board's ROOT.
# /proc unavailable (non-Linux): treat waiter as armed (fail-open: a guard
# that cannot verify must never nag on every turn).
# Push mode: skip the scan entirely (no pgrep) — the supervisor writes
# digests and there is nothing to re-arm.
waiters=0
if [ "$push" != "true" ]; then
  if [ ! -e /proc/self/cwd ]; then
    waiters=1
  else
    for pid in $(pgrep -f 'tigerteam events --wait' 2>/dev/null || true); do
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
      if [ "$cwd" = "$ROOT" ]; then
        waiters=$((waiters + 1))
      fi
    done
  fi
fi

msgs=""
[ "$review" -gt 0 ] && msgs="$msgs $review ticket(s) waiting in review/ for >${GRACE_MIN}m;"
[ "$blocked" -gt 0 ] && msgs="$msgs $blocked ticket(s) waiting in blocked/ for >${GRACE_MIN}m;"
[ -n "$sup_unknown" ] && msgs="$msgs supervisor ownership is unknown ($sup_unknown);"
[ "$check" = "true" ] && [ -n "$probe_unavailable" ] && msgs="$msgs supervisor ownership cannot be verified ($probe_unavailable);"
if [ "$push" != "true" ] && [ "$sup" -eq 1 ] && [ "$waiters" -eq 0 ]; then
  msgs="$msgs supervisor is running but no 'tigerteam events --wait' is armed;"
fi

if [ "$check" = "true" ]; then
  if [ -z "$msgs" ]; then
    printf 'tigerteam PM guard: clear (no stale review/blocked tickets or missing pull waiter).\n'
    exit 0
  fi
  if [ "$push" = "true" ]; then
    action="handle review/ then blocked/ (oldest first); inspect 'tigerteam events --latest' or 'tigerteam events --peek'."
  else
    action="handle review/ then blocked/ (oldest first); run 'tigerteam events --wait --timeout 30' and re-arm after handling the digest."
  fi
  printf 'tigerteam PM guard:%s %s\n' "$msgs" "$action"
  exit 1
fi

[ -z "$msgs" ] && exit 0

if [ "$push" = "true" ]; then
  reason="tigerteam PM guard:${msgs} handle review/ then blocked/ (oldest first); digests are in .tigerteam/digests/ (tigerteam events --latest). If you are mid-conversation with the user, deal with the board state first, then answer."
else
  reason="tigerteam PM guard:${msgs} handle review/ then blocked/ (oldest first) and run 'tigerteam events --wait --timeout 30'; explicitly poll any returned handle, then re-arm after handling the digest. Use a background task only when your harness supports it. If you are mid-conversation with the user, deal with the board state first, then answer."
fi
printf '{"decision":"block","reason":%s}\n' "$(printf '%s' "$reason" | jq -Rs .)"
exit 0
