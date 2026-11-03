"""Synthetic ASR, tone TTS and scripted Host v2; real Pipecat and WebRTC.

The fixture plays the Host ConversationService side of the beta2 protocol: it
accepts ``voice.facts``/``voice.session``, decides the business trigger (welcome,
assistant reply, interaction prompt, answer receipt) and sends media commands
(``speech.append``/``speech.end``/``notice.show``) back to the worker. The worker
under test only moves media facts and executes those commands.
"""
import asyncio
import base64
import datetime
import json
import math
import os
from pathlib import Path
import struct
import socket
import sys
import uuid
from urllib.parse import parse_qs, urlparse
import uvicorn
from aiohttp import web
from websockets.asyncio.server import serve

PROTOCOL_VERSION = 'dsh-bot-v1'
HOST_EPOCH = 'fixture-epoch'


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec='milliseconds').replace('+00:00', 'Z')


async def main():
    descriptor = Path(sys.argv[4])
    sockets = []
    for _ in range(3):
        owned = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        owned.bind(('127.0.0.1', 0)); owned.listen(128); owned.setblocking(False); sockets.append(owned)
    worker_socket, provider_socket, bridge_socket = sockets
    worker_port, provider_port, bridge_port = [s.getsockname()[1] for s in sockets]
    os.environ.update(G1_MODE='dsh', SPIKE_TOKEN='media-fixture', DASHSCOPE_API_KEY='fixture-key',
                      DASHSCOPE_REALTIME_URL=f'ws://127.0.0.1:{provider_port}/realtime',
                      DSH_BRIDGE_DESCRIPTOR=str(descriptor), DSH_CAPTURE_CONTROL='1')
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    # Both fixture peers run on this host; never enumerate external interfaces.
    import aioice.ice
    aioice.ice.get_host_addresses = lambda use_ipv4, use_ipv6: ['127.0.0.1']
    from server import app

    greeting_text = os.environ.get('DSH_VOICE_GREETING', '')
    interaction = os.environ.get('MEDIA_INTERACTION', '')
    hold_turn = os.environ.get('MEDIA_HOLD_TURN') == '1'

    spoken = []
    asr_peers = set()
    answers = []
    lifecycle = {'started': 0, 'finished': 0, 'cancels': 0, 'disconnects': 0}
    acks = []
    release = asyncio.Event()
    host_state = {'seq': 0, 'events': [], 'subscribers': [], 'held_turn': None,
                  'prompted': False}

    def emit(event_type, data=None, source='host'):
        host_state['seq'] += 1
        event = {
            'protocolVersion': PROTOCOL_VERSION,
            'eventId': 'fixture-' + str(host_state['seq']),
            'hostEpoch': HOST_EPOCH,
            'seq': host_state['seq'],
            'type': event_type,
            'source': source,
            'sessionId': 'media-session',
            'turn': None,
            'causedByCommandId': None,
            'at': iso_now(),
            'data': data or {},
        }
        host_state['events'].append(event)
        for queue in list(host_state['subscribers']):
            queue.put_nowait(event)
        return event

    def command(command_type, payload):
        return {'commandId': 'host-' + uuid.uuid4().hex, 'type': command_type,
                'payload': payload}

    def emit_command(cmd):
        """Real Host behavior: command events travel on /v2/stream; receipts
        only carry reference hints ({commandId,type})."""
        emit('command', cmd)
        return {'commandId': cmd['commandId'], 'type': cmd['type']}

    def interaction_commands():
        if not interaction or host_state['prompted']:
            return []
        host_state['prompted'] = True
        if interaction == 'question':
            text = '需要你回答：文档用什么内容？可选：第1项，之前的文章；第2项，新文章。'
        else:
            text = ('有一个操作需要你批准，请查看气泡中的详情。'
                    '说“确认允许一次”或“拒绝”，也可以点击按钮。')
        turn = 'media-session:prompt'
        return [
            command('notice.show', {'noticeId': 'fixture-prompt',
                                    'text': text, 'kind': 'status'}),
            command('speech.append', {'turnId': turn, 'text': text, 'seq': 1}),
            command('speech.end', {'turnId': turn, 'reason': 'prompt'}),
        ]

    def greeting_commands():
        if not greeting_text:
            return []
        turn = 'media-session:welcome'
        return [
            command('speech.append', {'turnId': turn, 'text': greeting_text, 'seq': 1}),
            command('speech.end', {'turnId': turn, 'reason': 'greeting'}),
        ]

    async def provider(ws):
        assert ws.request.headers['Authorization'] == 'Bearer fixture-key'
        model = parse_qs(urlparse(ws.request.path).query)['model'][0]
        if 'asr' in model:
            asr_peers.add(ws)
        await ws.send(json.dumps({'type': 'session.created'})); seen = False
        async for raw in ws:
            event = json.loads(raw); kind = event['type']
            if kind == 'session.update':
                await ws.send(json.dumps({'type': 'session.updated', 'session': event['session']}))
            if kind == 'input_audio_buffer.append' and not seen:
                assert 'asr' in model and len(base64.b64decode(event['audio'])) > 0
                seen = True
                # Inject the actual welcome, not a short phrase a user may
                # legitimately repeat after hearing it.
                for item, transcript in [('noise-1', '嗯。'),
                                         ('echo-1', greeting_text or '你好，我在呢。')]:
                    await ws.send(json.dumps({'type': 'conversation.item.input_audio_transcription.text',
                                              'item_id': item, 'text': transcript, 'stash': ''}))
                    await ws.send(json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                                              'item_id': item, 'transcript': transcript}))
                await asyncio.sleep(0.2)
                await ws.send(json.dumps({'type': 'conversation.item.input_audio_transcription.text',
                                          'item_id': 'intent-1', 'text': '请记录测试偏好', 'stash': ''}))
                await asyncio.sleep(0.2)
                await ws.send(json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                                          'item_id': 'intent-1', 'transcript': '请记录测试偏好'}))
            if kind == 'input_text_buffer.append':
                spoken.append(event['text'])
            if kind == 'input_text_buffer.commit':
                assert 'tts' in model
                pcm = b''.join(struct.pack('<h', int(2500 * math.sin(i * 2 * math.pi * 440 / 24000)))
                               for i in range(24000))
                for i in range(0, len(pcm), 4800):
                    await ws.send(json.dumps({'type': 'response.audio.delta',
                                              'delta': base64.b64encode(pcm[i:i + 4800]).decode()}))
                await ws.send(json.dumps({'type': 'response.audio.done'}))
            if kind == 'session.finish':
                break

    # ---- Host v2 protocol fixture ---------------------------------------
    def receipt(body, commands):
        return {
            'protocolVersion': PROTOCOL_VERSION,
            'commandId': body.get('commandId'),
            'hostEpoch': HOST_EPOCH,
            'status': 'accepted',
            'result': {'routed': [], 'commands': commands},
            'error': None,
            'at': iso_now(),
        }

    async def v2_snapshot(request):
        assert request.headers.get('Authorization') == 'Bearer bridge-fixture'
        return web.json_response({
            'protocolVersion': PROTOCOL_VERSION,
            'schema': 'snapshot@1',
            'hostEpoch': HOST_EPOCH,
            'snapshotSeq': host_state['seq'],
            'generatedAt': iso_now(),
            'identity': {'product': 'dsh-bot', 'productVersion': '0.0.0-fixture',
                         'sessionId': 'media-session', 'botSessionReady': True,
                         'workspace': '/fixture/workspace'},
            'connection': {'worker': {'state': 'connected'},
                           'desktop': {'connected': True}},
            'capture': {'state': 'off', 'mode': 'hold', 'captureId': None,
                        'connectionId': None, 'preview': None},
            'playback': {'state': 'idle', 'playbackId': None, 'style': 'full'},
            'execution': {'state': 'idle', 'sessionId': 'media-session',
                          'requestId': None, 'turn': None},
            'interactions': {'focusedId': None, 'pending': [], 'drafts': {},
                             'recentlyResolved': []},
            'inputDraft': None,
            'queue': {'revision': 0, 'items': []},
            'notices': [],
            'presentation': {'displayMode': 'idle', 'priority': [],
                             'bubble': {'visible': False, 'requestId': None, 'kind': None}},
        })

    async def v2_stream(request):
        assert request.headers.get('Authorization') == 'Bearer bridge-fixture'
        after = int(request.query.get('after', '0'))
        response = web.StreamResponse(status=200, headers={
            'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
        await response.prepare(request)
        queue = asyncio.Queue()
        host_state['subscribers'].append(queue)
        try:
            for event in host_state['events']:
                if event['seq'] > after:
                    await response.write(('data: ' + json.dumps(event) + '\n\n').encode())
            while True:
                event = await queue.get()
                await response.write(('data: ' + json.dumps(event) + '\n\n').encode())
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            if queue in host_state['subscribers']:
                host_state['subscribers'].remove(queue)
        return response

    def finish_held_turn():
        if not host_state['held_turn']:
            return
        host_state['held_turn'] = None
        lifecycle['finished'] += 1

    async def v2_command(request):
        assert request.headers.get('Authorization') == 'Bearer bridge-fixture'
        body = await request.json()
        command_type = body.get('type')
        payload = body.get('payload') or {}
        commands = []
        if command_type == 'voice.session':
            if payload.get('transport') == 'connected':
                for greeting in greeting_commands():
                    emit_command(greeting)
            # Real Host voice.session receipt is {connectionId} only; commands are
            # delivered exclusively as /v2/stream `command` events.
            return web.json_response({
                'protocolVersion': PROTOCOL_VERSION,
                'commandId': body.get('commandId'),
                'hostEpoch': HOST_EPOCH,
                'status': 'accepted',
                'result': {'connectionId': payload.get('connectionId')
                           or (body.get('sourceConnectionId') or '')},
                'error': None,
                'at': iso_now(),
            })
        elif command_type == 'voice.facts':
            for item in payload.get('items') or []:
                if item.get('kind') != 'asr.final':
                    continue
                text = item.get('text') or ''
                if '请记录测试偏好' in text and lifecycle['started'] == 0:
                    lifecycle['started'] += 1
                    turn_id = 'media-session:1'
                    reply_commands = [
                        command('speech.append', {
                            'turnId': turn_id, 'text': '**好的**，已收到测试请求。', 'seq': 1}),
                        command('speech.end', {'turnId': turn_id, 'reason': 'turn-end'}),
                        *interaction_commands(),
                    ]
                    for reply in reply_commands:
                        commands.append(emit_command(reply))
                    # MEDIA_HOLD_TURN only keeps the fixture-Host turn open (finished
                    # counter) so the capture-discard-during-task assertion stays real;
                    # the media commands are already delivered via /v2/stream.
                    if hold_turn:
                        host_state['held_turn'] = turn_id
                    else:
                        lifecycle['finished'] += 1
                elif '最后一个选项' in text and interaction == 'question' and not answers:
                    answers.append({
                        'id': 'question-1', 'sessionId': 'media-session',
                        'answer': {'answers': [{'id': 'content', 'selected': ['新文章']}]},
                    })
                    for answer_command in (
                        command('speech.append', {
                            'turnId': 'media-session:answer', 'text': '已记录你的选择。', 'seq': 1}),
                        command('speech.end', {
                            'turnId': 'media-session:answer', 'reason': 'answer'}),
                    ):
                        commands.append(emit_command(answer_command))
        elif command_type == 'presentation.ack':
            acks.append(payload)
        return web.json_response(receipt(body, commands))

    # ---- fixture control endpoints (not part of the Host protocol) ------
    async def state(request):
        return web.json_response(lifecycle)

    async def speech(request):
        return web.json_response({'spoken': spoken})

    async def fixture_answers(request):
        return web.json_response({'answers': answers})

    async def inject_answer(request):
        assert interaction == 'question'
        for ws in asr_peers:
            await ws.send(json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                                      'item_id': 'answer-1', 'transcript': '最后一个选项'}))
        return web.json_response({'ok': True})

    async def resume(request):
        release.set()
        finish_held_turn()
        return web.json_response({'ok': True})

    async def fixture_acks(request):
        return web.json_response({'acks': acks})

    bridge = web.Application()
    bridge.router.add_get('/v2/snapshot', v2_snapshot)
    bridge.router.add_get('/v2/stream', v2_stream)
    bridge.router.add_post('/v2/command', v2_command)
    bridge.router.add_get('/fixture-state', state)
    bridge.router.add_get('/fixture-speech', speech)
    bridge.router.add_get('/fixture-answers', fixture_answers)
    bridge.router.add_get('/fixture-acks', fixture_acks)
    bridge.router.add_post('/fixture-inject-answer', inject_answer)
    bridge.router.add_post('/fixture-release', resume)
    runner = web.AppRunner(bridge); await runner.setup()
    await web.SockSite(runner, bridge_socket).start()
    descriptor.write_text(json.dumps({'port': bridge_port, 'token': 'bridge-fixture',
                                      'workerPort': worker_port, 'providerPort': provider_port}))
    try:
        async with serve(provider, sock=provider_socket):
            await uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=worker_port,
                                                log_level='warning')).serve(sockets=[worker_socket])
    finally:
        runner.cleanup()
        for owned in sockets:
            owned.close()


asyncio.run(main())
