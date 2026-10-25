"""DSHBridgeProcessor: Pipecat frame processor that talks to the real DSH Agent.

Bridge: the `whalegirl-g2-bridge` host plugin inside DSH web exposes a loopback
NDJSON stream per turn:
  admitted -> prompt-accepted -> assistant-start -> text* -> assistant-end -> turn-end

Key semantics implemented here:
- one voice utterance = one DSH turn (mapped to sessionId + requestId + DSH turn)
- streaming assistant text deltas are forwarded as Pipecat TextFrames, so TTS
  aggregates sentences (no per-token TTS request)
- barge-in (VAD user started while the bot is speaking) stops playback only;
  the DSH turn keeps running and its remaining text is dropped (late output isolation)
- explicit cancel phrases call the bridge /cancel endpoint (real DSH cancel, with
  keepInbox=true); playback stop and task cancel are separate paths
- approvals are never granted here: approval/tool session events are only counted
  and logged, DSH keeps authority
- new utterances that arrive while a DSH turn is active are queued locally until
  the current turn finishes (or is cancelled), preserving DSH's turn authority
"""

from __future__ import annotations

import asyncio
import json
import asyncio
import os
import re
import time
from collections import deque
from difflib import SequenceMatcher

import aiohttp
from loguru import logger

from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    InterimTranscriptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    OutputTransportMessageUrgentFrame,
    TextFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

DEFAULT_DESCRIPTOR = "/tmp/whalegirl-g2/home/whalegirl-g2/descriptor.json"
CANCEL_PHRASES = ("取消", "停止", "停下", "别说了", "不用了", "stop", "cancel")


def _is_cancel(text: str) -> bool:
    lowered = text.strip().lower()
    return any(phrase in lowered for phrase in CANCEL_PHRASES)


INTERRUPT_COMMANDS = ("停一下", "停下", "停止", "暂停", "取消", "等一下", "别说了", "别播", "打断", "先停")
INTERRUPT_EXACT = {"停", "停啊", "停吧"}


def _is_interrupt_command(text: str) -> bool:
    """Only explicit imperative phrases. A bare '停' inside another word (e.g. 停留)
    must not count as an interrupt; this caused a pure-playback false barge-in."""
    lowered = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", (text or "").strip().lower())
    if not lowered:
        return False
    if lowered in INTERRUPT_EXACT:
        return True
    return any(phrase in lowered for phrase in INTERRUPT_COMMANDS)


