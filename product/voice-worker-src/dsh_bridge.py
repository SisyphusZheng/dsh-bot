"""Voice media bridge: reports capture/ASR facts to the Host v2 protocol and
executes only media commands.

Authority boundary (plan v2.1 §8.1, kernel §2.3/§2.4/§3.7):
- The Host ConversationService owns utterance assembly, business routing, input
  admission, the ordinary queue, confirmation drafts and interaction answers.
- This processor owns the media boundary only: ASR partial/final facts and
  capture release/discard facts go out as ``voice.facts``; transport changes go
  out as ``voice.session``; the Host command stream (``/v2/stream``) is executed
  with playback/capture identity and acknowledged via ``presentation.ack``.
- VAD/barge-in/duck effects, echo isolation, capture admission, playback
  execution, late-audio isolation and error classification stay here.

No approval/question/queue/task HTTP endpoint is called from this module, and
no control phrase is classified here: a spoken control is just another ASR fact
for the Host to route. Media safety may still drop an echoed/noisy transcript or
discard a cancelled capture locally.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from collections import deque
from difflib import SequenceMatcher

from loguru import logger

from host_client_v2 import (
    HostClientV2,
    HostError,
    HostRejected,
    HostResyncRequired,
    HostProtocolError,
    HostUnavailable,
    now_iso,
)
from voice_errors import redact, report as report_voice_error

from pipecat.frames.frames import (
    InterimTranscriptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    OutputTransportMessageUrgentFrame,
    TextFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


DEFAULT_DESCRIPTOR = "/tmp/whalegirl-g2/home/whalegirl-g2/descriptor.json"
COMMAND_TYPES = ("playback.stop", "speech.append", "speech.end", "capture.command", "notice.show")
ACK_STATES = ("applied", "rejected", "unknown")


def normalize(text: str) -> str:
    """Normalization used only for echo detection; never for control routing."""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]", "", str(text or "").lower())


def probe_log(message):
    if os.environ.get("DSH_VOICE_DEBUG_PROBES") == "1":
        logger.info(message)


class VoiceMediaBridge(FrameProcessor):
    """One WebRTC media session's voice boundary; business authority is Host."""

    # Echo decisions combine a playback time window with a long contiguous match;
    # a bare length threshold is not an acoustic oracle. Short valid replies such
    # as 你好 / 我在 / 想聊什么 / 是 / 否 must always be admissible.
    ECHO_MIN_CHARS = 6
    # Post-playback echo window for the noise filter. Barge candidates are no longer
    # created from this window: speech after the bot stopped is a new utterance, not
    # an interruption of a finished playback.
    ECHO_TAIL_SECONDS = float(os.environ.get('DSH_ECHO_TAIL_SECONDS', '6'))

    def __init__(self, descriptor_path: str = "", capture=None, host=None):
        super().__init__(name="VoiceMediaBridge")
        self._descriptor_path = descriptor_path or os.environ.get(
            "DSH_BRIDGE_DESCRIPTOR", DEFAULT_DESCRIPTOR)
        self._capture = capture
        self._host: HostClientV2 | None = host
        self._connection_id = (getattr(host, "connection_id", "") if host is not None else "") \
            or ("worker-" + uuid.uuid4().hex)
        self._host_epoch: str | None = getattr(host, "host_epoch", None) if host is not None else None
        self._session_id: str | None = getattr(host, "session_id", None) if host is not None else None
        self._last_seq = 0
        self._host_task: asyncio.Task | None = None
        self._started = False
        self._closing = False
        self._host_error_reported_at = 0.0
        self._transport_state = "disconnected"
        # Capture media state (identity + admission); business capture state is Host's.
        self._capture_id = ""
        self._capture_mode = "always"
        self._capture_state = "off"
        # ASR fact identity: provider item + recognition revision (never faked confidence).
        self._item_revisions: dict[tuple[str, str], int] = {}
        self._item_last_partial: dict[tuple[str, str], str] = {}
        # Playback execution identity and late-audio isolation.
        self._playback: dict | None = None
        self._finished_playbacks: deque = deque(maxlen=256)
        self._applied_commands: dict[str, str] = {}
        self._command_order: deque = deque(maxlen=512)
        # Media-level barge-in/duck state (echo rejection is acoustic, not routing).
        self._barge_candidate: dict | None = None
        self._barge_timeout_task: asyncio.Task | None = None
        self._barge_confirmed_keys: set[str] = set()
        self._last_barge_context: dict | None = None
        self._duck_state: dict[str, dict] = {}
        self._echo_transcript_dropped = 0
        self.metrics: dict = {
            "facts_sent": 0,
            "facts_failed": 0,
            "facts_rejected": 0,
            "facts_without_capture": 0,
            "partial_facts": 0,
            "final_facts": 0,
            "duplicate_partials": 0,
            "capture_facts": 0,
            "playbacks_started": 0,
            "playbacks_ended": 0,
            "playbacks_stopped": 0,
            "stale_playback_stops": 0,
            "speech_appends": 0,
            "late_speech_dropped": 0,
            "duplicate_speech_dropped": 0,
            "commands_applied": 0,
            "commands_rejected": 0,
            "commands_unknown": 0,
            "command_duplicates": 0,
            "ack_failures": 0,
            "duplicate_events": 0,
            "host_errors": 0,
            "session_facts_sent": 0,
            "session_unreported": 0,
            "transport_connected": 0,
            "transport_disconnected": 0,
            "barge_candidates": 0,
            "barge_rejected_echo": 0,
            "barge_confirmed": 0,
            "barge_ins": 0,
            "barge_duplicates_ignored": 0,
            "barge_pending_short": 0,
            "barge_rejected_short": 0,
            "duck_applied": 0,
            "duck_skipped_limit": 0,
            "echo_transcript_dropped": 0,
            "errors": 0,
        }

    # ---- lifecycle -----------------------------------------------------
    def start(self) -> None:
        """Start the Host v2 link (idempotent; call from the running loop)."""
        if self._started or self._closing:
            return
        self._started = True
        if self._host is None:
            self._host = HostClientV2(self._descriptor_path, connection_id=self._connection_id)
        self._host_task = asyncio.create_task(self._run_host_link(), name="voice-host-link")

    @property
    def closing(self) -> bool:
        return self._closing

    async def cleanup(self) -> None:
        self._closing = True
        self._cancel_barge_timeout()
        task = self._host_task
        self._host_task = None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._host is not None:
            # Media disconnect must never cancel DSH work: only the transport fact is
            # reported, bounded so a dead Host cannot block worker shutdown.
            try:
                await asyncio.wait_for(self._report_session("disconnected"), timeout=1.5)
            except Exception:
                pass
            try:
                await self._host.close()
            except Exception:
                pass
        await super().cleanup()

    # ---- Host link -----------------------------------------------------
    async def _run_host_link(self) -> None:
        backoff = 0.5
        failures = 0
        while not self._closing:
            try:
                await self._handshake_and_stream()
                failures = 0
                raise HostUnavailable("host event stream closed", kind="network")
            except asyncio.CancelledError:
                raise
            except HostResyncRequired as exc:
                logger.info(f"[host-v2] resync required: {exc.reason or exc}")
                await asyncio.sleep(0.15)
                backoff = 0.5
            except HostError as exc:
                self.metrics["host_errors"] += 1
                failures += 1
                self._report_host_error(exc, consecutive=failures)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 5.0)
            except Exception as exc:  # never let the link task die silently
                self.metrics["host_errors"] += 1
                self.metrics["errors"] += 1
                failures += 1
                self._report_host_error(exc, consecutive=failures)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 5.0)

    async def _handshake_and_stream(self) -> None:
        snapshot = await self._host.handshake()
        self._host_epoch = self._host.host_epoch
        self._session_id = self._host.session_id
        self._last_seq = self._host.snapshot_seq
        logger.info(
            f"[host-v2] connected epoch={self._host_epoch} snapshotSeq={self._last_seq} "
            f"session={self._session_id} connection={self._connection_id}"
        )
        if self._transport_state == "connected":
            await self._report_session("connected")
        async for event in self._host.events(self._last_seq):
            if self._closing:
                return
            await self._handle_host_event(event)

    def _report_host_error(self, exc: BaseException, consecutive: int = 2) -> None:
        """Throttle classified Host failures; never fake a successful link.

        A single truncated stream during teardown (or a one-off reconnect) is not a
        user-actionable failure: surfacing it produced a "voice connection failed"
        bubble on every quit. Only a repeatedly failing link is reported.
        """
        # An intentional shutdown closes the Host bridge first; the truncated
        # event stream is expected then. Never surface it as a user-facing
        # "voice connection failed / retry" error during teardown.
        if self._closing:
            return
        if consecutive < 2:
            logger.debug(f"[host-v2] transient link drop ({type(exc).__name__}); retrying silently")
            return
        now = time.monotonic()
        if now - self._host_error_reported_at < 10.0:
            return
        self._host_error_reported_at = now
        logger.warning(f"[host-v2] link failure kind={getattr(exc, 'kind', 'unknown')} "
                       f"type={type(exc).__name__}: {redact(str(exc), 300)}")
        try:
            asyncio.get_running_loop().create_task(report_voice_error(exc, "host"))
        except RuntimeError:
            pass

    async def _handle_host_event(self, event: dict) -> None:
        if event.get("protocolVersion") is not None and event.get("protocolVersion") != "dsh-bot-v1":
            raise HostProtocolError("host event protocolVersion mismatch")
        epoch = event.get("hostEpoch")
        if self._host_epoch is not None and epoch != self._host_epoch:
            raise HostResyncRequired("host epoch changed", reason="host-epoch-changed")
        seq = event.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq <= 0:
            raise HostProtocolError("host event seq is invalid")
        if seq <= self._last_seq:
            self.metrics["duplicate_events"] += 1
            return
        if seq != self._last_seq + 1:
            raise HostResyncRequired("host event stream gap", reason="gap")
        self._last_seq = seq
        session_id = event.get("sessionId")
        if isinstance(session_id, str) and session_id:
            self._session_id = session_id
        event_type = event.get("type")
        if event_type == "command":
            data = event.get("data")
            if isinstance(data, dict):
                await self._execute_command(data)
            else:
                self.metrics["errors"] += 1
                logger.warning("[host-v2] command event without data object")
        elif event_type in ("playback.changed", "capture.changed"):
            # Media projection only; Host remains the business owner.
            probe_log(f"[host-v2] event {event_type} seq={seq}")
        elif event_type in ("interaction.requested", "interaction.resolved", "notice.added"):
            # Host sends notice.show / speech.append commands when text must be
            # spoken or shown; the worker never decides those business triggers.
            probe_log(f"[host-v2] event {event_type} seq={seq}")

    # ---- Host -> worker media commands ---------------------------------
    async def _execute_command(self, data: dict) -> None:
        command_id = data.get("commandId")
        command_type = data.get("type")
        payload = data.get("payload")
        if not isinstance(command_id, str) or not command_id or len(command_id) > 200:
            self.metrics["errors"] += 1
            logger.warning("[host-v2] command without valid commandId ignored")
            return
        if not isinstance(payload, dict):
            await self._ack(command_id, "rejected", "invalid-payload")
            return
        prior = self._applied_commands.get(command_id)
        if prior is not None:
            self.metrics["command_duplicates"] += 1
            await self._ack(command_id, prior)
            return
        handler = self._COMMAND_HANDLERS.get(command_type)
        state, detail, extra = "unknown", None, None
        try:
            if handler is None:
                state, detail = "rejected", "unsupported-command-type"
            else:
                outcome = await handler(self, payload)
                if isinstance(outcome, tuple) and len(outcome) == 3:
                    state, detail, extra = outcome
                elif isinstance(outcome, tuple) and len(outcome) == 2:
                    state, detail = outcome
                else:
                    state = outcome
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.metrics["command_errors"] = self.metrics.get("command_errors", 0) + 1
            self.metrics["errors"] += 1
            logger.warning(f"[host-v2] command {redact(str(command_type), 40)} failed: "
                           f"{type(exc).__name__}: {redact(str(exc), 200)}")
            state, detail = "unknown", type(exc).__name__
        if state not in ACK_STATES:
            state = "unknown"
        if state == "applied":
            self.metrics["commands_applied"] += 1
        elif state == "rejected":
            self.metrics["commands_rejected"] += 1
        else:
            self.metrics["commands_unknown"] += 1
        self._remember_command(command_id, state)
        await self._ack(command_id, state, detail, extra)

    _COMMAND_HANDLERS: dict = {}  # populated after the class body (methods below)

    def _remember_command(self, command_id: str, state: str) -> None:
        if command_id not in self._applied_commands:
            self._command_order.append(command_id)
        self._applied_commands[command_id] = state
        while len(self._applied_commands) > 512 and self._command_order:
            stale = self._command_order.popleft()
            if stale in self._applied_commands:
                self._applied_commands.pop(stale, None)

    async def _ack(self, command_id: str, state: str, detail: str | None = None,
                   extra: dict | None = None) -> None:
        payload = {"commandId": command_id, "state": state}
        if detail:
            payload["detail"] = str(detail)[:200]
        if isinstance(extra, dict):
            for key in ("playbackId", "noticeId", "captureId"):
                value = extra.get(key)
                if isinstance(value, str) and value:
                    payload[key] = value[:300]
        if self._host is None or self._host_epoch is None:
            self.metrics["session_unreported"] += 1
            return
        cmd_id = str(uuid.uuid4())
        try:
            await self._host.send_command(
                "presentation.ack", payload, command_id=cmd_id, session_id=self._session_id)
        except asyncio.CancelledError:
            raise
        except HostError as exc:
            self.metrics["ack_failures"] += 1
            logger.warning(f"[host-v2] ack failed for {redact(command_id, 60)}: {type(exc).__name__}")
        except Exception:
            self.metrics["ack_failures"] += 1

    # playback.stop {playbackId?, reason}
    async def _cmd_playback_stop(self, payload: dict) -> tuple[str, str | None]:
        playback_id = payload.get("playbackId")
        reason = str(payload.get("reason") or "stop")[:80]
        current = self._playback
        if playback_id not in (None, ""):
            if not isinstance(playback_id, str) or len(playback_id) > 300:
                return "rejected", "invalid-playback-id"
            if current is None or current.get("playback_id") != playback_id:
                # A late stop for an older playback must never mute the new one.
                self.metrics["stale_playback_stops"] += 1
                return "applied", "stale-playback-ignored", {"playbackId": playback_id}
        elif current is None:
            return "applied", "no-active-playback", None
        assert current is not None
        self._cancel_barge_timeout()
        self._barge_candidate = None
        await self._close_playback(current, interrupt=True)
        self._remember_playback(current)
        self._playback = None
        self._finished_playbacks.append(current["playback_id"])
        self.metrics["playbacks_stopped"] += 1
        await self._send_rtvi({
            "type": "stop-playback",
            "playbackId": current["playback_id"],
            "reason": reason,
        })
        return "applied", None, {"playbackId": current["playback_id"]}

    # speech.append {turnId, text, seq}
    async def _cmd_speech_append(self, payload: dict) -> tuple[str, str | None]:
        turn_id = payload.get("turnId")
        text = payload.get("text")
        seq = payload.get("seq")
        if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 300:
            return "rejected", "missing-turn-id"
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            return "rejected", "invalid-text"
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
            return "rejected", "invalid-seq"
        if turn_id in self._finished_playbacks:
            # Late TTS for a stopped/ended playback must not reopen old audio.
            self.metrics["late_speech_dropped"] += 1
            return "applied", "stale-playback-dropped", {"playbackId": turn_id}
        current = self._playback
        if current is None or current.get("playback_id") != turn_id:
            if current is not None:
                await self._close_playback(current, interrupt=True)
                self._remember_playback(current)
                self._finished_playbacks.append(current["playback_id"])
            current = {
                "playback_id": turn_id,
                "turn_id": turn_id,
                "last_seq": 0,
                "open": False,
                "stopped": False,
                "reply_text": "",
                "text_events": [],
                "started_mono": time.monotonic(),
            }
            self._playback = current
            self.metrics["playbacks_started"] += 1
            await self._send_rtvi({"type": "playback-identity",
                                   "playbackId": turn_id, "turnId": turn_id})
        if seq <= current.get("last_seq", 0):
            self.metrics["duplicate_speech_dropped"] += 1
            return "applied", "stale-seq-dropped", {"playbackId": turn_id}
        current["last_seq"] = seq
        events = current.setdefault("text_events", [])
        events.append({"text": text, "at_mono": time.monotonic()})
        current["text_events"] = events[-80:]
        current["reply_text"] = (current.get("reply_text", "") + text)[-4000:]
        if not current.get("open"):
            current["open"] = True
            await self.push_frame(LLMFullResponseStartFrame())
        self.metrics["speech_appends"] += 1
        await self.push_frame(TextFrame(text=text))
        return "applied", None, {"playbackId": turn_id}

    # speech.end {turnId, reason}
    async def _cmd_speech_end(self, payload: dict) -> tuple[str, str | None]:
        turn_id = payload.get("turnId")
        if not isinstance(turn_id, str) or not turn_id:
            return "rejected", "missing-turn-id"
        current = self._playback
        if current is None or current.get("playback_id") != turn_id:
            return "rejected", "unknown-playback"
        await self._close_playback(current)
        self._remember_playback(current)
        self._playback = None
        self._finished_playbacks.append(turn_id)
        self.metrics["playbacks_ended"] += 1
        return "applied", None, {"playbackId": turn_id}

    # capture.command {action, captureId, mode?}
    async def _cmd_capture_command(self, payload: dict) -> tuple[str, str | None]:
        action = payload.get("action")
        capture_id = payload.get("captureId")
        mode = payload.get("mode")
        if action not in ("start", "finish", "discard"):
            return "rejected", "invalid-capture-action"
        if not isinstance(capture_id, str) or not capture_id or len(capture_id) > 100:
            return "rejected", "invalid-capture-id"
        if self._capture is None:
            return "rejected", "capture-policy-unavailable"
        mode_arg = mode if mode in ("hold", "toggle", "always") \
            else self._capture.modes.get(capture_id, "always")
        if not self._capture.control(action, capture_id, mode_arg):
            return "rejected", "capture-admission-rejected"
        if action == "start":
            self._capture_id = capture_id
            self._capture_mode = mode_arg
            self._capture_state = "listening"
            await self._send_rtvi({"type": "capture-ack", "action": action, "captureId": capture_id})
        else:
            self._capture_state = "off" if action == "discard" else "closing"
            self._drop_stale_barge_for_capture(capture_id)
            await self._send_rtvi({"type": "capture-ack", "action": action, "captureId": capture_id})
        return "applied", None, {"captureId": capture_id}

    # notice.show {noticeId, text, kind}
    async def _cmd_notice_show(self, payload: dict) -> tuple[str, str | None]:
        notice_id = payload.get("noticeId")
        text = payload.get("text")
        kind = str(payload.get("kind") or "status")[:40]
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            return "rejected", "invalid-notice-text"
        if notice_id is not None and (not isinstance(notice_id, str) or len(notice_id) > 200):
            return "rejected", "invalid-notice-id"
        await self._send_rtvi({"type": "notice", "noticeId": notice_id, "text": text, "kind": kind})
        return "applied", None, {"noticeId": notice_id if isinstance(notice_id, str) else None}

    # ---- outbound facts ------------------------------------------------
    async def _report_facts(self, items: list[dict], capture_id: str, mode: str,
                            state: str, release: dict | None = None) -> dict | None:
        if self._host is None or self._host_epoch is None:
            self.metrics["facts_failed"] += 1
            return None
        payload = {
            "connectionId": self._connection_id,
            "capture": {"captureId": capture_id, "mode": mode, "state": state},
            "items": items,
        }
        if release is not None:
            payload["release"] = release
        try:
            receipt = await self._host.send_command(
                "voice.facts", payload, session_id=self._session_id)
        except asyncio.CancelledError:
            raise
        except HostRejected as exc:
            self.metrics["facts_rejected"] += 1
            logger.warning(f"[host-v2] facts rejected: {exc.code or exc}")
            return None
        except HostError as exc:
            self.metrics["facts_failed"] += 1
            self._report_host_error(exc)
            return None
        except Exception as exc:
            self.metrics["facts_failed"] += 1
            self.metrics["errors"] += 1
            logger.warning(f"[host-v2] facts failed: {type(exc).__name__}")
            return None
        self.metrics["facts_sent"] += 1
        # Low-latency media actions may ride the receipt commands[]; execute and
        # ack them exactly like stream commands (commandId dedupe is shared).
        result = receipt.get("result")
        commands = result.get("commands") if isinstance(result, dict) else None
        if isinstance(commands, list):
            for command in commands:
                # The Host receipt may carry reference hints ({commandId,type}) while
                # the canonical command event (with payload) arrives on /v2/stream.
                # Execute only complete entries so the SSE event still executes.
                if not isinstance(command, dict):
                    continue
                if not isinstance(command.get("payload"), dict) or not command.get("commandId"):
                    self.metrics["receipt_hints_skipped"] = \
                        self.metrics.get("receipt_hints_skipped", 0) + 1
                    continue
                await self._execute_command(command)
        return receipt

    async def _report_session(self, transport: str) -> dict | None:
        if self._host is None or self._host_epoch is None:
            self.metrics["session_unreported"] += 1
            return None
        payload = {
            "connectionId": self._connection_id,
            "transport": transport,
            "mediaState": self._media_state(),
        }
        try:
            receipt = await self._host.send_command(
                "voice.session", payload, session_id=self._session_id)
        except asyncio.CancelledError:
            raise
        except HostError as exc:
            self.metrics["session_unreported"] += 1
            self._report_host_error(exc)
            return None
        except Exception:
            self.metrics["session_unreported"] += 1
            return None
        self.metrics["session_facts_sent"] += 1
        return receipt

    def _media_state(self) -> dict:
        playback = self._playback or {}
        return {
            "connectionId": self._connection_id,
            "capture": {
                "enabled": bool(self._capture.enabled) if self._capture is not None else False,
                "captureId": self._capture_id or None,
                "mode": self._capture_mode,
                "state": self._capture_state,
            },
            "playback": {
                "state": "speaking" if playback.get("open") else "idle",
                "playbackId": playback.get("playback_id"),
            },
            "transport": self._transport_state,
        }

    async def report_transport(self, state: str) -> None:
        if state not in ("connected", "disconnected"):
            return
        self._transport_state = state
        self.metrics["transport_" + state] += 1
        await self._report_session(state)

    # ---- capture facts (user gesture / provider events) ----------------
    async def capture_changed(self, action: str, capture_id: str, mode: str | None = None) -> None:
        if action not in ("start", "finish", "discard"):
            return
        if mode in ("hold", "toggle", "always"):
            self._capture_mode = mode
        elif self._capture is not None:
            # Release/discard messages carry no mode: keep the mode recorded at
            # capture start. Only an explicit valid mode may change it.
            stored = self._capture.modes.get(capture_id)
            if stored in ("hold", "toggle", "always"):
                self._capture_mode = stored
        self._capture_id = capture_id
        if action == "start":
            self._capture_state = "listening"
            self.metrics["capture_facts"] += 1
            await self._report_facts([], capture_id, self._capture_mode, "listening")
            return
        self._capture_state = "off" if action == "discard" else "closing"
        self.metrics["capture_facts"] += 1
        await self._report_facts(
            [], capture_id, self._capture_mode, self._capture_state,
            release={"captureId": capture_id,
                     "reason": "discard" if action == "discard" else "release"},
        )
        if action == "finish":
            self._capture_state = "off"

    # ---- frame handling ------------------------------------------------
    @classmethod
    def _echo_like(cls, heard: str, window: str) -> bool:
        """True only for a long contiguous (or near-identical) echo of the window."""
        if not heard or not window or len(heard) < cls.ECHO_MIN_CHARS:
            return False
        required = max(cls.ECHO_MIN_CHARS, int(len(window) * 0.5))
        if heard in window:
            return len(heard) >= required
        return len(heard) >= required and SequenceMatcher(
            None, heard[-40:], window[-120:]).ratio() >= 0.8

    def _input_noise(self, text):
        heard = normalize(text)
        if not heard or re.fullmatch(r"[嗯啊哦呃额唔]+", heard):
            return True
        ctx = self._playback or self._last_barge_context or {}
        recent = "".join(
            event.get("text", "") for event in ctx.get("text_events", [])
            if time.monotonic() - event.get("at_mono", 0) <= 6.0)
        if ctx is self._last_barge_context and time.monotonic() - ctx.get("ended_mono", 0) > self.ECHO_TAIL_SECONDS:
            return False
        spoken = recent or ctx.get("reply_text", "")
        return self._echo_like(heard, spoken)

    async def process_frame(self, frame, direction: FrameDirection):
        if self._closing:
            return
        await super().process_frame(frame, direction)

        if isinstance(frame, VADUserStartedSpeakingFrame):
            if self._capture is not None and \
                    self._capture.modes.get(self._capture.current, "always") == "always":
                # Passive VAD is neither speaker identity nor intent; the Host
                # routes facts, and background speech cannot start business work.
                return
            if os.environ.get("DSH_TEST_DISABLE_BARGE_IN") == "1":
                self._barge_candidate = None
                return
            await self._start_barge_candidate()
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._barge_candidate is not None and not self._barge_candidate.get("confirmed"):
                self._barge_candidate["vad_stopped_mono"] = time.monotonic()
            return

        if isinstance(frame, (InterimTranscriptionFrame, TranscriptionFrame)):
            final = isinstance(frame, TranscriptionFrame)
            text = (frame.text or "").strip()
            if not text:
                return
            if self._input_noise(text):
                await self._media_reject_transcript(frame, final)
                return
            await self._report_transcript_fact(frame, final)
            if not final:
                await self._handle_barge_interim(frame)
            return

        await self.push_frame(frame, direction)

    async def _media_reject_transcript(self, frame, final: bool) -> None:
        """Echo/noise is a media-layer drop; it must not become a fact or task."""
        candidate = self._barge_candidate
        if candidate is not None and self._echo_like(
                normalize(frame.text), normalize(candidate.get("recent_window") or candidate.get("reply_text", ""))):
            self.metrics["barge_rejected_echo"] += 1
            self._barge_candidate = None
            self._cancel_barge_timeout()
            await self._restore_duck(candidate)
        if final:
            self._echo_transcript_dropped += 1
            self.metrics["echo_transcript_dropped"] += 1
            capture_id = (frame.metadata or {}).get("capture_id")
            if capture_id:
                await self._send_rtvi({
                    "type": "capture-rejected",
                    "captureId": capture_id,
                    "utteranceId": (frame.metadata or {}).get("utterance_id"),
                })

    async def _report_transcript_fact(self, frame, final: bool) -> None:
        metadata = frame.metadata or {}
        capture_id = metadata.get("capture_id") or (self._capture.current if self._capture is not None else "")
        if not capture_id:
            # Fail closed: no identity -> no fact. Never invent a capture identity.
            self.metrics["facts_without_capture"] += 1
            return
        passage_id = metadata.get("provider_item_id") or metadata.get("item_id")
        utterance_id = metadata.get("utterance_id") or passage_id
        item_id = passage_id or utterance_id
        if not item_id:
            item_id = f"{capture_id}:{self.metrics['partial_facts'] + self.metrics['final_facts'] + 1}"
        if not utterance_id:
            utterance_id = item_id
        mode = metadata.get("input_mode")
        if mode not in ("hold", "toggle", "always"):
            mode = (self._capture.modes.get(capture_id) if self._capture is not None else None) or "always"
        key = (capture_id, item_id)
        if not final:
            if self._item_last_partial.get(key) == (frame.text or "").strip():
                self.metrics["duplicate_partials"] += 1
                return
            self._item_last_partial[key] = (frame.text or "").strip()
        revision = self._item_revisions.get(key, 0) + 1
        self._item_revisions[key] = revision
        if len(self._item_revisions) > 512:
            self._item_revisions.pop(next(iter(self._item_revisions)))
            self._item_last_partial.pop(next(iter(self._item_last_partial), None), None)
        item = {
            "kind": "asr.final" if final else "asr.partial",
            "itemId": item_id,
            "utteranceId": utterance_id,
            "revision": revision,
            "text": (frame.text or "").strip(),
            "at": now_iso(),
        }
        confidence = metadata.get("confidence")
        # Confidence is a nullable provider field: pass it through only when the
        # provider actually supplied a number; never fabricate one.
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            item["confidence"] = float(confidence)
        self._capture_id = capture_id
        self._capture_mode = mode
        self._capture_state = "transcribing"
        if final:
            self.metrics["final_facts"] += 1
        else:
            self.metrics["partial_facts"] += 1
        await self._report_facts([item], capture_id, mode, "transcribing")
        # Thin transport echo for the WebRTC preview; no business fields
        # (requiresConfirmation / queue decisions are Host-owned now).
        await self._send_rtvi({
            "type": "capture-transcript",
            "text": item["text"],
            "final": final,
            "captureId": capture_id,
            "utteranceId": utterance_id,
        })

    # ---- media barge-in / duck -----------------------------------------
    async def _start_barge_candidate(self) -> None:
        current = self._playback
        if current is None or not current.get("open"):
            # The bot already finished speaking. Treating this speech as a barge of the
            # finished playback made the first two words confirm an interruption, ducked
            # volume, and closed the capture early; the rest of the sentence then arrived
            # as "late". A new utterance starts a normal capture instead.
            self._barge_candidate = None
            return
        probe_log(
            f"[g3-probe] vad_started_bridge playback={current.get('playback_id') if current else None} "
            f"epoch_ms={round(time.time() * 1000)} mono={time.monotonic():.3f}"
        )
        confirmed_key = str(current.get("playback_id")) if current else None
        if confirmed_key and confirmed_key in self._barge_confirmed_keys:
            self.metrics["barge_duplicates_ignored"] += 1
            self._barge_candidate = None
            return
        ctx = None
        if current is not None and current.get("open") and current.get("text_events"):
            ctx = {**current, "context_source": "active"}
        elif self._last_barge_context is not None and \
                time.monotonic() - self._last_barge_context.get("ended_mono", 0) < 30.0:
            ctx = {**self._last_barge_context, "context_source": "playback-tail"}
        if ctx is None:
            self._barge_candidate = None
            return
        if self._barge_candidate is not None and \
                self._barge_candidate.get("playback_id") == ctx.get("playback_id"):
            logger.info(f"[barge] duplicate VAD merged into active candidate playback={ctx.get('playback_id')}")
            return
        now_mono = time.monotonic()
        events = ctx.get("text_events") or []
        recent = "".join(e.get("text", "") for e in events if now_mono - e.get("at_mono", 0) <= 6.0)
        if not recent:
            recent = ctx.get("reply_text", "")[-120:]
        candidate = {
            "candidate_id": f"{ctx.get('playback_id')}-{round(time.time() * 1000)}",
            "started_mono": now_mono,
            "playback_id": ctx.get("playback_id"),
            "turn_id": ctx.get("turn_id"),
            "reply_text": ctx.get("reply_text", ""),
            "recent_window": recent,
            "context_source": ctx.get("context_source"),
            "text": "",
            "asr_updates": [],
            "vad_stopped_mono": None,
            "confirmed": False,
            "capture_id": self._capture_id,
        }
        self._barge_candidate = candidate
        self.metrics["barge_candidates"] += 1
        self._cancel_barge_timeout()
        self._barge_timeout_task = asyncio.create_task(self._barge_timeout(candidate))
        duck_key = str(ctx.get("playback_id"))
        state = self._duck_state.setdefault(duck_key, {"used": 0, "cooldown_until": 0.0})
        if len(self._duck_state) > 200:
            self._duck_state = dict(list(self._duck_state.items())[-100:])
        if time.monotonic() >= state["cooldown_until"]:
            state["used"] += 1
            self.metrics["duck_applied"] += 1
            await self._send_rtvi({
                "type": "duck-playback",
                "candidateId": candidate["candidate_id"],
                "playbackId": candidate.get("playback_id"),
                "turnId": candidate.get("turn_id"),
                "factor": 0.3,
                "epochMs": round(time.time() * 1000),
            })
        else:
            self.metrics["duck_skipped_limit"] += 1
        logger.info(
            f"[barge] candidate playback={ctx.get('playback_id')} source={ctx.get('context_source')} "
            f"id={candidate['candidate_id']} (awaiting ASR confirmation)"
        )

    async def _barge_timeout(self, cand: dict, timeout_s: float = 3.0):
        try:
            await asyncio.sleep(timeout_s)
            if self._barge_candidate is not cand:
                return
            if cand.get("confirmed"):
                self._barge_candidate = None
                await self._restore_duck(cand)
                return
            self.metrics["barge_rejected_short"] += 1
            self._barge_candidate = None
            await self._restore_duck(cand)
            logger.info(f"[barge] candidate timeout -> restored volume id={cand.get('candidate_id')}")
        except asyncio.CancelledError:
            return

    async def _handle_barge_interim(self, frame) -> None:
        candidate = self._barge_candidate
        if candidate is None:
            return
        text = (frame.text or "").strip()
        if text:
            candidate["text"] = text
        age = time.monotonic() - candidate["started_mono"]
        if age > 3.0:
            self.metrics["barge_rejected_short"] += 1
            self._barge_candidate = None
            self._cancel_barge_timeout()
            await self._restore_duck(candidate)
            return
        if age >= 0.15 and text:
            heard = normalize(text)
            candidate["asr_updates"].append(heard)
            candidate["asr_updates"] = candidate["asr_updates"][-10:]
            spoken = normalize(candidate.get("recent_window") or candidate.get("reply_text", ""))
            if len(heard) >= 2 and spoken:
                echo = heard in spoken or SequenceMatcher(
                    None, heard[-40:], spoken[-80:]).ratio() >= 0.7
                if echo:
                    self.metrics["barge_rejected_echo"] += 1
                    self._barge_candidate = None
                    self._cancel_barge_timeout()
                    await self._restore_duck(candidate)
                    logger.info("[barge] candidate rejected as echo")
                    return
            if age < 0.4:
                self.metrics["barge_pending_short"] += 1
                return
            key = str(candidate.get("playback_id"))
            if key in self._barge_confirmed_keys:
                self.metrics["barge_duplicates_ignored"] += 1
                self._barge_candidate = None
                return
            self._barge_confirmed_keys.add(key)
            if len(self._barge_confirmed_keys) > 200:
                self._barge_confirmed_keys = set(list(self._barge_confirmed_keys)[-100:])
            candidate["confirmed"] = True
            self.metrics["barge_command_confirmed"] = self.metrics.get("barge_command_confirmed", 0) + 1
            self.metrics["barge_confirmed"] += 1
            self.metrics["barge_ins"] += 1
            logger.info(
                f"[barge] CONFIRMED playback={candidate.get('playback_id')} "
                f"source={candidate.get('context_source')} (media effect only; Host owns stop)"
            )
            await self._send_rtvi({
                "type": "barge-in-confirmed",
                "playbackId": candidate.get("playback_id"),
                "turnId": candidate.get("turn_id"),
                "contextSource": candidate.get("context_source"),
                "epochMs": round(time.time() * 1000),
            })

    async def _restore_duck(self, cand: dict | None):
        if not cand:
            return
        duck_key = str(cand.get("playback_id"))
        state = self._duck_state.setdefault(duck_key, {"used": 0, "cooldown_until": 0.0})
        state["cooldown_until"] = time.monotonic() + 2.0
        await self._send_rtvi({
            "type": "restore-playback",
            "candidateId": cand.get("candidate_id"),
            "playbackId": cand.get("playback_id"),
            "turnId": cand.get("turn_id"),
            "epochMs": round(time.time() * 1000),
        })

    def _drop_stale_barge_for_capture(self, capture_id: str) -> None:
        """A cancelled capture only clears media effects it owns; never DSH work."""
        candidate = self._barge_candidate
        if candidate is not None and candidate.get("capture_id") == capture_id:
            self._barge_candidate = None
            self._cancel_barge_timeout()

    def _cancel_barge_timeout(self) -> None:
        task = self._barge_timeout_task
        self._barge_timeout_task = None
        if task is not None and not task.done():
            task.cancel()

    # ---- playback helpers ----------------------------------------------
    async def _close_playback(self, current: dict, *, interrupt: bool = False) -> None:
        """Close one playback's TTS response; only a stop may cut queued audio."""
        if not current.get("open"):
            return
        current["open"] = False
        try:
            await self.push_frame(LLMFullResponseEndFrame())
        except Exception:
            pass
        if interrupt:
            try:
                await self.broadcast_interruption()
            except Exception:
                pass

    def _remember_playback(self, current: dict) -> None:
        self._last_barge_context = {
            "playback_id": current.get("playback_id"),
            "turn_id": current.get("turn_id"),
            "reply_text": current.get("reply_text", ""),
            "text_events": list(current.get("text_events", [])),
            "audible": True,
            "ended_mono": time.monotonic(),
        }

    async def _send_rtvi(self, payload: dict) -> None:
        await self.push_frame(OutputTransportMessageUrgentFrame(message={
            "id": f"{payload.get('type', 'msg')}-{round(time.time() * 1000)}",
            "label": "rtvi-ai",
            "type": "server-message",
            "data": payload,
        }))

    # ---- worker health projection (media only, never business state) ---
    def health_state(self) -> dict:
        return {
            "connectionId": self._connection_id,
            "transport": self._transport_state,
            "host": {
                "connected": self._host_epoch is not None and not self._closing,
                "hostEpoch": self._host_epoch,
                "sessionId": self._session_id,
                "lastEventSeq": self._last_seq,
                "streaming": bool(self._host_task is not None and not self._host_task.done()),
            },
            "capture": {
                "captureId": self._capture_id,
                "mode": self._capture_mode,
                "state": self._capture_state,
                "enabled": bool(self._capture.enabled) if self._capture is not None else False,
                "revokedCount": len(self._capture.revoked) if self._capture is not None else 0,
            },
            "playback": {
                "playbackId": (self._playback or {}).get("playback_id"),
                "open": bool((self._playback or {}).get("open")),
                "finishedCount": len(self._finished_playbacks),
            },
            "metrics": dict(self.metrics),
        }


# Media commands the Host may publish on /v2/stream (kernel §2.4). Anything
# else is acknowledged as rejected instead of being guessed.
VoiceMediaBridge._COMMAND_HANDLERS = {
    "playback.stop": VoiceMediaBridge._cmd_playback_stop,
    "speech.append": VoiceMediaBridge._cmd_speech_append,
    "speech.end": VoiceMediaBridge._cmd_speech_end,
    "capture.command": VoiceMediaBridge._cmd_capture_command,
    "notice.show": VoiceMediaBridge._cmd_notice_show,
}


__all__ = [
    "VoiceMediaBridge",
    "COMMAND_TYPES",
    "DEFAULT_DESCRIPTOR",
    "normalize",
]
