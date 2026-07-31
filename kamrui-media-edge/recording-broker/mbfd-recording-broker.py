#!/usr/bin/env python3
"""MBFD Recording Broker — root-owned Unix-socket broker.

Provides a bounded, allowlisted IPC interface for the unprivileged camera API
(``mbfd-camera-api``) to administer systemd recording units without sudo,
wildcard sudoers, or NoNewPrivileges relaxation.

Security model
--------------
* systemd socket activation creates ``/run/mbfd-recording-broker/broker.sock``
  with ``SocketGroup=mbfd-camera-api``, ``SocketMode=0660``.
* ``SO_PEERCRED`` verifies the connecting process UID matches the
  ``mbfd-camera-api`` system user.  Any other peer is rejected before any
  request byte is read.
* Bounded JSON request (max ``MAX_REQUEST`` bytes) and text response
  (max ``MAX_RESPONSE`` bytes).
* Exact allowlist: ``start``, ``stop``, ``status``, ``reconcile``, ``finalize``.
* Strict session-ID regex.
* No shell, no arbitrary executable, no arbitrary path, no arbitrary
  environment, no arbitrary systemd unit, no user-controlled output directory,
  no extra arguments.
* Structured audit log via syslog.

The broker reuses the validation contract of the previous
``mbfd-recording-admin`` helper but executes as a long-lived root daemon reached
through a peer-verified socket instead of a sudo call.
"""

import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

try:
    import syslog
except ImportError:
    # Windows fallback for unit testing only; production runs on Linux.
    class _StubSyslog:
        LOG_PID = 0
        LOG_DAEMON = 0
        LOG_INFO = 0
        def openlog(self, *a, **k): pass
        def syslog(self, *a, **k): pass
    syslog = _StubSyslog()

# ── Constants ──────────────────────────────────────────────────────────────

BROKER_SOCKET = "/run/mbfd-recording-broker/broker.sock"
RECORDING_ROOT = "/mnt/data/recordings"
ENV_ROOT = "/run/mbfd-camera-recording"
UNIT_TEMPLATE = "mbfd-camera-recording@{}.service"
RUNNER = "/usr/local/libexec/mbfd-camera-recording-run"
FFMPEG = "/usr/bin/ffmpeg"

MAX_REQUEST = 8192
MAX_RESPONSE = 65536
ALLOWED_ACTIONS = frozenset({"start", "stop", "status", "reconcile", "finalize"})
SESSION_RE = re.compile(rb"^ses_[A-Za-z0-9_-]+$")
SESSION_RE_STR = re.compile(r"^ses_[A-Za-z0-9_-]+$")
NONCE_RE = re.compile(r"^[A-Fa-f0-9]{64}$")
ALLOWED_ENV_KEYS = frozenset({
    "MBFD_RECORDING_SESSION_ID",
    "MBFD_RECORDING_SOURCE",
    "MBFD_RECORDING_OUTPUT_PATTERN",
    "MBFD_RECORDING_NONCE",
    "MBFD_RECORDING_SEGMENT_SECONDS",
})
ENV_VALUE_RE = re.compile(r"^[A-Za-z0-9_./:%?&=+\-]+$")

EXPECTED_FFMPEG_ARGS = [
    "/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "warning", "-n",
    "-rtsp_transport", "tcp", "-i", None,  # source placeholder
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "1", "-b:a", "96k",
    "-af", "aresample=async=1:first_pts=0",
    "-max_muxing_queue_size", "1024",
    "-f", "segment", "-segment_time", None,  # segment placeholder
    "-segment_format", "mp4", "-reset_timestamps", "1",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    None,  # output placeholder
]


def expected_ffmpeg_arguments(source, segment, output):
    """Bind the three runtime values without relying on fragile list indexes."""
    if EXPECTED_FFMPEG_ARGS.count(None) != 3:
        raise RuntimeError("recording FFmpeg argument template must have three placeholders")
    replacements = iter((source, segment, output))
    return [
        next(replacements) if argument is None else argument
        for argument in EXPECTED_FFMPEG_ARGS
    ]


# ── Audit logging ───────────────────────────────────────────────────────────

AUDIT_FACILITY = syslog.LOG_DAEMON | syslog.LOG_INFO


