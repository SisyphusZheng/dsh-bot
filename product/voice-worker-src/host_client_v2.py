"""Host Integration v2 protocol client for the voice media worker.

The worker is a media client: it reports capture/ASR facts and transport
changes to the Host ConversationService (``dsh-bot-v1``) and executes the
media commands the Host publishes on the event stream. It never owns business
routing, queues, approvals or question answers.

Protocol facts (see ``.agent/plan/beta2-kernel.md`` §2.1-§2.4):
- handshake: ``GET /v2/snapshot`` -> ``{hostEpoch, snapshotSeq, identity}``
- facts/acks: ``POST /v2/command`` with a receipt
  (``accepted|pending|resolved|rejected|unknown``); ``STALE_HOST_EPOCH`` means
  refetch the snapshot and retry once with the new epoch
- commands: ``GET /v2/stream?after=<seq>`` (SSE); each ``data:`` line is an
  event envelope; gaps / old epochs / ``409 resync-required`` force a snapshot
  resync instead of guessing.

Failures are classified and raised (never reported as success). The caller
decides how to surface them; this module does not fall back to legacy business
endpoints.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone

import aiohttp

PROTOCOL_VERSION = "dsh-bot-v1"
MAX_BODY_BYTES = 256 * 1024
DEFAULT_DESCRIPTOR = "/tmp/whalegirl-g2/home/whalegirl-g2/descriptor.json"

RECEIPT_STATUSES = frozenset({"accepted", "pending", "resolved", "rejected", "unknown"})


class HostError(RuntimeError):
    """Classified Host protocol failure. ``kind`` is safe to log/surface."""

    kind = "host"

    def __init__(self, message: str, *, kind: str | None = None, status: int | None = None,
                 code: str | None = None, snapshot_seq: int | None = None):
        super().__init__(message)
        if kind:
            self.kind = kind
        self.status = status
        self.code = code
        self.snapshot_seq = snapshot_seq


class HostUnavailable(HostError):
    """Transport/descriptor/service failure: retry with backoff, keep media safe."""

    kind = "network"


class HostProtocolError(HostError):
    """The Host answered, but not with a valid ``dsh-bot-v1`` payload."""

    kind = "protocol"


class HostRejected(HostError):
    """The Host explicitly rejected a command. Never retried as success."""

    kind = "rejected"


class HostResyncRequired(HostError):
    """The stream gap/epoch/resync boundary: fetch a fresh snapshot first."""

    kind = "resync"

    def __init__(self, message: str = "host stream requires snapshot resync", *,
                 snapshot_seq: int | None = None, reason: str | None = None):
        super().__init__(message, kind="resync", snapshot_seq=snapshot_seq)
        self.reason = reason


class SSEParser:
    """Incremental Server-Sent-Events decoder for Host event envelopes.

    Only ``data:`` payloads are used; comments/heartbeats (``:``) and unknown
    fields are ignored. A partial trailing line is retained for the next feed.
    """

    def __init__(self, expected_epoch: str | None = None):
        self._buffer = ""
        self._data: list[str] = []
        self.expected_epoch = expected_epoch
        self.last_event: dict | None = None

    def feed(self, chunk: bytes | str) -> list[dict]:
        text = chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else chunk
        self._buffer += text
        events: list[dict] = []
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line:
                if self._data:
                    raw = "\n".join(self._data)
                    self._data = []
                    events.append(decode_event(raw, expected_epoch=self.expected_epoch))
                continue
            if line.startswith(":"):
                continue
            if line.startswith("data:"):
                self._data.append(line[5:].lstrip(" "))
            # `event:`/`id:`/`retry:` are not part of the Host protocol.
        return events


def _require(condition: bool, message: str, code: str = "INVALID_EVENT") -> None:
    if not condition:
        raise HostProtocolError(message, code=code)


def decode_event(raw: str, expected_epoch: str | None = None) -> dict:
    """Validate one SSE data payload as a Host event envelope."""
    try:
        event = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise HostProtocolError("host event is not valid JSON", code="INVALID_JSON") from exc
    _require(isinstance(event, dict), "host event must be an object")
    _require(event.get("protocolVersion") == PROTOCOL_VERSION,
             "host event protocolVersion mismatch", "UNSUPPORTED_PROTOCOL")
    seq = event.get("seq")
    _require(isinstance(seq, int) and not isinstance(seq, bool) and seq > 0,
             "host event seq must be a positive integer", "INVALID_SEQ")
    epoch = event.get("hostEpoch")
    _require(isinstance(epoch, str) and epoch != "", "host event hostEpoch is required", "MISSING_HOST_EPOCH")
    if expected_epoch is not None and epoch != expected_epoch:
        raise HostResyncRequired("host epoch changed", reason="host-epoch-changed")
    return event


class HostClientV2:
    """Loopback-only ``dsh-bot-v1`` client bound to one bridge descriptor."""

    def __init__(self, descriptor_path: str = "", *, connection_id: str = "",
                 timeout: float = 5.0, sock_read: float = 45.0):
        self._descriptor_path = descriptor_path or os.environ.get("DSH_BRIDGE_DESCRIPTOR", DEFAULT_DESCRIPTOR)
        self.connection_id = connection_id or ("worker-" + uuid.uuid4().hex)
        self._timeout = timeout
        self._sock_read = sock_read
        self._session: aiohttp.ClientSession | None = None
        self.host_epoch: str | None = None
        self.session_id: str | None = None
        self.snapshot_seq: int = 0

    # ---- descriptor / session ------------------------------------------
    @property
    def descriptor_path(self) -> str:
        return self._descriptor_path

    def load_descriptor(self) -> dict:
        try:
            with open(self._descriptor_path, "r", encoding="utf-8") as fh:
                descriptor = json.load(fh)
        except FileNotFoundError as exc:
            raise HostUnavailable("host bridge descriptor not found", kind="descriptor") from exc
        except (OSError, ValueError) as exc:
            raise HostUnavailable("host bridge descriptor unreadable", kind="descriptor") from exc
        port = descriptor.get("port") if isinstance(descriptor, dict) else None
        token = descriptor.get("token") if isinstance(descriptor, dict) else None
        if not isinstance(port, int) or not 0 < port < 65536:
            raise HostUnavailable("host bridge descriptor has no valid port", kind="descriptor")
        if not isinstance(token, str) or not token:
            raise HostUnavailable("host bridge descriptor has no token", kind="descriptor")
        return descriptor

    @property
    def base_url(self) -> str:
        descriptor = self.load_descriptor()
        return f"http://127.0.0.1:{descriptor['port']}"

    def _headers(self) -> dict:
        descriptor = self.load_descriptor()
        return {"Authorization": f"Bearer {descriptor['token']}", "content-type": "application/json"}

    def _get_http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        session = self._session
        self._session = None
        if session is not None and not session.closed:
            await session.close()

    # ---- HTTP helpers (overridable in unit tests) -----------------------
    async def _request_json(self, method: str, path: str, body: dict | None = None,
                            *, timeout: float | None = None) -> dict:
        descriptor = self.load_descriptor()
        url = f"http://127.0.0.1:{descriptor['port']}{path}"
        try:
            async with self._get_http().request(
                method, url, json=body, headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=timeout or self._timeout),
            ) as response:
                raw = await response.text()
                status = response.status
        except asyncio.TimeoutError as exc:
            raise HostUnavailable("host request timed out", kind="network") from exc
        except aiohttp.ClientError as exc:
            raise HostUnavailable(f"host request failed: {type(exc).__name__}", kind="network") from exc
        if status == 401 or status == 403:
            raise HostUnavailable(f"host rejected credentials (HTTP {status})", kind="auth", status=status)
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError as exc:
            raise HostProtocolError(f"host returned non-JSON (HTTP {status})", status=status) from exc
        if not isinstance(payload, dict):
            raise HostProtocolError(f"host returned non-object JSON (HTTP {status})", status=status)
        if status == 409:
            code = ((payload.get("error") or {}).get("code") if isinstance(payload.get("error"), dict)
                    else payload.get("code")) or "RESYNC"
            if code in {"RESYNC_REQUIRED", "RESYNC", "STALE_HOST_EPOCH"}:
                snapshot_seq = payload.get("snapshotSeq")
                raise HostResyncRequired("host requires snapshot resync", snapshot_seq=snapshot_seq, reason=code)
            message = ((payload.get("error") or {}).get("message")
                       if isinstance(payload.get("error"), dict) else None)
            raise HostRejected(f"host conflict: {message or code}", code=code, status=status)
        if status == 426:
            raise HostProtocolError("host does not support dsh-bot-v1", status=status,
                                    code="UNSUPPORTED_PROTOCOL")
        if status >= 500:
            raise HostUnavailable(f"host service error (HTTP {status})", kind="provider", status=status)
        if status != 200:
            code = ((payload.get("error") or {}).get("code") if isinstance(payload.get("error"), dict) else None)
            raise HostProtocolError(f"host command failed (HTTP {status})", status=status, code=code)
        return payload

    # ---- handshake ------------------------------------------------------
    async def handshake(self) -> dict:
        """Fetch a fresh snapshot, adopting its ``hostEpoch`` and session."""
        snapshot = await self._request_json("GET", "/v2/snapshot", timeout=self._timeout)
        _require(snapshot.get("protocolVersion") == PROTOCOL_VERSION,
                 "snapshot protocolVersion mismatch", "UNSUPPORTED_PROTOCOL")
        epoch = snapshot.get("hostEpoch")
        _require(isinstance(epoch, str) and epoch != "", "snapshot hostEpoch is required", "MISSING_HOST_EPOCH")
        seq = snapshot.get("snapshotSeq")
        _require(isinstance(seq, int) and not isinstance(seq, bool) and seq >= 0,
                 "snapshot snapshotSeq must be a non-negative integer", "INVALID_SNAPSHOT_SEQ")
        identity = snapshot.get("identity")
        session_id = identity.get("sessionId") if isinstance(identity, dict) else None
        self.host_epoch = epoch
        self.session_id = session_id if isinstance(session_id, str) and session_id else None
        self.snapshot_seq = seq
        return snapshot

    # ---- commands -------------------------------------------------------
    async def send_command(self, command_type: str, payload: dict | None = None, *,
                           command_id: str | None = None, session_id: str | None = None,
                           timeout: float | None = None) -> dict:
        """POST one command and return the validated receipt.

        ``STALE_HOST_EPOCH`` resyncs the snapshot and retries exactly once with
        the new epoch. Rejected/unknown receipts are surfaced, never hidden.
        """
        command_id = command_id or str(uuid.uuid4())
        attempts = 0
        while True:
            if self.host_epoch is None:
                await self.handshake()
            body = {
                "protocolVersion": PROTOCOL_VERSION,
                "commandId": command_id,
                "hostEpoch": self.host_epoch,
                "sourceConnectionId": self.connection_id,
                "sessionId": self.session_id if session_id is None else session_id,
                "type": command_type,
                "payload": payload if payload is not None else {},
            }
            try:
                receipt = await self._request_json("POST", "/v2/command", body, timeout=timeout)
            except HostResyncRequired as exc:
                attempts += 1
                if attempts > 1:
                    raise HostUnavailable("host epoch stayed stale after resync", kind="stale-epoch") from exc
                await self.handshake()
                continue
            self._validate_receipt(receipt, command_id)
            if receipt["status"] == "rejected":
                error = receipt.get("error") or {}
                code = error.get("code") if isinstance(error, dict) else None
                if code == "STALE_HOST_EPOCH" and attempts == 0:
                    attempts += 1
                    await self.handshake()
                    continue
                message = error.get("message") if isinstance(error, dict) else None
                raise HostRejected(f"host rejected {command_type}: {message or code or 'rejected'}",
                                   code=code, status=409)
            return receipt

    @staticmethod
    def _validate_receipt(receipt: dict, command_id: str) -> None:
        _require(isinstance(receipt, dict) and receipt.get("protocolVersion") == PROTOCOL_VERSION,
                 "command receipt protocolVersion mismatch", "INVALID_RECEIPT")
        _require(receipt.get("commandId") == command_id, "command receipt identity mismatch", "INVALID_RECEIPT")
        _require(isinstance(receipt.get("hostEpoch"), str) and receipt["hostEpoch"] != "",
                 "command receipt hostEpoch is required", "INVALID_RECEIPT")
        status = receipt.get("status")
        _require(status in RECEIPT_STATUSES, "command receipt status is invalid", "INVALID_RECEIPT")

    # ---- event stream ---------------------------------------------------
    async def events(self, after: int):
        """Yield validated Host events with ``seq > after`` from ``/v2/stream``.

        Raises :class:`HostResyncRequired` when the Host asks for a resync or
        the epoch changed; the caller refetches the snapshot and re-subscribes.
        """
        descriptor = self.load_descriptor()
        url = f"http://127.0.0.1:{descriptor['port']}/v2/stream"
        headers = {"Authorization": f"Bearer {descriptor['token']}", "Accept": "text/event-stream"}
        parser = SSEParser(expected_epoch=self.host_epoch)
        try:
            async with self._get_http().get(
                url, params={"after": int(after)}, headers=headers,
                timeout=aiohttp.ClientTimeout(total=None, sock_read=self._sock_read),
            ) as response:
                if response.status == 409:
                    body = await _safe_json(response)
                    raise HostResyncRequired("host stream requires snapshot resync",
                                             snapshot_seq=body.get("snapshotSeq"))
                if response.status in (401, 403):
                    raise HostUnavailable(f"host stream rejected credentials (HTTP {response.status})",
                                          kind="auth", status=response.status)
                if response.status != 200:
                    raise HostUnavailable(f"host stream unavailable (HTTP {response.status})",
                                          status=response.status)
                async for chunk in response.content.iter_any():
                    for event in parser.feed(chunk):
                        yield event
        except asyncio.TimeoutError as exc:
            raise HostUnavailable("host stream timed out", kind="network") from exc
        except aiohttp.ClientError as exc:
            raise HostUnavailable(f"host stream failed: {type(exc).__name__}", kind="network") from exc


async def _safe_json(response) -> dict:
    try:
        body = await response.json(content_type=None)
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def now_iso() -> str:
    """UTC ISO-8601 with milliseconds; the Host protocol timestamp format."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