class DSHBridgeProcessor(FrameProcessor):
    def __init__(self, descriptor_path: str = ""):
        super().__init__(name="DSHBridgeProcessor")
        self._descriptor_path = descriptor_path or os.environ.get("DSH_BRIDGE_DESCRIPTOR", DEFAULT_DESCRIPTOR)
        self._session: aiohttp.ClientSession | None = None
        self._current: dict | None = None
        self._pending: deque[str] = deque()
        self._turn_seq = 0
        self._last_session_id: str | None = None
        self._quarantined = False
        self._quarantine_reason: str | None = None
        self._last_request_text: str | None = None
        self._barge_candidate: dict | None = None
        self._last_barge_context: dict | None = None
        self._barge_confirmed_keys: set[str] = set()
        self._barge_timeout_task: asyncio.Task | None = None
        self._duck_state: dict[str, dict] = {}
        self.metrics: dict = {
            "turns_started": 0,
            "turns_completed": 0,
            "cancel_requests": 0,
            "cancel_confirmed": 0,
            "cancel_unconfirmed": 0,
            "text_deltas": 0,
            "chars_streamed": 0,
            "barge_ins": 0,
            "barge_candidates": 0,
            "barge_rejected_echo": 0,
            "barge_confirmed": 0,
            "barge_duplicates_ignored": 0,
            "barge_pending_short": 0,
            "barge_rejected_short": 0,
            "echo_transcript_dropped": 0,
            "barge_command_confirmed": 0,
            "barge_noncommand_pending": 0,
            "duck_applied": 0,
            "duck_skipped_limit": 0,
            "late_text_dropped": 0,
            "approval_events": 0,
            "finalized_reasons": [],
            "dsh_first_text_samples": [],
            "dsh_turn_samples": [],
            "dsh_turn_epoch_samples": [],
            "quarantine_blocks": 0,
            "execution_unknown": 0,
            "tool_events": 0,
            "errors": 0,
            "recent_turns": [],
        }

    # ---- lifecycle -----------------------------------------------------
    async def cleanup(self):
        await self._close_session()
        current = self._current
        if current:
            task = current.get("task")
            if task:
                self.create_task(self._cancel_task_quietly(task))
        await super().cleanup()

    async def _close_session(self):
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    def _load_descriptor(self) -> dict:
        with open(self._descriptor_path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    async def _cancel_task_quietly(self, task):
        try:
            await self.cancel_task(task)
        except Exception:
            pass

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    def _cancel_barge_timeout(self):
        task = self._barge_timeout_task
        self._barge_timeout_task = None
        if task is not None and not task.done():
            task.cancel()

    async def _barge_timeout(self, cand: dict, timeout_s: float = 3.0):
        try:
            await asyncio.sleep(timeout_s)
            if self._barge_candidate is not cand:
                return
            if cand.get("confirmed"):
                return
            self.metrics["barge_rejected_short"] += 1
            self._barge_candidate = None
            await self._restore_duck(cand)
            logger.info(f"[dsh] barge-in candidate timeout -> restored volume id={cand.get('candidate_id')}")
        except asyncio.CancelledError:
            return

    async def _send_rtvi(self, payload: dict):
        await self.push_frame(OutputTransportMessageUrgentFrame(message={
            "id": f"{payload.get('type','msg')}-{round(time.time()*1000)}",
            "label": "rtvi-ai",
            "type": "server-message",
            "data": payload,
        }))

    async def _restore_duck(self, cand: dict | None):
        if not cand:
            return
        turn_key = str(cand.get("turn_key"))
        st = self._duck_state.setdefault(turn_key, {"used": 0, "cooldown_until": 0.0})
        st["cooldown_until"] = time.monotonic() + 2.0
        await self._send_rtvi({
            "type": "restore-playback",
            "candidateId": cand.get("candidate_id"),
            "requestId": cand.get("request_id"),
            "turnKey": cand.get("turn_key"),
            "epochMs": round(time.time() * 1000),
        })

    # ---- frame handling -------------------------------------------------
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, VADUserStartedSpeakingFrame):
            cur = self._current
            logger.info(
                f"[g3-probe] vad_started_bridge turn={cur.get('turn_key') if cur else None} "
                f"request={cur.get('request_id') if cur else None} dsh_turn={cur.get('dsh_turn') if cur else None} "
                f"audible={cur.get('audible') if cur else None} text_started={cur.get('text_started') if cur else None} "
                f"epoch_ms={round(time.time()*1000)} mono={time.monotonic():.3f}"
            )
            if os.environ.get('DSH_TEST_DISABLE_BARGE_IN') == '1':
                self._barge_candidate = None
                return
            dup_key = cur.get("turn_key") if cur is not None else (self._last_barge_context or {}).get("turn_key")
            if dup_key and dup_key in self._barge_confirmed_keys:
                self.metrics["barge_duplicates_ignored"] += 1
                self._barge_candidate = None
                logger.info(f"[dsh] duplicate barge-in candidate ignored turn={dup_key} (turn already confirmed)")
                return
            ctx = None
            if cur is not None and cur.get("audible") and cur.get("text_started"):
                ctx = {**cur, "context_source": "active"}
            elif self._last_barge_context is not None and time.monotonic() - self._last_barge_context["ended_mono"] < 30.0 and self._last_barge_context.get("audible"):
                ctx = {**self._last_barge_context, "context_source": "playback-tail"}
            if ctx is not None and ctx.get("turn_key") in self._barge_confirmed_keys:
                self._barge_candidate = None
                self.metrics["barge_duplicates_ignored"] += 1
                logger.info(f"[dsh] duplicate barge-in candidate ignored turn={ctx.get('turn_key')}")
            elif ctx is not None and self._barge_candidate is not None and self._barge_candidate.get("turn_key") == ctx.get("turn_key"):
                logger.info(f"[dsh] duplicate VAD merged into active candidate turn={ctx.get('turn_key')} (no re-duck/no timer reset)")
                return
            elif ctx is not None:
                now_mono = time.monotonic()
                events = ctx.get("text_events") or []
                recent = "".join(e.get("text", "") for e in events if now_mono - e.get("at_mono", 0) <= 6.0)
                if not recent:
                    recent = ctx.get("reply_text", "")[-120:]
                candidate_id = f"{ctx.get('turn_key')}-{round(time.time()*1000)}"
                self._barge_candidate = {
                    "candidate_id": candidate_id,
                    "started_mono": now_mono,
                    "started_epoch_ms": round(time.time() * 1000),
                    "turn_key": ctx.get("turn_key"),
                    "request_id": ctx.get("request_id"),
                    "dsh_turn": ctx.get("dsh_turn"),
                    "reply_text": ctx.get("reply_text", ""),
                    "recent_window": recent,
                    "context_source": ctx.get("context_source"),
                    "text": "",
                    "asr_updates": [],
                    "vad_stopped_mono": None,
                }
                self.metrics["barge_candidates"] += 1
                self._cancel_barge_timeout()
                self._barge_timeout_task = asyncio.create_task(self._barge_timeout(self._barge_candidate))
                turn_key = str(ctx.get("turn_key"))
                st = self._duck_state.setdefault(turn_key, {"used": 0, "cooldown_until": 0.0})
                if len(self._duck_state) > 200:
                    self._duck_state = dict(list(self._duck_state.items())[-100:])
                now_mono2 = time.monotonic()
                ducked = False
                if st["used"] < 2 and now_mono2 >= st["cooldown_until"]:
                    st["used"] += 1
                    ducked = True
                    self.metrics["duck_applied"] += 1
                    await self._send_rtvi({
                        "type": "duck-playback",
                        "candidateId": candidate_id,
                        "requestId": ctx.get("request_id"),
                        "turnKey": ctx.get("turn_key"),
                        "factor": 0.3,
                        "epochMs": round(time.time() * 1000),
                    })
                else:
                    self.metrics["duck_skipped_limit"] += 1
                    logger.info(
                        f"[dsh] ducking skipped turn={turn_key} used={st['used']} "
                        f"cooldown={max(0.0, st['cooldown_until']-now_mono2):.2f}s"
                    )
                logger.info(
                    f"[dsh] barge-in candidate turn={ctx.get('turn_key')} source={ctx.get('context_source')} "
                    f"id={candidate_id} duck={ducked} used={st['used']} (awaiting ASR confirmation)"
                )
            else:
                self._barge_candidate = None
            # Do not forward raw VAD downstream: the client must only react to a
            # confirmed barge-in, not to every VAD trigger.
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._barge_candidate is not None and not self._barge_candidate.get("confirmed"):
                self._barge_candidate["vad_stopped_mono"] = time.monotonic()
            return

        if isinstance(frame, InterimTranscriptionFrame):
            cand = self._barge_candidate
            if cand is not None:
                text = (frame.text or "").strip()
                if text:
                    cand["text"] = text
                age = time.monotonic() - cand["started_mono"]
                if age > 3.0:
                    self.metrics["barge_rejected_short"] += 1
                    cand_exp = self._barge_candidate
                    self._barge_candidate = None
                    self._cancel_barge_timeout()
                    await self._restore_duck(cand_exp)
                    logger.info("[dsh] barge-in candidate expired without confirmation")
                    await self.push_frame(frame, direction); return
                if age >= 0.15 and text:
                    norm = lambda s: re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s or "").lower()
                    heard = norm(text)
                    cand["asr_updates"].append(heard)
                    cand["asr_updates"] = cand["asr_updates"][-10:]
                    spoken = norm(cand.get("recent_window") or cand.get("reply_text", ""))
                    echo = False
                    if len(heard) >= 2 and spoken:
                        if heard in spoken:
                            echo = True
                        else:
                            ratio = SequenceMatcher(None, heard[-40:], spoken[-80:]).ratio()
                            echo = ratio >= 0.7
                    if echo:
                        self.metrics["barge_rejected_echo"] += 1
                        cand_echo = self._barge_candidate
                        self._barge_candidate = None
                        self._cancel_barge_timeout()
                        await self._restore_duck(cand_echo)
                        logger.info(f"[dsh] barge-in candidate rejected as echo: asr={text!r} window_tail={spoken[-60:]!r}")
                        return
                    # MVP contract: only an explicit interrupt command may barge in.
                    # No generic "enough short ASR text" fallback.
                    if not _is_interrupt_command(heard):
                        self.metrics["barge_noncommand_pending"] += 1
                        logger.info(f"[dsh] barge-in non-command ASR pending: asr={text!r} age={age:.2f} window_tail={spoken[-50:]!r}")
                        if age > 3.0:
                            self.metrics["barge_rejected_short"] += 1
                            cand_exp2 = self._barge_candidate
                            self._barge_candidate = None
                            self._cancel_barge_timeout()
                            await self._restore_duck(cand_exp2)
                            logger.info("[dsh] barge-in candidate expired (non-command)")
                        await self.push_frame(frame, direction); return
                    if age < 0.4:
                        self.metrics["barge_pending_short"] += 1
                        logger.info(f"[dsh] barge-in command pending stabilization: asr={text!r} age={age:.2f}")
                        await self.push_frame(frame, direction); return
                    self.metrics["barge_command_confirmed"] += 1
                    logger.info(f"[dsh] barge-in COMMAND accepted: asr={text!r} age={age:.2f} window_tail={spoken[-50:]!r}")
                    key = str(cand.get("turn_key"))
                    if key in self._barge_confirmed_keys:
                        self.metrics["barge_duplicates_ignored"] += 1
                        logger.info(f"[dsh] duplicate confirmation ignored turn={key}")
                        self._barge_candidate = None
                        return
                    self._cancel_barge_timeout()
                    self._barge_confirmed_keys.add(key)
                    if len(self._barge_confirmed_keys) > 200:
                        self._barge_confirmed_keys = set(list(self._barge_confirmed_keys)[-100:])
                    if self._current is not None and self._current.get("turn_key") == cand.get("turn_key"):
                        self._current["audible"] = False
                    self.metrics["barge_ins"] += 1
                    self.metrics["barge_confirmed"] += 1
                    logger.info(
                        f"[dsh] barge-in CONFIRMED turn={cand.get('turn_key')} source={cand.get('context_source')} asr={text!r} "
                        f"epoch_ms={round(time.time()*1000)} mono={time.monotonic():.3f}"
                    )
                    await self.broadcast_interruption()
                    payload = {
                        "type": "barge-in-confirmed",
                        "requestId": cand.get("request_id"),
                        "turnId": cand.get("dsh_turn"),
                        "turnKey": cand.get("turn_key"),
                        "contextSource": cand.get("context_source"),
                        "audioGeneration": None,
                        "epochMs": round(time.time() * 1000),
                    }
                    await self.push_frame(OutputTransportMessageUrgentFrame(message={
                        "id": f"barge-{key}-{round(time.time()*1000)}",
                        "label": "rtvi-ai",
                        "type": "server-message",
                        "data": payload,
                    }))
                    self._barge_candidate = None
                    return
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if not text:
                await self.push_frame(frame, direction)
                return
            if _is_cancel(text):
                logger.info(f"[dsh] cancel utterance: {text!r}")
                self._pending.clear()
                await self._cancel_current()
                return
            # P1: drop final transcripts that closely match the recent spoken window
            norm = lambda s: re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s or "").lower()
            heard = norm(text)
            ctx = self._last_barge_context or ({**self._current} if self._current else {})
            events = ctx.get("text_events") or []
            recent = "".join(e.get("text", "") for e in events if time.monotonic() - e.get("at_mono", 0) <= 6.0)
            window = norm(recent or ctx.get("reply_text", ""))
            if len(heard) >= 2 and window and (heard in window or SequenceMatcher(None, heard[-40:], window[-120:]).ratio() >= 0.8):
                self.metrics["echo_transcript_dropped"] += 1
                logger.info(f"[dsh] echoed transcript dropped: {text!r}")
                return
            if self._quarantined and text not in ("重试", "retry") and self._quarantine_reason == "cancel-unconfirmed":
                # Only a cancel-unconfirmed quarantine may be released by the bridge's
                # matching late turn-end. Unknown-execution state stays locked.
                await self._sync_quarantine()
            if self._quarantined and text not in ("重试", "retry"):
                self.metrics.delete("quarantine_blocks") if False else None
                self.metrics.setdefault("blocked_while_quarantined", 0)
                self.metrics["blocked_while_quarantined"] += 1
                self._last_request_text = text
                await self.push_frame(TTSSpeakFrame(text="上一个任务的状态尚未确认，暂时不能开始新回合。请说重试，或等我在 DSH 中确认后再试。"))
                return
            if text in ("重试", "retry") and self._quarantined:
                await self._try_recover()
                if self._quarantined:
                    await self.push_frame(TTSSpeakFrame(text="状态仍未确认，恢复失败。你可以在 DSH 里检查该会话，或新建会话。"))
                    return
                # Recovery is NOT automatic re-execution: after recovering, require
                # an explicit new request (side effects may already have happened).
                await self.push_frame(TTSSpeakFrame(text="会话已恢复。请重新说一次你的请求。"))
                return
            self._pending.append(text)
            if self._current is None:
                await self._start_next_turn()
            else:
                logger.info(
                    f"[dsh] queued utterance behind active turn {self._current.get('turn_key')}: {text!r}"
                )
            return

        await self.push_frame(frame, direction)

    # ---- turn driver ----------------------------------------------------
    def queue_state(self):
        cur = self._current
        return {
            'current': cur.get('turn_key') if cur else None,
            'request_id': cur.get('request_id') if cur else None,
            'dsh_turn': cur.get('dsh_turn') if cur else None,
            'audible': cur.get('audible') if cur else None,
            'text_started': cur.get('text_started') if cur else None,
            'reply_chars': len(cur.get('reply_text', '')) if cur else 0,
            'barge_candidate': bool(self._barge_candidate),
            'barge_candidate_text': (self._barge_candidate or {}).get('text'),
            'barge_metrics': {k: self.metrics.get(k) for k in ('barge_candidates','barge_rejected_echo','barge_confirmed','barge_ins','barge_duplicates_ignored','barge_command_confirmed','barge_noncommand_pending','barge_pending_short','barge_rejected_short','duck_applied','duck_skipped_limit')},
            'pending': list(self._pending),
            'quarantined': self._quarantined,
            'turns_started': self.metrics.get('turns_started'),
            'turns_completed': self.metrics.get('turns_completed'),
            'errors': self.metrics.get('errors'),
        }

    async def _start_next_turn(self):
        if not self._pending:
            return
        text = self._pending.popleft()
        self._turn_seq += 1
        current = {
            "turn_key": f"voice-{self._turn_seq}",
            "request_id": None,
            "dsh_turn": None,
            "session_id": self._last_session_id,
            "text": text,
            "submitted_at": time.monotonic(),
            "submitted_epoch_ms": round(time.time() * 1000),
            "audible": True,
            "text_started": False,
            "cancelled": False,
            "task": None,
        }
        self._current = current
        current["task"] = self.create_task(self._run_turn(current, text), name=f"dsh-{current['turn_key']}")
        self.metrics["turns_started"] += 1

    async def _run_turn(self, current: dict, text: str):
        turn_key = current["turn_key"]
        started = time.monotonic()
        try:
            descriptor = self._load_descriptor()
            port = descriptor["port"]
            token = descriptor["token"]
            url = f"http://127.0.0.1:{port}/turn"
            headers = {"Authorization": f"Bearer {token}", "content-type": "application/json"}
            logger.info(f"[dsh] turn {turn_key} -> DSH: {text!r}")
            async with self._get_session().post(
                url, json={"text": text}, headers=headers, timeout=aiohttp.ClientTimeout(total=180)
            ) as response:
                if response.status == 423:
                    body = await response.text()
                    current["quarantined"] = True
                    self._quarantined = True
                    self.metrics.setdefault("quarantine_blocks", 0)
                    self.metrics["quarantine_blocks"] += 1
                    logger.warning(f"[dsh] turn {turn_key} blocked by session quarantine: {body[:160]}")
                    await self.push_error_frame(ErrorFrame(error="DSH session is quarantined: previous execution state unknown"))
                    return
                if response.status != 200:
                    body = await response.text()
                    raise RuntimeError(f"bridge HTTP {response.status}: {body[:200]}")
                async for raw in response.content:
                    line = raw.decode("utf-8").strip()
                    if not line:
                        continue
                    event = json.loads(line)
                    await self._handle_bridge_event(current, event)
            if not current.get("cancelled"):
                self.metrics["turns_completed"] += 1
            logger.info(
                f"[dsh] turn {turn_key} completed session={current.get('session_id')} "
                f"request={current.get('request_id')} dsh_turn={current.get('dsh_turn')} "
                f"chars={len(current.get('reply_text', ''))} duration_ms={round((time.monotonic()-started)*1000)}"
            )
        except asyncio.CancelledError:
            logger.info(f"[dsh] turn {turn_key} task cancelled locally")
            raise
        except Exception as exc:
            self.metrics["errors"] += 1
            logger.warning(f"[dsh] turn {turn_key} failed: {exc}")
            await self.push_error_frame(ErrorFrame(error=f"DSH turn failed: {exc}"))
            if current.get("request_id"):
                current["execution_unknown"] = True
                self._quarantined = True
                self._quarantine_reason = "execution-unknown"
                self.metrics["execution_unknown"] += 1
                logger.warning(f"[dsh] {turn_key} execution state UNKNOWN after bridge/DSH failure; session quarantined, no retry")
            if current.get("audible"):
                try:
                    await self.push_frame(TTSSpeakFrame(text="语音服务连接中断，任务状态未知，我已暂停新的请求。请检查 DSH 后再决定是否重试。"))
                except Exception:
                    pass
        finally:
            if current.get("text_started") and current.get("audible"):
                try:
                    await self.push_frame(LLMFullResponseEndFrame())
                except Exception:
                    pass
            self.metrics["finalized_reasons"].append(
                {"turn_key": turn_key, "reason": current.get("finalized_reason"), "cancel_state": current.get("cancel_state")}
            )
            self.metrics["finalized_reasons"] = self.metrics["finalized_reasons"][-10:]
            self.metrics["recent_turns"].append(
                {
                    "turn_key": turn_key,
                    "cancel_state": current.get("cancel_state"),
                    "session_id": current.get("session_id"),
                    "request_id": current.get("request_id"),
                    "dsh_turn": current.get("dsh_turn"),
                    "chars": len(current.get("reply_text", "")),
                    "first_text_ms": current.get("first_text_ms"),
                    "turn_ms": current.get("turn_ms"),
                    "submitted_epoch_ms": current.get("submitted_epoch_ms"),
                    "first_text_epoch_ms": current.get("first_text_epoch_ms"),
                    "turn_end_epoch_ms": current.get("turn_end_epoch_ms"),
                    "completed": current.get("completed", False),
                    "cancelled": current.get("cancelled", False),
                    "audible": current.get("audible", True),
                }
            )
            self.metrics["recent_turns"] = self.metrics["recent_turns"][-10:]
            if current.get('text_started') and current.get('reply_text'):
                self._last_barge_context = {
                    'turn_key': current.get('turn_key'),
                    'request_id': current.get('request_id'),
                    'dsh_turn': current.get('dsh_turn'),
                    'reply_text': current.get('reply_text'),
                    'text_events': list(current.get('text_events', [])),
                    'audible': current.get('audible', True),
                    'ended_mono': time.monotonic(),
                }
            if self._current is current:
                self._current = None
                if self._pending:
                    self.create_task(self._start_next_turn(), name="dsh-next-turn")
            # reset connection state for the next turn

    async def _handle_bridge_event(self, current: dict, event: dict):
        kind = event.get("type")
        session_id = event.get("sessionId") or current.get("session_id")
        if session_id:
            self._last_session_id = session_id
            current["session_id"] = session_id
        if kind == "admitted":
            current["request_id"] = event.get("requestId")
            logger.info(f"[dsh] {current['turn_key']} admitted session={session_id} request={current.get('request_id')}")
        elif kind == "assistant-start":
            current["dsh_turn"] = event.get("turn")
            logger.info(
                f"[dsh] {current['turn_key']} assistant-start session={session_id} dsh_turn={event.get('turn')} step={event.get('step')}"
            )
        elif kind == "text":
            delta = event.get("text") or ""
            if not delta:
                return
            current.setdefault("reply_text", "")
            current["reply_text"] += delta
            current.setdefault("text_events", []).append({
                "text": delta,
                "at_mono": time.monotonic(),
                "at_epoch_ms": round(time.time() * 1000),
            })
            current["text_events"] = current["text_events"][-80:]
            if not current.get("audible"):
                self.metrics["late_text_dropped"] += 1
                return
            if not current.get("text_started"):
                current["text_started"] = True
                logger.info(
                    f"[g3-probe] playback-identity SEND request={current.get('request_id')} "
                    f"turn={current.get('dsh_turn')} key={current.get('turn_key')} epoch_ms={round(time.time()*1000)}"
                )
                await self.push_frame(OutputTransportMessageUrgentFrame(message={
                    "id": f"playback-{current.get('turn_key')}-{round(time.time()*1000)}",
                    "label": "rtvi-ai",
                    "type": "server-message",
                    "data": {
                        "type": "playback-identity",
                        "requestId": current.get("request_id"),
                        "turnId": current.get("dsh_turn"),
                        "turnKey": current.get("turn_key"),
                        "epochMs": round(time.time()*1000),
                    },
                }))
                if current.get("submitted_at"):
                    current["first_text_ms"] = round((time.monotonic() - current["submitted_at"]) * 1000)
                    current["first_text_epoch_ms"] = round(time.time() * 1000)
                    self.metrics["dsh_first_text_samples"].append(current["first_text_ms"])
                    self.metrics["dsh_first_text_samples"] = self.metrics["dsh_first_text_samples"][-200:]
                await self.push_frame(LLMFullResponseStartFrame())
            self.metrics["text_deltas"] += 1
            self.metrics["chars_streamed"] += len(delta)
            await self.push_frame(TextFrame(text=delta))
        elif kind == "assistant-end":
            logger.info(f"[dsh] {current['turn_key']} assistant-end outcome={event.get('outcome')}")
        elif kind == "cancel-requested":
            current["cancel_state"] = "requested"
            logger.info(f"[dsh] {current['turn_key']} cancel requested (playback stopped; waiting for DSH confirmation)")
        elif kind == "finalized":
            reason = event.get("reason")
            current["finalized_reason"] = reason
            if reason == "cancel-unconfirmed":
                self.metrics["cancel_unconfirmed"] += 1
                current["cancel_state"] = "unconfirmed"
                logger.warning(f"[dsh] {current['turn_key']} cancel UNCONFIRMED by DSH; local turn lease released, session kept")
            elif current.get("cancelled") and event.get("turnReason", {}).get("kind") == "aborted":
                self.metrics["cancel_confirmed"] += 1
                current["cancel_state"] = "confirmed"
                logger.info(f"[dsh] {current['turn_key']} cancel confirmed via finalize reason={reason}")
            else:
                logger.info(f"[dsh] {current['turn_key']} finalized reason={reason}")
        elif kind == "turn-end":
            current["completed"] = (event.get("reason") or {}).get("kind") == "completed"
            if current.get("submitted_at"):
                self.metrics["dsh_turn_epoch_samples"].append({
                    "request_id": current.get("request_id"),
                    "turn_key": current.get("turn_key"),
                    "submitted_epoch_ms": current.get("submitted_epoch_ms"),
                    "first_text_epoch_ms": current.get("first_text_epoch_ms"),
                    "turn_end_epoch_ms": current.get("turn_end_epoch_ms") or round(time.time() * 1000),
                })
                self.metrics["dsh_turn_epoch_samples"] = self.metrics["dsh_turn_epoch_samples"][-200:]
                current["turn_ms"] = round((time.monotonic() - current["submitted_at"]) * 1000)
                current["turn_end_epoch_ms"] = round(time.time() * 1000)
                self.metrics["dsh_turn_samples"].append(current["turn_ms"])
                self.metrics["dsh_turn_samples"] = self.metrics["dsh_turn_samples"][-200:]
            logger.info(
                f"[dsh] {current['turn_key']} turn-end dsh_turn={event.get('turn')} reason={event.get('reason')} turn_ms={current.get('turn_ms')}"
            )
        elif kind == "session-event":
            event_type = event.get("eventType") or ""
            if event_type.startswith("approval") or event.get("approval"):
                self.metrics["approval_events"] += 1
                logger.info(f"[dsh] approval event observed (DSH remains authority): {event}")
            elif event_type in ("tool/call", "tool/result"):
                self.metrics["tool_events"] += 1
                logger.info(f"[dsh] tool event: {event_type} name={event.get('toolName')}")

    async def _cancel_watchdog(self, current: dict, task):
        try:
            await asyncio.sleep(8)
            if self._current is current and not current.get("finalized_reason"):
                self.metrics["cancel_unconfirmed"] += 1
                current["cancel_state"] = "unconfirmed"
                logger.warning(f"[dsh] {current.get('turn_key')} cancel watch timed out; marking unconfirmed")
                await self.cancel_task(task)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def _sync_quarantine(self):
        try:
            descriptor = self._load_descriptor()
            sid = self._last_session_id or descriptor.get("sessionId")
            headers = {"Authorization": f"Bearer {descriptor['token']}"}
            async with self._get_session().get(
                f"http://127.0.0.1:{descriptor['port']}/session-status?sessionId={sid}",
                headers=headers, timeout=aiohttp.ClientTimeout(total=3),
            ) as response:
                if response.status == 200:
                    body = await response.json()
                    if not body.get("quarantined") and self._quarantine_reason == "cancel-unconfirmed":
                        self._quarantined = False
                        self._quarantine_reason = None
                        logger.info("[dsh] local quarantine cleared: bridge reports not quarantined")
        except Exception as exc:
            logger.warning(f"[dsh] quarantine sync failed: {exc}")

    async def _try_recover(self):
        try:
            descriptor = self._load_descriptor()
            sid = self._last_session_id
            if not sid:
                return
            headers = {"Authorization": f"Bearer {descriptor['token']}", "content-type": "application/json"}
            async with self._get_session().post(
                f"http://127.0.0.1:{descriptor['port']}/recover", json={"sessionId": sid},
                headers=headers, timeout=aiohttp.ClientTimeout(total=5),
            ) as response:
                body = await response.text()
                logger.info(f"[dsh] recovery attempt status={response.status} body={body[:200]}")
                if response.status == 200 and json.loads(body).get("quarantineCleared"):
                    self._quarantined = False
        except Exception as exc:
            logger.warning(f"[dsh] recovery failed: {exc}")

    async def _cancel_current(self):
        current = self._current
        if current is None:
            logger.info("[dsh] cancel requested but no active turn")
            return
        descriptor = self._load_descriptor()
        session_id = current.get("session_id") or descriptor.get("sessionId")
        current["cancelled"] = True
        current["audible"] = False
        self.metrics["cancel_requests"] += 1
        logger.info(f"[dsh] cancelling DSH turn {current.get('turn_key')} session={session_id}")
        await self.broadcast_interruption()
        try:
            headers = {"Authorization": f"Bearer {descriptor['token']}", "content-type": "application/json"}
            async with self._get_session().post(
                f"http://127.0.0.1:{descriptor['port']}/cancel",
                json={"sessionId": session_id},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                body = await response.text()
                logger.info(f"[dsh] cancel response status={response.status} body={body[:200]}")
        except Exception as exc:
            self.metrics["errors"] += 1
            logger.warning(f"[dsh] cancel request failed: {exc}")
        # Do not cancel the local task here: wait for the bridge turn-end / finalized
        # frame so cancel can be confirmed. A watchdog prevents a stuck lease.
        task = current.get("task")
        if task:
            self.create_task(self._cancel_watchdog(current, task), name="dsh-cancel-watchdog")
        # _run_turn's finally starts the next pending turn after the stream closes.
