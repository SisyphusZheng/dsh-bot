"""Official Hindsight CLI, with an offline check of its packaged embedding inputs."""
import asyncio
import json
import math
import sys
from pathlib import Path

async def check_embeddings(folder):
    from hindsight_api.engine.embeddings import OnnxEmbeddings
    root = Path(folder)
    model = OnnxEmbeddings('Xenova/multilingual-e5-small', model_path=str(root / 'onnx/model_int8.onnx'),
                           tokenizer_name_or_path=str(root), dimensions=384)
    await model.initialize()
    query = (await model.encode_query(['我平常喜欢喝什么咖啡？']))[0]
    documents = await model.encode_documents(['我喜欢无糖拿铁，常去海风咖啡。', '我的电脑安装了一个新的操作系统。'])
    assert len(query) == 384 and all(math.isfinite(x) for x in query)
    scores = [sum(a * b for a, b in zip(query, document, strict=True)) for document in documents]
    assert scores[0] > scores[1], f'Embedding relevance check failed: {scores}'
    print(json.dumps({'ok': True, 'check': 'offline-embeddings', 'dimensions': len(query), 'scores': scores}))

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check-embeddings':
        asyncio.run(check_embeddings(sys.argv[2]))
    else:
        from hindsight_api.main import main
        main()
