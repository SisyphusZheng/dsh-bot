"""WhaleGirl voice spike — primitive media worker (G0/G1).

Modes (env G1_MODE):
- echo  : microphone -> speaker loopback (G0 media path)
- tts   : fixed text -> DashScope Qwen3-TTS-Realtime -> speaker (G1 TTS stage)
- asr   : microphone -> Silero VAD -> DashScope Qwen3-ASR-Realtime -> transcripts (G1 ASR stage)
- loop  : microphone -> ASR -> fixed reply text -> TTS -> speaker (G1 combined)

Endpoints (all loopback, bearer token on /api/*):
- GET  /health
- GET  /stats   : sessions with counters + adapter metrics + transcript log
- POST /api/offer, PATCH /api/offer : SmallWebRTC signaling (same-origin proxied by m3/pet in test mode)

Secrets: DASHSCOPE_API_KEY stays in this process; it is never returned by an
endpoint and only read into the adapter constructors.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    OutputTransportMessageUrgentFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
    OutputAudioRawFrame,
    StartFrame,
    TextFrame,
    TTSSpeakFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.request_handler import (
    ConnectionMode,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from dashscope_services import DashScopeASRService, DashScopeTTSService
from dsh_bridge import DSHBridgeProcessor
import voice_errors

TOKEN = os.environ.get("SPIKE_TOKEN", "dev-token")
MODE = os.environ.get("G1_MODE", "echo")
API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
ASR_MODEL = os.environ.get("DASHSCOPE_ASR_MODEL", "qwen3-asr-flash-realtime")
TTS_MODEL = os.environ.get("DASHSCOPE_TTS_MODEL", "qwen3-tts-flash-realtime")
TTS_VOICE = os.environ.get("DASHSCOPE_TTS_VOICE", "Cherry")
FIXED_REPLY = os.environ.get("G1_FIXED_TEXT", "您好，我是鲸鱼娘，这是一次语音链路测试。")
DSH_BRIDGE_DESCRIPTOR = os.environ.get("DSH_BRIDGE_DESCRIPTOR", "/tmp/whalegirl-g2/home/whalegirl-g2/descriptor.json")
DSH_TEST_PREFIX = os.environ.get("DSH_TEST_PREFIX", "")
DEBUG_PROBES = os.environ.get("DSH_VOICE_DEBUG_PROBES") == "1"
DEBUG_TRANSCRIPTS = os.environ.get("SPIKE_DEBUG_TRANSCRIPTS") == "1"
STARTED_AT = time.time()

app = FastAPI(title="whalegirl-voice-spike")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
    allow_methods=["POST", "PATCH", "GET", "OPTIONS"],
    allow_headers=["*"],
)

request_handler = SmallWebRTCRequestHandler(connection_mode=ConnectionMode.MULTIPLE)
active_sessions: dict[str, asyncio.Task] = {}
SESSIONS: dict[str, dict] = {}


def authorized(request: Request) -> bool:
    return request.query_params.get("token") == TOKEN or request.headers.get("x-spike-token") == TOKEN


@app.middleware("http")
async def require_token(request, call_next):
    if request.url.path.startswith("/api/") and not authorized(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return await call_next(request)


class EchoProcessor(FrameProcessor):
    def __init__(self):
        super().__init__(name="EchoProcessor")
        self.frames_in = 0
        self.frames_out = 0
        self.energy_sum = 0.0
        self.energy_frames = 0
        self.non_silent_frames = 0
        self.last_rms = 0.0

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.frames_in += 1
            try:
                import numpy as np
                samples = np.frombuffer(frame.audio, dtype=np.int16)
                if samples.size:
                    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
                    self.last_rms = rms
                    self.energy_sum += rms
                    self.energy_frames += 1
                    if rms > 50.0:
                        self.non_silent_frames += 1
            except Exception:
                pass
            await self.push_frame(OutputAudioRawFrame(
                audio=frame.audio,
                sample_rate=frame.sample_rate,
                num_channels=frame.num_channels,
            ), FrameDirection.DOWNSTREAM)
            self.frames_out += 1
            return
        await self.push_frame(frame, direction)


class TranscriptGate(FrameProcessor):
    """Deterministic-test gate: only allow transcripts with the test prefix."""

    def __init__(self, prefix: str):
        super().__init__(name="TranscriptGate")
        self._prefix = prefix

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and not (frame.text or "").startswith(self._prefix):
            return
        await self.push_frame(frame, direction)


class FixedTextSource(FrameProcessor):
    """Emits one fixed TextFrame after StartFrame (G1 TTS stage only)."""

    def __init__(self, text: str):
        super().__init__(name="FixedTextSource")
        self._text = text
        self._sent = False

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            if not self._sent:
                self._sent = True
                print(f"[g1] fixed text queued: {self._text}", flush=True)
                await self.push_frame(TTSSpeakFrame(text=self._text), FrameDirection.DOWNSTREAM)
            return
        await self.push_frame(frame, direction)


class FixedReplyProcessor(FrameProcessor):
    """On a final transcript, emit a fixed reply text for the TTS stage (G1 only)."""

    def __init__(self, session_state: dict):
        super().__init__(name="FixedReplyProcessor")
        self._state = session_state

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            if DEBUG_TRANSCRIPTS:
                self._state.setdefault("transcripts", []).append(frame.text)
            await self.push_frame(TextFrame(text=f"你刚才说：{frame.text}。"), FrameDirection.DOWNSTREAM)
            return
        await self.push_frame(frame, direction)


def _make_transport(connection, out_sample_rate: int) -> SmallWebRTCTransport:
    return SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=16000,
            audio_out_sample_rate=out_sample_rate,
            video_in_enabled=False,
            video_out_enabled=False,
        ),
    )


class AudioEnergyProbe(FrameProcessor):
    """G3 passive observability: log mic RMS while passing frames through unchanged."""
    def __init__(self):
        super().__init__(name="G3AudioEnergyProbe")
        self._last = 0.0
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            now = time.monotonic()
            if now - self._last >= 0.1:
                self._last = now
                try:
                    import numpy as np
                    a = np.frombuffer(frame.audio, dtype=np.int16)
                    rms = float(np.sqrt(np.mean(a.astype(np.float64) ** 2))) if a.size else 0.0
                except Exception:
                    rms = -1.0
                print(f"[g3-probe] input rms={rms:.1f} epoch_ms={round(time.time()*1000)} mono={now:.3f}", flush=True)
        await self.push_frame(frame, direction)

class VADObserver(FrameProcessor):
    """G3 passive observability: log VAD start/stop transitions."""
    def __init__(self):
        super().__init__(name="G3VADObserver")
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        try:
            if isinstance(frame, VADUserStartedSpeakingFrame):
                print(f"[g3-probe] vad_started epoch_ms={round(time.time()*1000)} mono={time.monotonic():.3f}", flush=True)
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                print(f"[g3-probe] vad_stopped epoch_ms={round(time.time()*1000)} mono={time.monotonic():.3f}", flush=True)
        except Exception as exc:
            print(f"[g3-probe] observer error suppressed: {exc!r}", flush=True)
        await self.push_frame(frame, direction)


async def run_echo_pipeline(connection, session_id: str, session_state: dict) -> None:
    transport = _make_transport(connection, 16000)
    echo = EchoProcessor()
    session_state["echo"] = echo
    pipeline = Pipeline([transport.input(), echo, transport.output()])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=True, allow_interruptions=False))
    await _run_task(transport, task, session_id, session_state)


async def run_tts_pipeline(connection, session_id: str, session_state: dict) -> None:
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY is required for G1 tts mode")
    tts = DashScopeTTSService(api_key=API_KEY, model=TTS_MODEL, voice=TTS_VOICE)
    session_state["tts"] = tts
    transport = _make_transport(connection, 24000)
    pipeline = Pipeline([FixedTextSource(FIXED_REPLY), tts, transport.output()])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=True, allow_interruptions=True))
    await _run_task(transport, task, session_id, session_state)


async def run_asr_pipeline(connection, session_id: str, session_state: dict) -> None:
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY is required for G1 asr mode")
    asr = DashScopeASRService(api_key=API_KEY, model=ASR_MODEL)
    session_state["asr"] = asr
    transport = _make_transport(connection, 16000)
    pipeline = Pipeline([
        transport.input(),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(sample_rate=16000)),
        asr,
        transport.output(),
    ])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=True, allow_interruptions=True))
    await _run_task(transport, task, session_id, session_state)


async def run_loop_pipeline(connection, session_id: str, session_state: dict) -> None:
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY is required for G1 loop mode")
    asr = DashScopeASRService(api_key=API_KEY, model=ASR_MODEL)
    tts = DashScopeTTSService(api_key=API_KEY, model=TTS_MODEL, voice=TTS_VOICE)
    session_state["asr"] = asr
    session_state["tts"] = tts
    transport = _make_transport(connection, 24000)
    pipeline = Pipeline([
        transport.input(),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(sample_rate=16000)),
        asr,
        FixedReplyProcessor(session_state),
        tts,
        transport.output(),
    ])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=True, allow_interruptions=True))
    await _run_task(transport, task, session_id, session_state)


class CaptureAudioGate(FrameProcessor):
    def __init__(self, capture):
        super().__init__()
        self.capture = capture

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and not self.capture.enabled:
            frame = InputAudioRawFrame(bytes(len(frame.audio)), frame.sample_rate, frame.num_channels)
        await self.push_frame(frame, direction)


async def run_dsh_pipeline(connection, session_id: str, session_state: dict) -> None:
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY is required for G1 dsh mode")
    asr = DashScopeASRService(api_key=API_KEY, model=ASR_MODEL)
    tts = DashScopeTTSService(api_key=API_KEY, model=TTS_MODEL, voice=TTS_VOICE)
    global DSH_PROCESSOR
    bridge = DSHBridgeProcessor(DSH_BRIDGE_DESCRIPTOR, capture=asr.capture)
    DSH_PROCESSOR = bridge
    session_state["asr"] = asr
    session_state["tts"] = tts
    session_state["dsh"] = bridge
    transport = _make_transport(connection, 24000)
    middle = []
    if DSH_TEST_PREFIX:
        middle.append(TranscriptGate(DSH_TEST_PREFIX))
    pipeline = Pipeline([
        transport.input(),
        CaptureAudioGate(asr.capture),
        *([AudioEnergyProbe()] if DEBUG_PROBES else []),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(sample_rate=16000)),
        *([VADObserver()] if DEBUG_PROBES else []),
        asr,
        *middle,
        bridge,
        tts,
        transport.output(),
    ])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=True, allow_interruptions=True))
    await _run_task(transport, task, session_id, session_state)


async def _run_task(transport, task, session_id: str, session_state: dict) -> None:
    interaction_task = None
    async def interaction_prompts():
        failed = False
        while not session_state['dsh']._closing:
            try:
                await session_state['dsh'].announce_pending()
                await session_state['dsh']._start_next_turn()
                failed = False
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not failed:
                    print(f'[voice] interaction announcement unavailable: {type(exc).__name__}', flush=True)
                    await session_state['dsh']._control_notice('审批语音提醒暂不可用，请查看桌宠气泡。')
                failed = True
            await asyncio.sleep(0.75)

    if task.rtvi is not None and MODE == "dsh":
        @task.rtvi.event_handler("on_client_message")
        async def capture_control(rtvi, message):
            if message.type == 'queue-control':
                if isinstance(message.data,dict): await session_state['dsh'].queue_control(message.data)
                return
            if message.type == 'input-confirmation':
                data = message.data if isinstance(message.data, dict) else {}
                if not isinstance(data.get('id'), str) or len(data['id']) > 100:
                    return
                bridge = session_state['dsh']
                if data.get('action') == 'confirm':
                    await bridge.confirm_input(data['id'], data.get('text'))
                elif data.get('action') == 'discard':
                    await bridge.discard_input(data['id'])
                return
            if message.type != "capture-state":
                return
            data = message.data if isinstance(message.data, dict) else {}
            capture = session_state["asr"].capture
            action, capture_id = data.get("action"), data.get("captureId")
            if not capture.control(action, capture_id, data.get('mode', 'always')):
                return
            session_state['dsh'].capture_changed(action,capture_id)
            if action in ('finish', 'discard'):
                bridge = session_state['dsh']
                draft = bridge._input_admission.draft
                if draft and draft['metadata'].get('capture_id') == capture_id:
                    await bridge.discard_input(draft['id'])
            if action in ("finish", "discard"):
                await task.queue_frames([VADUserStoppedSpeakingFrame()])
            await rtvi.send_server_message({"type": "capture-ack", "action": action, "captureId": capture_id})

        @task.rtvi.event_handler("on_client_ready")
        async def greet_once(rtvi):
            nonlocal interaction_task
            if session_state.get("welcomed"):
                return
            session_state["welcomed"] = True
            interaction_task = asyncio.create_task(interaction_prompts())
            greeting = os.environ.get("DSH_VOICE_GREETING", "你好，我在呢。想聊什么，或者有什么需要我帮忙的？")
            if greeting:
                session_state["dsh"].set_greeting(greeting)
                await task.queue_frames([
                    OutputTransportMessageUrgentFrame(message={"id": "welcome-" + session_id, "label": "rtvi-ai", "type": "server-message", "data": {"type": "greeting", "text": greeting}}),
                    TTSSpeakFrame(text=greeting),
                ])

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        session_state["connected_at"] = time.time()
        print(f"[g1] client connected session={session_id} mode={MODE}", flush=True)

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        session_state["disconnected_at"] = time.time()
        print(f"[g1] client disconnected session={session_id} mode={MODE}", flush=True)
        try:
            await task.cancel()
        except Exception as exc:
            print(f"[g1] cancel failed session={session_id}: {exc!r}", flush=True)

    global CURRENT_TASK
    CURRENT_TASK = task
    runner = PipelineRunner(handle_sigint=False)

    async def notify_voice_error(payload: dict) -> None:
        """Forward a classified provider failure to the client and keep it for /health."""
        global LAST_VOICE_ERROR
        LAST_VOICE_ERROR = payload
        session_state["last_error"] = payload
        try:
            if task.rtvi is not None:
                await task.rtvi.send_server_message({
                    "type": "voice-error",
                    **{
                        key: payload[key]
                        for key in ("kind", "summary", "action", "diagId", "retryable", "source", "at")
                    },
                })
        except Exception as exc:
            print(f"[g1] voice-error notify failed session={session_id}: {exc!r}", flush=True)

    voice_errors.set_reporter(notify_voice_error)
    try:
        await runner.run(task)
    except Exception as exc:
        session_state["error"] = str(exc)
        last = session_state.get("last_error")
        # A service already reported with the actionable payload; do not overwrite it.
        stale = last is None or (round(time.time() * 1000) - int(last.get("at") or 0)) > 5000
        if stale:
            await voice_errors.report(exc, source="session")
        print(f"[g1] session error session={session_id}: {exc!r}", flush=True)
    finally:
        if interaction_task is not None:
            interaction_task.cancel()
            await asyncio.gather(interaction_task, return_exceptions=True)
        voice_errors.set_reporter(None)
        if CURRENT_TASK is task:
            CURRENT_TASK = None
        print(f"[g1] session finished session={session_id} mode={MODE}", flush=True)


CURRENT_TASK = None
DSH_PROCESSOR = None
LAST_VOICE_ERROR = None

PIPELINES = {
    "echo": run_echo_pipeline,
    "tts": run_tts_pipeline,
    "asr": run_asr_pipeline,
    "loop": run_loop_pipeline,
    "dsh": run_dsh_pipeline,
}


def _session_stats(session_state: dict) -> dict:
    out: dict = {"mode": MODE}
    echo = session_state.get("echo")
    if echo is not None:
        out["echo"] = {
            "frames_in": echo.frames_in,
            "frames_out": echo.frames_out,
            "non_silent_frames": echo.non_silent_frames,
            "avg_rms": round(echo.energy_sum / echo.energy_frames, 2) if echo.energy_frames else 0.0,
            "last_rms": round(echo.last_rms, 2),
        }
    for key in ("asr", "tts", "dsh"):
        svc = session_state.get(key)
        if svc is not None:
            out[key] = dict(getattr(svc, "metrics", {}))
    if DEBUG_TRANSCRIPTS and "transcripts" in session_state:
        out["transcripts"] = list(session_state["transcripts"])
    if "error" in session_state:
        out["error"] = session_state["error"]
    if session_state.get("last_error"):
        out["last_error"] = session_state["last_error"]
    return out


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "dsh-bot-voice",
        "pid": os.getpid(),
        "mode": MODE,
        "pipecat": "1.13.0",
        "asr_model": ASR_MODEL if MODE in ("asr", "loop", "dsh") else None,
        "tts_model": TTS_MODEL if MODE in ("tts", "loop", "dsh") else None,
        "tts_voice": TTS_VOICE if MODE in ("tts", "loop", "dsh") else None,
        "dsh_bridge_descriptor": DSH_BRIDGE_DESCRIPTOR if MODE == "dsh" else None,
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
        "active_sessions": len(active_sessions),
        # Minimal unauthenticated projection: no redacted stack/detail on /health.
        "last_error": voice_errors.health_view(LAST_VOICE_ERROR),
    }


@app.get("/debug/dsh-state")
async def debug_dsh_state(http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return {"ok": True, "state": DSH_PROCESSOR.queue_state() if DSH_PROCESSOR else None}


@app.post("/debug/barge-candidate")
async def debug_barge_candidate(http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if CURRENT_TASK is None:
        return JSONResponse(status_code=409, content={"error": "no active pipeline"})
    body = await http_request.json()
    text = str(body.get("text") or "请等一下")
    await CURRENT_TASK.queue_frames([VADUserStartedSpeakingFrame()])
    await asyncio.sleep(0.2)
    await CURRENT_TASK.queue_frames([InterimTranscriptionFrame(text, "test-user", "")])
    return {"ok": True, "queued_text": text}


@app.post("/debug/server-message")
async def debug_server_message(http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if CURRENT_TASK is None:
        return JSONResponse(status_code=409, content={"error": "no active pipeline"})
    body = await http_request.json()
    data = body.get("data") or {"type": "test-message", "epochMs": round(time.time()*1000)}
    await CURRENT_TASK.queue_frames([OutputTransportMessageUrgentFrame(message={
        "id": "debug-" + str(round(time.time()*1000)),
        "label": "rtvi-ai",
        "type": "server-message",
        "data": data,
    })])
    return {"ok": True, "data": data}


@app.post("/debug/transcript")
async def debug_transcript(http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if CURRENT_TASK is None:
        return JSONResponse(status_code=409, content={"error": "no active pipeline"})
    body = await http_request.json()
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": "text required"})
    if DSH_TEST_PREFIX and not text.startswith(DSH_TEST_PREFIX):
        text = DSH_TEST_PREFIX + text
    await CURRENT_TASK.queue_frames([TranscriptionFrame(text, "test-user", "")])
    return {"ok": True, "queued": text}


@app.post("/debug/barge-in")
async def debug_barge_in(http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if CURRENT_TASK is None:
        return JSONResponse(status_code=409, content={"error": "no active pipeline"})
    await CURRENT_TASK.queue_frames([VADUserStartedSpeakingFrame()])
    return {"ok": True, "barge_in": True}


@app.post("/debug/speak-text")
async def debug_speak_text(http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if CURRENT_TASK is None:
        return JSONResponse(status_code=409, content={"error": "no active pipeline"})
    body = await http_request.json()
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": "text required"})
    await CURRENT_TASK.queue_frames([TTSSpeakFrame(text=text)])
    return {"ok": True, "queued": text[:80]}


@app.get("/stats")
async def stats(http_request: Request):
    # Metrics endpoint is protected: it can expose conversation content when
    # debug transcripts are explicitly enabled. Default: counts/metrics only.
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return {
        "ok": True,
        "mode": MODE,
        "transcripts_enabled": DEBUG_TRANSCRIPTS,
        "sessions": {sid: _session_stats(state) for sid, state in SESSIONS.items()},
    }


@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks, http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    session_id = str(uuid.uuid4())
    session_state: dict = {}
    pipeline = PIPELINES.get(MODE)
    if pipeline is None:
        return JSONResponse(status_code=500, content={"error": f"unknown mode {MODE}"})

    async def webrtc_connection_callback(connection):
        SESSIONS[session_id] = session_state
        task = asyncio.create_task(pipeline(connection, session_id, session_state))
        active_sessions[session_id] = task

        def _cleanup(_t):
            active_sessions.pop(session_id, None)
            SESSIONS.pop(session_id, None)

        task.add_done_callback(_cleanup)
        print(f"[g1] connection callback session={session_id} mode={MODE}", flush=True)

    answer = await request_handler.handle_web_request(
        request=request,
        webrtc_connection_callback=webrtc_connection_callback,
    )
    return answer


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest, http_request: Request):
    if not authorized(http_request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    await request_handler.handle_patch_request(request)
    return {"status": "success"}


@app.on_event("shutdown")
async def shutdown():
    for task in list(active_sessions.values()):
        task.cancel()
    active_sessions.clear()
    SESSIONS.clear()
    print("[g1] worker shutdown: sessions cancelled", flush=True)
