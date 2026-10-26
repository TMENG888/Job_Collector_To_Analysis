"""Pinned public assets only. Does not transmit JDs or use any API credentials."""
import hashlib
import json
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parents[1]
REPO='cross-encoder/mmarco-mMiniLMv2-L12-H384-v1'
REVISION='1427fd652930e4ba29e8149678df786c240d8825'
DEST=ROOT/'work/role_screening_models/mmarco-mMiniLMv2-L12-H384-v1'
FILES=['config.json','model.safetensors','sentencepiece.bpe.model','special_tokens_map.json','tokenizer.json','tokenizer_config.json','README.md']
DEST.mkdir(parents=True,exist_ok=True)
manifest={'repo':REPO,'revision':REVISION,'license':'apache-2.0 per model card','files':{}}
for name in FILES:
    dest=DEST/name
    if not dest.exists():
        print('Download '+name,flush=True)
        part=dest.with_suffix(dest.suffix+'.part')
        with requests.get(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}',stream=True,timeout=(20,120)) as response:
            response.raise_for_status()
            with part.open('wb') as stream:
                for block in response.iter_content(1024*1024):stream.write(block)
        part.replace(dest)
    with dest.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    manifest['files'][name]={'sha256':digest,'bytes':dest.stat().st_size}
(DEST/'local-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest),flush=True)
