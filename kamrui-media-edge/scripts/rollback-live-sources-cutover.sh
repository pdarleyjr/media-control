#!/usr/bin/env bash
# Restore the complete operational baseline of a successful live-source cutover.
#
# `rollback.sh` intentionally restores MediaMTX only.  This feature-specific
# wrapper owns the one additional, narrow state transition made by the cutover:
# an IPv4 Guest -> KAMRUI TCP/1935 UFW allow-in rule.  It derives that rule only
# from checksum-verified snapshot evidence; it never reads live camera.env.
set -euo pipefail

umask 077

SNAPSHOT="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate-rollback-snapshot.py"
ROLLBACK_SCRIPT="$SCRIPT_DIR/rollback.sh"
APPROVED_ROOT_ONE=/home/peter/mbfd-backups
APPROVED_ROOT_TWO=/opt/mbfd/media-stack/backups
WORKDIR=""
GUEST_IP=""
KAMRUI_IP=""
PORT=""
PROTOCOL=""
ACTION=""
DIRECTION=""
PRESENT_BEFORE_CUTOVER=""
CURRENT_RULE_NUMBER=""
CURRENT_UNRELATED_FINGERPRINT=""
INITIAL_UNRELATED_FINGERPRINT=""

usage() {
  cat <<'USAGE'
usage: rollback-live-sources-cutover.sh /absolute/path/to/verified-cutover-snapshot

Run only as root during an approved maintenance window. This is the manual
inverse of deploy-live-sources-cutover.sh. It validates the snapshot's
checksum-covered Guest RTMP UFW baseline, restores that exact firewall state,
then invokes the lower-level source-only MediaMTX rollback primitive.
USAGE
}

