import { roleSections } from './role-evidence-v2.mjs';

// Curated vocabulary, not an unsupervised model or a probability estimate.
const vocabulary = [
  ['嵌入式', /嵌入式|\bembedded\b/i], ['固件', /固件|\bfirmware\b/i],
  ['单片机', /单片机/i], ['MCU', /\bmcu\b/i], ['STM32', /\bstm32\w*/i],
  ['BSP', /\bbsp\b/i], ['设备驱动', /(?:设备|硬件|底层|linux|内核|外设)\s*驱动|\bdevice\s+drivers?\b/i],
  ['RTOS', /\brtos\b|实时操作系统/i], ['FreeRTOS', /freertos/i],
  ['RT-Thread', /rt[- ]?thread/i], ['Linux内核', /linux\s*(?:内核|驱动)|\blinux\s+kernel\b/i],
  ['Bootloader', /bootloader|u-boot/i], ['AUTOSAR', /autosar/i],
  ['ARM', /\barm\b|cortex[- ]?[amr]/i], ['UART', /\buart\b/i],
  ['SPI', /\bspi\b/i], ['I2C', /\bi[²2]c\b/i], ['CAN', /\bcan(?:bus)?\b/i],
];
const titleSeed = /嵌入式|单片机|固件|\bembedded\b|\bfirmware\b|\bbsp\b|(?:linux|设备|底层)\s*驱动/i;
const softwareObject = /固件|firmware|\bbsp\b|bootloader|u-boot|autosar|(?:设备|硬件|底层|linux|内核|外设)\s*驱动|device\s+drivers?|嵌入式.{0,18}(?:软件|程序|代码|系统)|embedded.{0,18}(?:software|system)|(?:单片机|\bmcu\b|stm32|rtos|freertos|rt[- ]?thread).{0,25}(?:软件|程序|代码|开发|移植)|linux\s*(?:内核|驱动)/i;
const action = /开发|研发|编程|实现|移植|集成|设计|适配|编写.{0,12}(?:程序|代码|固件)|(?:程序|代码).{0,12}编写|develop\w*|implement\w*|porting|design\w*/i;
const responsibility = /负责|参与|承担|完成|主导|协助|responsib|you will/i;
const qualification = /熟悉|掌握|精通|了解|优先|经验|能力|具备|knowledge|familiar|experience|proficien/i;

export function learnEmbeddedEvidence(rows, family) {
  const seeds = rows.filter(r => titleSeed.test(String(r['岗位名称'] || '')));
  const bodies = rows.map(r => roleSections(r).map(p => p.quote).join('\n'));
  const seedBodies = seeds.map(r => roleSections(r).map(p => p.quote).join('\n'));
  const keywords = vocabulary.map(([term, pattern]) => ({ term, score: 1,
    seed_df: seedBodies.filter(q => pattern.test(q)).length,
    background_df: bodies.filter(q => pattern.test(q)).length, source: 'curated-embedded-vocabulary',
  }));
  return { version: 'embedded-evidence-v1', family: family.name, scope: family.name,
    algorithm: 'curated-context', display_name: '嵌入式领域关键词＋软件工程职责证据',
    profile: 'embedded-software-engineering', keywords, display_keywords: keywords,
    minimum_hits: 1, threshold: 4, training_seed_rows: seeds.map(r => r.row_no),
    rule_seed_candidates: seeds.length, training_background_rows: rows.length, cold_start: false,
    seed_source: '人工配置的嵌入式领域词表；标题仅统计种子，不直接放行；词频来自本数据集有效正文',
    selection_policy: '至少一个领域词与软件对象、开发动作共同出现在有效正文；明确职责4分纳入，技能/经验或模糊证据2分待核；C/C++、Linux、标题和查询词不单独放行；人工配置启发式，未校准准确率',
  };
}

export function matchEmbeddedEvidence(row, model) {
  const evidence = roleSections(row).map(p => {
    const hits = vocabulary.filter(([, regex]) => regex.test(p.quote)).map(([term]) => term);
    const engineering = p.quote.split(/[，,]/).some(clause => {
      const obj = clause.match(softwareObject), act = clause.match(action);
      return obj && act && Math.abs(obj.index - act.index) <= 80 &&
        !/测试(?:方案|用例|脚本|报告)|test (?:plans?|cases?|scripts?)/i.test(clause);
    });
    // Some sites incorrectly label actual duties as requirements. Only explicit
    // responsibility verbs rescue those sections, never "熟悉/经验/优先" clauses.
    const duty = p.location === 'duties' || responsibility.test(p.quote);
    const score = hits.length && engineering && duty && !qualification.test(p.quote) ? 4 : hits.length ? 2 : 0;
    return { ...p, hits, score };
  }).filter(p => p.hits.length);
  const score = Math.max(0, ...evidence.map(p => p.score));
  const decision = score >= model.threshold ? 'include' : score ? 'review' : 'exclude';
  return { matched: decision === 'include', decision, method: model.display_name,
    confidence_band: decision === 'include' ? '证据纳入（非概率）' : decision === 'review' ? '待复核' : '排除',
    reasons: [decision === 'include' ? '正文包含明确嵌入式软件工程职责' : decision === 'review' ? '有领域词，但职责或软件对象证据不足' : '无嵌入式软件工程证据'],
    topic_matches: [...new Set(evidence.flatMap(p => p.hits))], joint_evidence: null,
    keyword_evidence: { model_version: model.version, algorithm: model.algorithm, rule_seed: false,
      score, threshold: model.threshold, decision, hits: [...new Set(evidence.flatMap(p => p.hits))],
      quotes: evidence.map(p => ({ keyword: p.hits.join('、'), quote: p.quote, location: p.location, score: p.score })),
      production_quotes: evidence.filter(p => p.score >= model.threshold).map(p => p.quote) },
  };
}
