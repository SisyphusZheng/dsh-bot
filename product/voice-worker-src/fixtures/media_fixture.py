"""Synthetic ASR, tone TTS and scripted Bridge; real Pipecat and WebRTC."""
import asyncio
import base64
import json
import math
import os
from pathlib import Path
import struct
import sys
from urllib.parse import parse_qs, urlparse
import uvicorn
from aiohttp import web
from websockets.asyncio.server import serve

async def main():
    worker_port, provider_port, bridge_port = map(int, sys.argv[1:4]); descriptor = Path(sys.argv[4])
    os.environ.update(G1_MODE='dsh', SPIKE_TOKEN='media-fixture', DASHSCOPE_API_KEY='fixture-key', DASHSCOPE_REALTIME_URL=f'ws://127.0.0.1:{provider_port}/realtime', DSH_BRIDGE_DESCRIPTOR=str(descriptor), DSH_WAKE_PHRASE='')
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
                seen = True; await asyncio.sleep(0.2)
                await ws.send(json.dumps({'type':'conversation.item.input_audio_transcription.text','text':'请记录测试偏好','stash':''})); await asyncio.sleep(0.2)
                await ws.send(json.dumps({'type':'conversation.item.input_audio_transcription.completed','transcript':'请记录测试偏好'}))
            if kind == 'input_text_buffer.commit':
                assert 'tts' in model
                pcm = b''.join(struct.pack('<h',int(2500*math.sin(i*2*math.pi*440/24000))) for i in range(24000))
                for i in range(0,len(pcm),4800): await ws.send(json.dumps({'type':'response.audio.delta','delta':base64.b64encode(pcm[i:i+4800]).decode()}))
                await ws.send(json.dumps({'type':'response.audio.done'}))
            if kind == 'session.finish': break
    async def turn(request):
        assert request.headers['Authorization'] == 'Bearer bridge-fixture'; assert (await request.json())['text'] == '请记录测试偏好'
        response = web.StreamResponse(headers={'content-type':'application/x-ndjson'}); await response.prepare(request)
        for event in [{'type':'admitted','requestId':'r1','sessionId':'media-session'},{'type':'assistant-start','turn':1},{'type':'text','text':'好的，已收到测试请求。'},{'type':'assistant-end'},{'type':'turn-end','reason':{'kind':'completed'}}]: await response.write((json.dumps(event)+'\n').encode())
        await response.write_eof(); return response
    bridge = web.Application(); bridge.router.add_post('/voice/turn',turn); runner=web.AppRunner(bridge); await runner.setup(); await web.TCPSite(runner,'127.0.0.1',bridge_port).start()
    descriptor.write_text(json.dumps({'port':bridge_port,'token':'bridge-fixture'}))
    try:
        async with serve(provider,'127.0.0.1',provider_port): await uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=worker_port,log_level='warning')).serve()
    finally: await runner.cleanup()
asyncio.run(main())