cleanup() {
  if [[ -n "$WORKDIR" && "$WORKDIR" == /tmp/mbfd-live-sources-rollback.* ]]; then
    rm -rf -- "$WORKDIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

is_ipv4() {
  local address="$1"
  local first second third fourth extra octet
  [[ "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r first second third fourth extra <<< "$address"
  [[ -z "${extra:-}" ]] || return 1
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

create_workdir() {
  WORKDIR="$(mktemp -d /tmp/mbfd-live-sources-rollback.XXXXXX)"
  [[ "$WORKDIR" == /tmp/mbfd-live-sources-rollback.* ]] || fail "temporary directory is outside the expected root"
}

load_validated_firewall_baseline() {
  local plan extra
  plan="$(python3 "$VALIDATOR" "$SNAPSHOT" \
    --approved-root "$APPROVED_ROOT_ONE" \
    --approved-root "$APPROVED_ROOT_TWO" \
    --print-firewall-plan)" || fail "snapshot validation failed; no firewall or MediaMTX rollback was attempted"
  IFS=$'\t' read -r GUEST_IP KAMRUI_IP PORT PROTOCOL PRESENT_BEFORE_CUTOVER ACTION DIRECTION extra <<< "$plan"
  [[ -z "${extra:-}" ]] || fail "snapshot validator returned an ambiguous firewall plan"
  is_ipv4 "$GUEST_IP" && is_ipv4 "$KAMRUI_IP" && [[ "$GUEST_IP" != "$KAMRUI_IP" ]] \
    || fail "snapshot validator returned malformed Guest/KAMRUI firewall identity"
  [[ "$PORT" == 1935 && "$PROTOCOL" == tcp && "$ACTION" == ALLOW && "$DIRECTION" == IN ]] \
    || fail "snapshot validator returned a firewall rule outside Guest TCP/1935 allow-in scope"
  [[ "$PRESENT_BEFORE_CUTOVER" == true || "$PRESENT_BEFORE_CUTOVER" == false ]] \
    || fail "snapshot validator returned malformed firewall baseline state"
}

observe_current_firewall() {
  local status_file observation extra
  status_file="$(mktemp "$WORKDIR/ufw-status-numbered.XXXXXX")"
  if ! LC_ALL=C ufw status numbered >"$status_file"; then
    fail "unable to read active numbered UFW status; firewall identity cannot be proven"
  fi
  observation="$(python3 "$VALIDATOR" \
    --observe-ufw-status "$status_file" \
    --guest-ip "$GUEST_IP" \
    --kamrui-ip "$KAMRUI_IP" \
    --port "$PORT" \
    --protocol "$PROTOCOL" \
    --action "$ACTION" \
    --direction "$DIRECTION")" \
    || fail "numbered UFW status is ambiguous or malformed for the Guest RTMP identity"
  IFS=$'\t' read -r CURRENT_RULE_NUMBER CURRENT_UNRELATED_FINGERPRINT extra <<< "$observation"
  [[ -z "${extra:-}" && "$CURRENT_RULE_NUMBER" =~ ^(0|[1-9][0-9]*)$ ]] \
    || fail "UFW observer returned an ambiguous exact-rule identity"
  [[ "$CURRENT_UNRELATED_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]] \
    || fail "UFW observer returned an invalid unrelated-rule fingerprint"
}

revoke_exact_guest_rtmp_rule_if_present() {
  observe_current_firewall
  if [[ "$CURRENT_RULE_NUMBER" == 0 ]]; then
    return
  fi
  if ! ufw --force delete "$CURRENT_RULE_NUMBER"; then
    fail "unable to revoke verified Guest RTMP UFW rule #$CURRENT_RULE_NUMBER; stopping before MediaMTX rollback"
  fi
  observe_current_firewall
  [[ "$CURRENT_RULE_NUMBER" == 0 ]] \
    || fail "verified Guest RTMP UFW rule remains after deletion; stopping before MediaMTX rollback"
}

restore_exact_guest_rtmp_rule_if_required() {
  observe_current_firewall
  if [[ "$CURRENT_RULE_NUMBER" != 0 ]]; then
    return
  fi
  if ! ufw allow in from "$GUEST_IP" to "$KAMRUI_IP" port "$PORT" proto "$PROTOCOL"; then
    fail "unable to restore the validated pre-cutover Guest RTMP UFW rule"
  fi
  observe_current_firewall
  [[ "$CURRENT_RULE_NUMBER" != 0 ]] \
    || fail "validated pre-cutover Guest RTMP UFW rule is absent after restoration"
}

verify_unrelated_rules_unchanged() {
  observe_current_firewall
  [[ "$CURRENT_UNRELATED_FINGERPRINT" == "$INITIAL_UNRELATED_FINGERPRINT" ]] \
    || fail "unrelated UFW rules changed during feature rollback; rollback is not GREEN"
}

if [[ -z "$SNAPSHOT" || "$SNAPSHOT" == --help || "$SNAPSHOT" == -h ]]; then
  usage
  [[ -n "$SNAPSHOT" ]] && exit 0
  exit 2
fi
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
(( EUID == 0 )) || fail "run this feature-specific rollback with sudo"

for command in bash mktemp python3 realpath ufw; do
  require_command "$command"
done
[[ -f "$VALIDATOR" ]] || fail "rollback snapshot validator is unavailable"
[[ -x "$ROLLBACK_SCRIPT" || -r "$ROLLBACK_SCRIPT" ]] || fail "lower-level source-only rollback primitive is unavailable"
SNAPSHOT="$(realpath -e -- "$SNAPSHOT")" || fail "snapshot path does not exist"
create_workdir
load_validated_firewall_baseline

observe_current_firewall
INITIAL_UNRELATED_FINGERPRINT="$CURRENT_UNRELATED_FINGERPRINT"

if [[ "$PRESENT_BEFORE_CUTOVER" == false ]]; then
  # Security ordering: close the post-cutover Guest ingress before changing
  # MediaMTX. An already-absent exact rule is an idempotent safe state.
  revoke_exact_guest_rtmp_rule_if_present
fi

if ! bash "$ROLLBACK_SCRIPT" "$SNAPSHOT"; then
  if [[ "$PRESENT_BEFORE_CUTOVER" == false ]]; then
    observe_current_firewall
    [[ "$CURRENT_RULE_NUMBER" == 0 ]] \
      || fail "source-only rollback failed and Guest ingress is no longer proven closed"
    fail "source-only MediaMTX rollback failed; Guest ingress remains closed"
  fi
  fail "source-only MediaMTX rollback failed; pre-cutover firewall state was not changed"
fi

if [[ "$PRESENT_BEFORE_CUTOVER" == false ]]; then
  # A concurrent or lower-level change cannot silently leave the exception
  # open: re-enforce the proven baseline before declaring success.
  revoke_exact_guest_rtmp_rule_if_present
else
  # Never remove a rule the snapshot proves predates the cutover. If it was
  # missing when manual rollback began, restore it only after source success.
  restore_exact_guest_rtmp_rule_if_required
fi

verify_unrelated_rules_unchanged
if [[ "$PRESENT_BEFORE_CUTOVER" == false ]]; then
  [[ "$CURRENT_RULE_NUMBER" == 0 ]] || fail "Guest RTMP UFW rule is present despite an absent pre-cutover baseline"
else
  [[ "$CURRENT_RULE_NUMBER" != 0 ]] || fail "Guest RTMP UFW rule is absent despite a present pre-cutover baseline"
fi

printf 'Guest RTMP firewall baseline restored; source-only MediaMTX rollback completed.\n'
