"""Download public pinned safetensors assets only. Never sends JDs or credentials."""
import hashlib
import json
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[1]
DEST=ROOT/'work/role_screening_models/bge-small-zh-v1.5'
REPO='BAAI/bge-small-zh-v1.5'
REVISION='7999e1d3359715c523056ef9478215996d62a620'
FILES=['config.json','config_sentence_transformers.json','modules.json','sentence_bert_config.json','1_Pooling/config.json','model.safetensors','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.txt','README.md']
DEST.mkdir(parents=True,exist_ok=True)
manifest={'repo':REPO,'revision':REVISION,'license':'MIT per model card','files':{}}
for name in FILES:
    dest=DEST/name
    dest.parent.mkdir(parents=True,exist_ok=True)
    if not dest.exists():
        print('Download '+name,flush=True)
        part=dest.with_suffix(dest.suffix+'.part')
        with requests.get(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}',stream=True,timeout=(20,90)) as response:
            response.raise_for_status()
            with part.open('wb') as output:
                for block in response.iter_content(1024*1024):output.write(block)
        part.replace(dest)
    with dest.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    manifest['files'][name]={'sha256':digest,'bytes':dest.stat().st_size}
(DEST/'local-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest),flush=True)
