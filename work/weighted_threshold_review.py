"""Frozen original-text AI review; created before viewing new screening scores."""
import json,hashlib
from pathlib import Path
ROOT=Path('ui_data/insights/comparisons/weighted-role-threshold-20261010')
# T=target, N=non-target, U=insufficient/adjacent. Quotes must occur verbatim.
LABELS={
'agent':{
9957:('T','智能体（Agent）工作流的实现与优化'),2914:('T','参与AI工作流的搭建与优化'),9582:('T','RAG'),11194:('N','测试'),8029:('T','AI Agent'),11305:('T','工具调用'),7358:('U','产品'),4146:('T','设计与开发'),7493:('T','AI Agent'),11240:('T','AI Agent系统设计与开发'),622:('T','工作流编排'),12304:('T','Dify'),12084:('N','图像'),12039:('N','模型'),14713:('N','销售'),11583:('N','视觉'),16119:('N','EDA'),11501:('U','探索'),13018:('N','图像'),2817:('N','项目'),
8892:('T','参与 LLM 应用开发与搭建优化'),2090:('T','负责智能体Harness框架的设计与开发'),12219:('T','负责AI智能体全流程搭建与落地'),8009:('U','了解智能体构建过程的基本概念和步骤'),12133:('T','负责RAG'),366:('N','定义创新性的场景化用户体验方案'),4952:('N','视觉质检、设备故障预测'),10683:('T','参与AI Agent的设计与配置'),9007:('T','对接大模型（火山方舟/豆包等）API'),5872:('U','构建业务相关大数据分析、预测等模型'),10196:('T','参与生成式大模型能力和工具集构建'),8760:('T','参与基于大语言模型（LLM）的智能体系统设计与开发'),10246:('T','负责 Agent 应用的设计、开发与持续优化'),9677:('T','知识库RAG'),4895:('N','有AIAgent、自动化工具开发等实践经验者优先'),15832:('U','智能体、RPA、自动化决策系统'),7008:('N','有AI相关使用、开发经验者优先'),12153:('N','缺陷检测、生产参数优化'),4458:('N','负责调试/测试环境搭建'),3214:('N','计算图构建、模型训练与优化')},
'crawler':{
200:('N','机器人'),74:('T','爬虫系统设计与开发'),176:('T','编写抓取互联网内容的爬虫'),91:('N','手'),90:('N','采集'),71:('T','Python'),16:('T','爬虫'),51:('T','爬虫'),1373:('N','Django'),2111:('N','数据仓库'),3444:('N','开发'),4895:('N','运维'),4004:('N','大模型'),4720:('N','网络'),152:('N','优先'),3160:('N','后端'),236:('N','测试'),300:('N','测试'),616:('N','Teamcenter'),728:('N','前端'),
38:('T','平台网页或app商品详情页数据'),33:('T','编写和维护网页爬虫'),86:('U','采集招投标文件样本'),196:('N','动作捕捉设备'),93:('N','操作公司指定的数据采集设备'),2:('T','能够独立设计和实现高效稳定的爬虫程序'),11:('T','使用Python开发采集模块'),211:('T','多源公开数据获取、页面解析、结构化抽取'),4114:('N','参与 LLM 应用开发与搭建优化'),2651:('N','熟练运用各类AI编程助手与设计工具'),2179:('N','全栈开发经验'),377:('N','后端技术方案设计'),3752:('N','数据仓库各层级模型'),1306:('N','煤矿火灾监测预警算法研发'),1208:('N','道路耐久试验'),758:('N','完成机器视觉领域开发工作'),132:('N','有爬虫项目经历的优先'),231:('N','数据采集等场景开发经验者优先'),1107:('N','烟气脱硫'),2424:('N','计算图构建、模型训练与优化')},
'bigdata':{
49:('T','参与结算系统数据仓库'),323:('T','实时数仓分层架构设计与开发'),1430:('N','负责公司售前团队的日常管理'),497:('T','宽表和数据集市层表的逻辑加工'),543:('T','构建数据模型与ETL流程'),173:('T','必须熟练使用PySpark'),510:('T','设计并优化ETL'),197:('T','精通ETL工具'),516:('T','熟悉数仓建模与ETL开发'),1017:('T','负责企业数据仓库、数据集市的 ETL 流程设计'),1772:('T','开源 BI 二次开发'),983:('T','负责保险公司数据仓库的设计'),275:('T','制作数据仪表展示'),1632:('T','负责 ETL 作业开发'),1666:('N','高性能推理引擎'),1247:('N','了解mongodb，spark，kettle，es技术会有额外的加分'),1895:('U','负责基于LLM的知识库问答系统'),1564:('N','Java后端服务'),4554:('N','Python后端开发'),2227:('N','Teamcenter系统平台的二次开发'),
127:('T','参与数据仓库建设、ETL流程设计及实时数据处理'),281:('T','完成离线或实时数据任务的模型设计'),527:('T','独立完成数据需求分析、数据模型设计、ETL开发'),731:('T','开发数据采集、数据同步、ETL处理及数据清洗程序'),3891:('T','负责数据平台、标签平台、洞察分析平台'),354:('T','负责数据仓库架构、共性加工层模型设计'),451:('T','基于大数据平台的数据类需求'),458:('T','负责工程施工业务数据的ETL流程设计与开发'),191:('T','负责企业级数据仓库体系建设'),609:('U','了解数据仓库、ETL、数据建模的基本概念'),825:('T','业务数据的抽取、清洗、转换与加载'),4950:('T','开发自动化脚本'),896:('T','负责数据仓库、数据平台的ETL流程设计'),2043:('T','编写Python/Shell等脚本，实现数据处理流程的自动化'),649:('U','了解数据仓库/ETL开发流程'),845:('T','精通个人信贷及普惠信贷的大数据开发工作'),1189:('T','构建高效的数据湖/仓库管道'),1514:('T','spark流式开发，sparkSQL开发'),4371:('N','计算图构建、模型训练与优化'),4050:('N','核心搭建设备故障诊断模型')}
}
REASONS={
'agent':{'T':'原文明确LLM/Agent应用开发、集成或低代码工作流交付；不是仅使用AI工具。','N':'主要职责为其他领域，或目标技能仅为加分项；无目标应用交付证据。','U':'目标领域相邻或职责含糊；原文不足以确认LLM应用工程交付。'},
'crawler':{'T':'明确Web/App/在线数据获取与采集程序交付。','N':'实际职责为其他开发、测试、运维或物理设备采集；爬虫仅加分不能放行。','U':'文件采集治理存在，但无法确认在线采集工程责任。'},
'bigdata':{'T':'明确数据工程、仓库、ETL、数据管道或BI开发交付。','N':'主要是通用开发、算法、售前；相关组件提及不能替代数据工程职责。','U':'数据工程相邻或只有泛化能力要求，主交付边界不清。'}}
LABELS['crawler'][2111]=('N','实时数仓分层架构设计与开发')
if __name__=='__main__':
    sample=json.loads((ROOT/'blind-review.json').read_text(encoding='utf8'))
    out=[]
    for d in sample:
        label,quote=LABELS[d['role']][d['row_no']]
        if quote not in d['text']:raise ValueError((d['role'],d['row_no'],quote))
        out.append({'role':d['role'],'row_no':d['row_no'],'split':d['split'],'title':d['title'],'label':{'T':'target','N':'non_target','U':'review'}[label],'quote':quote,'reason':REASONS[d['role']][label],'reviewer':'AI original-text review; not human gold standard'})
    (ROOT/'review-labels.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
    protocol={'scope':{'agent':'LLM/Agent application engineering including low-code building; exclude pure testing/sales/product/vision/base-model research','crawler':'Web/App/online collection engineering; exclude physical sensor/robot collection','bigdata':'data engineering/warehouse/ETL/pipelines/governance/BI development; exclude generic backend and pure ops'},'selection':'Calibration only: precision >=0.90, at least 3 true positives, maximize F0.5 then recall then higher threshold. If impossible, report failure, do not invent passing threshold. Compare 6 fixed variants with global and role-specific thresholds; choose macro F0.5 on calibration.','threshold_grid':[round(.5+i*.25,2) for i in range(59)],'review_handling':'Exclude uncertain in primary metrics; sensitivity counts uncertain as non-target.','sampling':'Stratified diagnostic sample; NOT prevalence-representative. Old acceptance stratum visible to reviewer, new scores hidden.','test':'Labels fixed before scores. Test used once after calibration selection; do not retune on test.','labels_sha256':hashlib.sha256((ROOT/'review-labels.json').read_bytes()).hexdigest()}
    (ROOT/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf8')
    print('Frozen',len(out),'original-text reviews and calibration protocol')
