"""Offline cross-role ranking experiments. Evaluation reference is never imported here."""
import os
os.environ.setdefault('OMP_NUM_THREADS','4')
import json,sys,time,hashlib,re
from pathlib import Path
import numpy as np
from sklearn.feature_extraction.text import TfidfTransformer
from threadpoolctl import threadpool_limits
import test_agent_unsupervised_wordcloud as base
ROOT=Path(__file__).resolve().parent.parent/'ui_data/insights/comparisons/wordcloud-demand-crossrole-20261010'
base.STRICT=True
base.CLEAN=False # Retain short Chinese concepts, e.g. 微调、评测、数仓、清洗.
BONUS=re.compile('优先|加分|更佳|加分项|preferred|nice.to.have',re.I)
PROMO=re.compile('福利|薪酬|薪资待遇|五险|一金|你能得到|股权激励|工作氛围|学历|本科|硕士|博士|责任心|沟通能力|团队合作|学习能力')
GENERIC=set('数据 分析 优化 问题 任务 基础 框架 建设 性能 质量 流程 架构 代码 技能 知识 经验 技术 工具 工作 团队 客户 用户 需求 场景 方向 内容 结果 效果 方法 逻辑 思维 人员 沟通 协作 责任 相关 实践 理论 原理 热情 学习 一种 编程语言 基础知识 项目经验 工作经验 计算机 软件工程 计算机科学 专业 人工智能 解决方案'.split())
FOCUSED=GENERIC|set('智能 ai 工程 落地 核心 领域 深度 实际 基本 意识 精神 行业 体系 语言 编程 服务 管理 功能 文档 技术方案 业务场景 软件 模块 规范 标准 过程 环境 结构 现场 记录 效率 安全 测试 算法 训练 评估 研发 开源 研究 辅助 协同 排查 策略 机制 网络 模型 组件 生态 链路 指标 金融 医疗 数学 统计学 计算机相关 相关专业 技术栈 产品经理 技术人员 技术团队 项目落地 方案设计'.split())
NOISE=re.compile('本科|硕士|博士|学历|薪资|福利|责任心|沟通能力|团队合作|学习能力|加分项|应聘|招聘|入职|五险|一金')
def demand(c,docs):
    values=[];companies={}
    name=c['name'];pat=re.compile(r'(?<![a-z0-9])'+re.escape(name)+r'(?![a-z0-9])') if base.isenglish(name) else None
    keyname=base.compact(name)
    for d in docs:
        hits=[]
        for normalized,compact,weight in d['_weight_sections']:
            has=bool(pat.search(normalized)) if pat else keyname in compact
            if has:hits.append(weight)
        weight=max(hits,default=0);values.append(weight)
        key=base.compact(d['company']) or d['body_sha256'];companies[key]=max(companies.get(key,0),weight)
    return .5*np.mean(values)+.5*np.mean(list(companies.values())),sum(v>0 for v in values)
def run(role):
    out=ROOT/role;data=json.loads((out/'corpus.json').read_text(encoding='utf8'));train=[d for d in data['docs'] if d['split']=='train']
    cand,X,tokens,minimum=base.extract(train);T=TfidfTransformer(sublinear_tf=True).fit_transform(X)
    tf=np.asarray(T.mean(axis=0)).ravel();tr=base.textrank(cand,X,tokens);ns,topics,no,info=base.nmf_score(T)
    E,model,cached=base.semantic(cand,tf,out);sim=E@E.T;ss,clusters,so=base.semantic_score(E,tf)
    ranks={'tfidf':np.argsort(-tf),'textrank':np.argsort(-tr),'nmf':no,'semantic':so};rr=np.zeros(len(cand))
    for order in ranks.values():
        for p,j in enumerate(order):rr[j]+=1/(61+p)
    ranks['fusion']=np.argsort(-rr);scores={'tfidf':tf,'textrank':tr,'nmf':ns,'semantic':ss,'fusion':rr}
    print(json.dumps({'role':role,'stage':'demand_weights'},ensure_ascii=False),flush=True)
    for d in train:d['_weight_sections']=[(base.normalized(s['quote']),base.compact(s['quote']),(.35 if BONUS.search(s['quote']) else 1)*({'duties':1,'requirements':1,'unsectioned':.7}.get(s['location'],.7))) for s in d['sections'] if not PROMO.search(s['quote'])]
    selected={alg:base.select(order,cand,sim=sim if alg in ('semantic','fusion') else None) for alg,order in ranks.items()}
    for alg,order in ranks.items():
        cleanorder=[j for j in order if cand[j]['name'] not in GENERIC and not NOISE.search(cand[j]['name'])]
        selected['clean-'+alg]=base.select(cleanorder,cand,sim=sim if alg in ('semantic','fusion') else None)
        focusedorder=[j for j in order if cand[j]['name'] not in FOCUSED and not NOISE.search(cand[j]['name'])]
        selected['focused-'+alg]=base.select(focusedorder,cand,sim=sim if alg in ('semantic','fusion') else None)
    demands={j:demand(cand[j],train) for j in set(j for ix in selected.values() for j in ix)}
    variants=[]
    for alg,ix in selected.items():
        scoring=alg.removeprefix('clean-').removeprefix('focused-')
        terms=[{**cand[j],'score':float(scores[scoring][j]),'demand_weight':float(demands[j][0]),'demand_docs':int(demands[j][1]),'used_for_filter':False} for j in ix]
        variants.append({'id':alg,'terms':terms})
    result={'role':role,'manifest':data['manifest'],'parameters':{'strict_boundaries':True,'keep_short_chinese':True,'min_df':minimum,'limit':100,'demand_weight':'.5 document prevalence + .5 company prevalence; max once per group; optional .35, unsectioned .7; generic promo clauses excluded; no target dictionary'},'nmf':info,'embedding_model':model,'variants':variants}
    (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'role':role,'stage':'done','docs':len(train),'candidates':len(cand),'top10':{v['id']:[t['name'] for t in sorted(v['terms'],key=lambda t:-t['score'])[:10]] for v in variants}},ensure_ascii=False),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=4):
        for role in sys.argv[1:] or ['agent','crawler','bigdata']:run(role)