def audit(action, session_id, result, detail=""):
    """Write a structured audit record to syslog.  No secrets are logged."""
    msg = f"action={action} session={session_id} result={result}"
    if detail:
        # Truncate detail to avoid log flooding; never include env values.
        msg += f" detail={detail[:200]}"
    syslog.syslog(AUDIT_FACILITY, msg)


# ── Peer verification ───────────────────────────────────────────────────────

def get_peer_uid(sock):
    """Return the UID of the connecting process via SO_PEERCRED."""
    cred = sock.getsockopt(
        socket.SOL_SOCKET,
        socket.SO_PEERCRED,
        struct.calcsize("iII"),
    )
    _pid, uid, _gid = struct.unpack("iII", cred)
    return uid


def expected_camera_api_uid():
    """Return the numeric UID of the ``mbfd-camera-api`` system user."""
    import pwd
    return pwd.getpwnam("mbfd-camera-api").pw_uid


# ── Validation ──────────────────────────────────────────────────────────────

def validate_session_id(session_id):
    if not isinstance(session_id, str) or not SESSION_RE_STR.match(session_id):
        raise ValueError("invalid session id")
    return session_id


def validate_environment(session_id, environment):
    """Validate the recording environment dict before writing it to disk."""
    if not isinstance(environment, dict):
        raise ValueError("environment must be an object")
    extra = set(environment.keys()) - ALLOWED_ENV_KEYS
    if extra:
        raise ValueError("unexpected environment keys")
    for key in ALLOWED_ENV_KEYS:
        if key not in environment:
            raise ValueError(f"missing environment key {key}")
    configured = environment["MBFD_RECORDING_SESSION_ID"]
    if configured != session_id:
        raise ValueError("session id mismatch in environment")
    source = environment["MBFD_RECORDING_SOURCE"]
    if not re.match(r"^rtsp://(127\.0\.0\.1|localhost):[0-9]+/", source):
        raise ValueError("source must be credential-free loopback RTSP")
    if "@" in source:
        raise ValueError("source must not contain credentials")
    output = environment["MBFD_RECORDING_OUTPUT_PATTERN"]
    expected_prefix = f"{RECORDING_ROOT}/active/{session_id}/"
    if not output.startswith(expected_prefix) or not re.search(r"%0?3d\.mp4$", output):
        raise ValueError("output pattern must remain inside the fixed session directory")
    nonce = environment["MBFD_RECORDING_NONCE"]
    if not NONCE_RE.match(nonce):
        raise ValueError("invalid nonce")
    segment = environment["MBFD_RECORDING_SEGMENT_SECONDS"]
    if not re.match(r"^[0-9]+$", segment) or not (1 <= int(segment) <= 86400):
        raise ValueError("invalid segment duration")
    for v in environment.values():
        if not ENV_VALUE_RE.match(v):
            raise ValueError("environment value contains unsupported characters")
    return environment


def env_path_for(session_id):
    return os.path.join(ENV_ROOT, f"{session_id}.env")


def unit_for(session_id):
    return UNIT_TEMPLATE.format(session_id)


