"""Bounded local skill discovery. JSON stdin/stdout; no downloads or remote code."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
import json
from pathlib import Path
import sys
import time
import ctypes
import psutil

ROOT = Path(__file__).resolve().parents[1]
LABELS = ['programming language', 'framework', 'software tool', 'database', 'protocol', 'hardware platform']


def memory_guard(initial=False):
    if os.environ.get('JOB_TERM_PARENT_PID') and not psutil.pid_exists(int(os.environ['JOB_TERM_PARENT_PID'])):
        raise RuntimeError('控制台服务已退出，停止本批模型扫描')
    minimum = (3.5 if initial else 1) * 1024**3
    if psutil.virtual_memory().available < minimum:
        raise RuntimeError('新词扫描已暂停：可用物理内存不足，请稍后分批重试')
    if os.name == 'nt':
        class Performance(ctypes.Structure):
            _fields_ = [('cb', ctypes.c_ulong)] + [(name, ctypes.c_size_t) for name in
                ['CommitTotal', 'CommitLimit', 'CommitPeak', 'PhysicalTotal', 'PhysicalAvailable',
                 'SystemCache', 'KernelTotal', 'KernelPaged', 'KernelNonpaged', 'PageSize']] + [
                (name, ctypes.c_ulong) for name in ['HandleCount', 'ProcessCount', 'ThreadCount']]
        info = Performance()
        info.cb = ctypes.sizeof(info)
        if not ctypes.windll.psapi.GetPerformanceInfo(ctypes.byref(info), info.cb):
            raise RuntimeError('无法读取可提交内存，安全停止新词扫描')
        reserve = (4 if initial else 1) * 1024**3
        if (info.CommitLimit - info.CommitTotal) * info.PageSize < reserve:
            raise RuntimeError('新词扫描已暂停：系统可提交内存不足，请释放资源后重试')


def load_local_model():
    import torch
    from transformers import DebertaV2TokenizerFast
    from safetensors.torch import load_file
    from gliner import GLiNER
    from gliner.config import GLiNERConfig
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    dest = ROOT / 'work/wordcloud_uie_models/gliner-multi-v2.1'
    conf = json.loads((dest / 'gliner_config.json').read_text('utf-8'))
    conf['encoder_config'] = json.loads((dest / 'encoder/config.json').read_text('utf-8'))
    if conf['encoder_config']['model_type'] != 'deberta-v2' or 'auto_map' in conf['encoder_config'] or 'auto_map' in conf:
        raise RuntimeError('仅允许内置DeBERTa编码器，不加载模型自定义代码')
    config = GLiNERConfig(**conf)
    config.words_splitter_type = 'jieba'
    # SentencePiece on Windows requires an ASCII relative path here.
    os.chdir(ROOT)
    tokenizer = DebertaV2TokenizerFast(vocab_file=str((dest / 'encoder/spm.model').relative_to(ROOT)), from_slow=True, do_lower_case=False)
    tokenizer.model_max_length = 512
    model = GLiNER(config, tokenizer=tokenizer, encoder_from_pretrained=False)
    model.resize_token_embeddings(add_tokens=['[FLERT]', config.ent_token, config.sep_token])
    state = load_file(str(dest / 'model.safetensors'), device='cpu')
    model.model.load_state_dict(state, strict=True)
    del state
    model.eval()
    if not any(h['text'] == 'Google' for h in model.predict_entities('Alice works at Google.', ['person', 'organization'], threshold=.5)):
        raise RuntimeError('本机模型自检失败')
    return model


def utf16_length(text):
    return len(text.encode('utf-16-le')) // 2


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    data = json.loads(sys.stdin.read(2_000_001))
    docs = data['docs']
    if not isinstance(docs, list) or not 1 <= len(docs) <= 50:
        raise ValueError('扫描批量超限')
    memory_guard(initial=True)
    model = load_local_model()
    process = psutil.Process()
    for doc in docs:
        memory_guard()
        before = time.perf_counter()
        hits = {}
        for section in doc['sections']:
            text = section['quote']
            if len(text) > 1200:
                raise ValueError('原文片段过长')
            for bias in range(0, len(text), 144):
                memory_guard()
                chunk = text[bias:bias + 192]
                for entity in model.predict_entities(chunk, LABELS, threshold=.5, flat_ner=False):
                    lo, hi = entity['start'] + bias, entity['end'] + bias
                    if text[lo:hi] != entity['text']:
                        raise ValueError('原文跨度不匹配')
                    start = section['start'] + utf16_length(text[:lo])
                    end = section['start'] + utf16_length(text[:hi])
                    item = dict(text=entity['text'], start=start, end=end,
                                score=round(float(entity['score']), 6), entity_type=entity['label'])
                    key = (start, end)
                    if key not in hits or item['score'] > hits[key]['score']:
                        hits[key] = item
        if len(hits) > 300:
            raise ValueError('模型单岗位输出超限')
        print('@@TERMS@@' + json.dumps(dict(job_key=doc['job_key'], content_hash=doc['content_hash'],
              hits=list(hits.values()), seconds=round(time.perf_counter() - before, 3),
              rss_mib=round(process.memory_info().rss / 1024**2, 1)), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('@@ERROR@@' + str(error)[:300], file=sys.stderr, flush=True)
        sys.exit(1)
