"""Synthetic ASR, tone TTS and scripted Bridge; real Pipecat and WebRTC."""
import asyncio
import base64
import json
import math
import os
from pathlib import Path
import struct
import socket
import sys
from urllib.parse import parse_qs, urlparse
import uvicorn
from aiohttp import web
from websockets.asyncio.server import serve

async def main():
    descriptor = Path(sys.argv[4])
    sockets = []
    for _ in range(3):
        owned = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        owned.bind(('127.0.0.1', 0)); owned.listen(128); owned.setblocking(False); sockets.append(owned)
    worker_socket, provider_socket, bridge_socket = sockets
    worker_port, provider_port, bridge_port = [s.getsockname()[1] for s in sockets]
    os.environ.update(G1_MODE='dsh', SPIKE_TOKEN='media-fixture', DASHSCOPE_API_KEY='fixture-key', DASHSCOPE_REALTIME_URL=f'ws://127.0.0.1:{provider_port}/realtime', DSH_BRIDGE_DESCRIPTOR=str(descriptor), DSH_WAKE_PHRASE='', DSH_CAPTURE_CONTROL='1')
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    # Both fixture peers run on this host; never enumerate external interfaces.
    import aioice.ice
    aioice.ice.get_host_addresses = lambda use_ipv4, use_ipv6: ['127.0.0.1']
    from server import app
    async def provider(ws):
        assert ws.request.headers['Authorization'] == 'Bearer fixture-key'
        model = parse_qs(urlparse(ws.request.path).query)['model'][0]
        await ws.send(json.dumps({'type':'session.created'})); seen = False
        async for raw in ws:
            event = json.loads(raw); kind = event['type']
            if kind == 'session.update': await ws.send(json.dumps({'type':'session.updated','session':event['session']}))
            if kind == 'input_audio_buffer.append' and not seen:
                assert 'asr' in model and len(base64.b64decode(event['audio'])) > 0
                seen = True
                for item, transcript in [('noise-1','嗯。'),('echo-1','你好，我在呢。')]:
                    await ws.send(json.dumps({'type':'conversation.item.input_audio_transcription.text','item_id':item,'text':transcript,'stash':''}))
                    await ws.send(json.dumps({'type':'conversation.item.input_audio_transcription.completed','item_id':item,'transcript':transcript}))
                await asyncio.sleep(0.2)
                await ws.send(json.dumps({'type':'conversation.item.input_audio_transcription.text','item_id':'intent-1','text':'请记录测试偏好','stash':''})); await asyncio.sleep(0.2)
                await ws.send(json.dumps({'type':'conversation.item.input_audio_transcription.completed','item_id':'intent-1','transcript':'请记录测试偏好'}))
            if kind == 'input_text_buffer.commit':
                assert 'tts' in model
                pcm = b''.join(struct.pack('<h',int(2500*math.sin(i*2*math.pi*440/24000))) for i in range(24000))
                for i in range(0,len(pcm),4800): await ws.send(json.dumps({'type':'response.audio.delta','delta':base64.b64encode(pcm[i:i+4800]).decode()}))
                await ws.send(json.dumps({'type':'response.audio.done'}))
            if kind == 'session.finish': break
    lifecycle = {'started': 0, 'finished': 0, 'cancels': 0, 'disconnects': 0}
    release = asyncio.Event()
    async def state(request):
        return web.json_response(lifecycle)
    async def resume(request):
        release.set(); return web.json_response({'ok': True})
    async def cancel(request):
        lifecycle['cancels'] += 1; return web.json_response({'ok': True})
    async def turn(request):
        assert request.headers['Authorization'] == 'Bearer bridge-fixture'; assert (await request.json())['text'] == '请记录测试偏好'
        lifecycle['started'] += 1
        response = web.StreamResponse(headers={'content-type':'application/x-ndjson'}); await response.prepare(request)
        for event in [{'type':'admitted','requestId':'r1','sessionId':'media-session'},{'type':'assistant-start','turn':1},{'type':'text','text':'好的，已收到测试请求。'},{'type':'assistant-end'}]: await response.write((json.dumps(event)+'\n').encode())
        if os.environ.get('MEDIA_HOLD_TURN') == '1':
            await release.wait()
        if request.transport is None or request.transport.is_closing():
            lifecycle['disconnects'] += 1
            return response
        await response.write((json.dumps({'type':'turn-end','reason':{'kind':'completed'}})+'\n').encode())
        lifecycle['finished'] += 1
        await response.write_eof(); return response
    bridge = web.Application(); bridge.router.add_post('/voice/turn',turn); bridge.router.add_get('/fixture-state',state); bridge.router.add_post('/fixture-release',resume); bridge.router.add_post('/cancel',cancel); runner=web.AppRunner(bridge); await runner.setup(); await web.SockSite(runner,bridge_socket).start()
    descriptor.write_text(json.dumps({'port':bridge_port,'token':'bridge-fixture','workerPort':worker_port,'providerPort':provider_port}))
    try:
        async with serve(provider,sock=provider_socket): await uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=worker_port,log_level='warning')).serve(sockets=[worker_socket])
    finally:
        await runner.cleanup()
        for owned in sockets:
            owned.close()
asyncio.run(main())