def write_env_file(session_id, environment):
    """Atomically write the validated environment file as root:mbfd-recording."""
    import grp
    target = env_path_for(session_id)
    os.makedirs(ENV_ROOT, exist_ok=True)
    content = "".join(
        f"{k}={environment[k]}\n" for k in sorted(environment.keys())
    )
    tmp = f"{target}.{os.getpid()}.tmp"
    gid = grp.getgrnam("mbfd-recording").gr_gid
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
    try:
        os.write(fd, content.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chown(tmp, 0, gid)
    os.chmod(tmp, 0o640)
    os.rename(tmp, target)
    # fsync the directory
    dir_fd = os.open(ENV_ROOT, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def remove_env_file(session_id):
    try:
        os.unlink(env_path_for(session_id))
    except FileNotFoundError:
        pass


def read_env_value(env_file, key):
    if not os.path.isfile(env_file) or os.path.islink(env_file):
        return None
    with open(env_file, "r") as fh:
        for line in fh:
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip()
    return None


# ── Systemd interaction ────────────────────────────────────────────────────

def systemctl_show(unit, *props):
    args = ["/usr/bin/systemctl", "show", unit, "--no-pager", "--property=" + ",".join(props)]
    out = subprocess.run(args, capture_output=True, text=True, timeout=10)
    fields = {}
    for line in out.stdout.strip().splitlines():
        sep = line.find("=")
        if sep > 0:
            fields[line[:sep]] = line[sep + 1:]
    return fields


def validate_active_unit(session_id):
    """Validate an active recording unit's executable, cmdline, and nonce."""
    unit = unit_for(session_id)
    fields = systemctl_show(
        unit, "Id", "ActiveState", "SubState", "MainPID", "Result"
    )
    active = fields.get("ActiveState", "")
    sub = fields.get("SubState", "")
    pid_str = fields.get("MainPID", "0")
    if active != "active" or sub != "running":
        return None, fields

    pid = int(pid_str) if pid_str.isdigit() else 0
    if pid <= 1:
        raise ValueError("invalid MainPID for active unit")

    exe = os.path.realpath(f"/proc/{pid}/exe")
    if exe != FFMPEG:
        raise ValueError("recording process executable is not ffmpeg")

    # Read cmdline
    with open(f"/proc/{pid}/cmdline", "rb") as fh:
        cmdline = fh.read().split(b"\x00")
    # Trailing empty from the final NUL
    if cmdline and cmdline[-1] == b"":
        cmdline = cmdline[:-1]

    env_file = env_path_for(session_id)
    source = read_env_value(env_file, "MBFD_RECORDING_SOURCE")
    segment = read_env_value(env_file, "MBFD_RECORDING_SEGMENT_SECONDS")
    output = read_env_value(env_file, "MBFD_RECORDING_OUTPUT_PATTERN")
    nonce = read_env_value(env_file, "MBFD_RECORDING_NONCE")
    if not all([source, segment, output, nonce]):
        raise ValueError("recording environment is missing or unreadable")

    expected = expected_ffmpeg_arguments(source, segment, output)

    if len(cmdline) != len(expected):
        raise ValueError("ffmpeg cmdline length mismatch")
    for i, (exp, act) in enumerate(zip(expected, cmdline)):
        if exp is not None and act.decode() != exp:
            raise ValueError(f"ffmpeg argv[{i}] mismatch")

    # Verify nonce in process environment
    with open(f"/proc/{pid}/environ", "rb") as fh:
        environ = fh.read().split(b"\x00")
    expected_nonce = f"MBFD_RECORDING_NONCE={nonce}".encode()
    if expected_nonce not in environ:
        raise ValueError("recording nonce not found in process environment")

    return pid, fields


def format_status(fields, validated, output_path=None):
    lines = [
        f"Id={fields.get('Id', '')}",
        f"ActiveState={fields.get('ActiveState', '')}",
        f"SubState={fields.get('SubState', '')}",
        f"MainPID={fields.get('MainPID', '0')}",
        f"Result={fields.get('Result', '')}",
        f"Validated={validated}",
    ]
    if output_path:
        lines.append(f"OutputPath={output_path}")
    return "\n".join(lines) + "\n"


# ── Reconciliation (Phase 4) ───────────────────────────────────────────────

RECONCILE_CLASSIFICATIONS = (
    "ACTIVE",
    "FINALIZING",
    "RECOVERABLE",
    "ORPHANED_METADATA",
    "FAILED_WITH_MEDIA",
    "FAILED_WITHOUT_MEDIA",
    "UNKNOWN",
)


def check_media_fragments(session_id):
    """Return the count and total size of mp4 fragments in the session dir."""
    session_dir = os.path.join(RECORDING_ROOT, "active", session_id)
    if not os.path.isdir(session_dir):
        return 0, 0
    count = 0
    total = 0
    for name in os.listdir(session_dir):
        if name.endswith(".mp4"):
            try:
                stat = os.stat(os.path.join(session_dir, name))
                if stat.st_size > 0:
                    count += 1
                    total += stat.st_size
            except OSError:
                pass
    return count, total


def reconcile_session(session_id):
    """Classify and optionally clean up a recording session.

    Returns a dict with ``classification`` and ``evidence``.
    Only clears the env file when the unit is inactive AND no media fragments
    exist (ORPHANED_METADATA or FAILED_WITHOUT_MEDIA).
    """
    unit = unit_for(session_id)
    fields = systemctl_show(
        unit, "Id", "ActiveState", "SubState", "MainPID", "Result"
    )
    active = fields.get("ActiveState", "")
    sub = fields.get("SubState", "")
    fragment_count, fragment_bytes = check_media_fragments(session_id)
    env_exists = os.path.isfile(env_path_for(session_id)) and not os.path.islink(
        env_path_for(session_id)
    )

    evidence = {
        "unit": unit,
        "active_state": active,
        "sub_state": sub,
        "main_pid": fields.get("MainPID", "0"),
        "result": fields.get("Result", ""),
        "env_file_exists": env_exists,
        "fragment_count": fragment_count,
        "fragment_bytes": fragment_bytes,
    }

    if active == "active" and sub == "running":
        try:
            pid, fields = validate_active_unit(session_id)
            evidence["validated_pid"] = pid
            audit("reconcile", session_id, "ACTIVE")
            return {"classification": "ACTIVE", "evidence": evidence}
        except ValueError as exc:
            evidence["validation_error"] = str(exc)
            audit("reconcile", session_id, "UNKNOWN", str(exc))
            return {"classification": "UNKNOWN", "evidence": evidence}

    if active == "failed":
        if fragment_count > 0:
            audit("reconcile", session_id, "FAILED_WITH_MEDIA")
            return {"classification": "FAILED_WITH_MEDIA", "evidence": evidence}
        audit("reconcile", session_id, "FAILED_WITHOUT_MEDIA")
        # Safe to clean up: no process, no media
        remove_env_file(session_id)
        return {"classification": "FAILED_WITHOUT_MEDIA", "evidence": evidence}

    # inactive / dead / other
    if fragment_count > 0:
        audit("reconcile", session_id, "RECOVERABLE")
        return {"classification": "RECOVERABLE", "evidence": evidence}

    # No active unit, no media — orphaned metadata
    if env_exists:
        remove_env_file(session_id)
    audit("reconcile", session_id, "ORPHANED_METADATA")
    return {"classification": "ORPHANED_METADATA", "evidence": evidence}


# ── Action handlers ────────────────────────────────────────────────────────

def handle_start(session_id, environment):
    validate_environment(session_id, environment)
    write_env_file(session_id, environment)
    unit = unit_for(session_id)
    subprocess.run(
        ["/usr/bin/systemctl", "start", unit],
        check=True, capture_output=True, text=True, timeout=30,
    )
    last_error = None
    for _ in range(100):
        try:
            pid, _fields = validate_active_unit(session_id)
            if pid is not None:
                audit("start", session_id, "ok")
                return ""
        except (OSError, ValueError) as exc:
            # systemd can report the unit active while the fixed runner is
            # still between its own validation and execve(/usr/bin/ffmpeg).
            last_error = exc
        time.sleep(0.05)

    # This broker started the exact allowlisted unit, so it can safely stop
    # that same unit if the runner never becomes the validated FFmpeg process.
    subprocess.run(
        ["/usr/bin/systemctl", "stop", unit],
        check=False, capture_output=True, text=True, timeout=30,
    )
    remove_env_file(session_id)
    detail = str(last_error) if last_error else "unit did not remain active"
    raise ValueError(f"recording process did not reach validated identity: {detail}")


def handle_stop(session_id):
    pid, fields = validate_active_unit(session_id)
    if pid is None:
        raise ValueError("recording unit is not active")
    unit = unit_for(session_id)
    subprocess.run(
        ["/usr/bin/systemctl", "stop", unit],
        check=True, capture_output=True, text=True, timeout=30,
    )
    remove_env_file(session_id)
    audit("stop", session_id, "ok")
    return ""


def handle_status(session_id):
    unit = unit_for(session_id)
    fields = systemctl_show(
        unit, "Id", "ActiveState", "SubState", "MainPID", "Result"
    )
    active = fields.get("ActiveState", "")
    sub = fields.get("SubState", "")
    if active == "active" and sub == "running":
        try:
            pid, fields = validate_active_unit(session_id)
        except ValueError as exc:
            audit("status", session_id, "validation_failed", str(exc))
            return format_status(fields, "failed")
        output = read_env_value(env_path_for(session_id), "MBFD_RECORDING_OUTPUT_PATTERN")
        audit("status", session_id, "active")
        return format_status(fields, "yes", output)
    if active == "failed":
        audit("status", session_id, "failed")
        return format_status(fields, "failed")
    audit("status", session_id, "inactive")
    return format_status(fields, "inactive")


def handle_reconcile(session_id):
    result = reconcile_session(session_id)
    # Return as text lines for backward compat with parseAdminStatus
    lines = [
        f"Classification={result['classification']}",
        f"Unit={result['evidence']['unit']}",
        f"ActiveState={result['evidence']['active_state']}",
        f"SubState={result['evidence']['sub_state']}",
        f"MainPID={result['evidence']['main_pid']}",
        f"FragmentCount={result['evidence']['fragment_count']}",
        f"FragmentBytes={result['evidence']['fragment_bytes']}",
    ]
    return "\n".join(lines) + "\n"


def handle_finalize(session_id):
    """Clean up env file after finalization is complete."""
    remove_env_file(session_id)
    audit("finalize", session_id, "ok")
    return ""


# ── Request processing ─────────────────────────────────────────────────────

def process_request(request_bytes, peer_uid, expected_uid):
    if peer_uid != expected_uid:
        audit("connect", "-", "denied", f"uid={peer_uid}")
        return b"Error=unauthorized peer\n"

    try:
        request = json.loads(request_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return b"Error=malformed json\n"

    if not isinstance(request, dict):
        return b"Error=request must be an object\n"

    action = request.get("action")
    if action not in ALLOWED_ACTIONS:
        return b"Error=unknown action\n"

    session_id = request.get("session_id", "")
    try:
        session_id = validate_session_id(session_id)
    except ValueError:
        return b"Error=invalid session id\n"

    try:
        if action == "start":
            environment = request.get("environment")
            handle_start(session_id, environment)
            return b"OK\n"
        elif action == "stop":
            handle_stop(session_id)
            return b"OK\n"
        elif action == "status":
            text = handle_status(session_id)
            return text.encode("utf-8")
        elif action == "reconcile":
            text = handle_reconcile(session_id)
            return text.encode("utf-8")
        elif action == "finalize":
            handle_finalize(session_id)
            return b"OK\n"
    except ValueError as exc:
        audit(action, session_id, "error", str(exc))
        return f"Error={exc}\n".encode("utf-8")
    except subprocess.TimeoutExpired:
        audit(action, session_id, "timeout")
        return b"Error=operation timed out\n"
    except subprocess.CalledProcessError as exc:
        audit(action, session_id, "systemctl_error", str(exc.stderr[:200]))
        return b"Error=systemctl operation failed\n"
    except Exception as exc:
        audit(action, session_id, "internal_error", str(exc)[:200])
        return b"Error=internal error\n"

    return b"Error=unhandled action\n"


def read_bounded(conn, max_bytes):
    """Read up to max_bytes from conn.  Returns None if client disconnects."""
    data = b""
    while len(data) < max_bytes:
        chunk = conn.recv(min(4096, max_bytes - len(data)))
        if not chunk:
            break
        data += chunk
        # Simple framing: requests end with a newline or are single-shot JSON
        if b"\n" in chunk:
            data = data.split(b"\n", 1)[0]
            break
    if len(data) >= max_bytes:
        return None  # oversized
    return data


def serve_connection(conn, expected_uid):
    try:
        peer_uid = get_peer_uid(conn)
        request_bytes = read_bounded(conn, MAX_REQUEST)
        if request_bytes is None:
            audit("connect", "-", "oversized_request")
            conn.sendall(b"Error=oversized request\n")
            return
        if not request_bytes:
            return
        response = process_request(request_bytes, peer_uid, expected_uid)
        conn.sendall(response)
    except Exception as exc:
        audit("serve", "-", "internal_error", str(exc)[:200])
        try:
            conn.sendall(b"Error=internal error\n")
        except Exception:
            pass
    finally:
        conn.close()


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    syslog.openlog("mbfd-recording-broker", syslog.LOG_PID, syslog.LOG_DAEMON)
    expected_uid = expected_camera_api_uid()

    # systemd socket activation: listen socket is fd 3
    listen_fd = 3
    try:
        sock = socket.fromfd(listen_fd, socket.AF_UNIX, socket.SOCK_STREAM)
    except OSError:
        # Fallback: create the socket ourselves
        os.makedirs(os.path.dirname(BROKER_SOCKET), exist_ok=True)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.unlink(BROKER_SOCKET)
        except FileNotFoundError:
            pass
        sock.bind(BROKER_SOCKET)
        sock.listen(16)

    syslog.syslog(syslog.LOG_INFO, f"broker ready, expected uid={expected_uid}")

    while True:
        conn, _ = sock.accept()
        serve_connection(conn, expected_uid)


if __name__ == "__main__":
    main()
