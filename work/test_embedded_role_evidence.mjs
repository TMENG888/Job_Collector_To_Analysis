import assert from 'node:assert/strict';
import { learnEmbeddedEvidence, matchEmbeddedEvidence } from './embedded-role-evidence.mjs';
const model = learnEmbeddedEvidence([], { name: '嵌入式开发' });
const cases = [
  ['固件', '岗位职责：负责产品固件开发与调试。', 'include'],
  ['单片机', '岗位职责：完成单片机部分的软件开发。', 'include'],
  ['STM32', '岗位职责：负责STM32程序编写和移植。', 'include'],
  ['BSP', '岗位职责：负责BSP开发和Bootloader移植。', 'include'],
  ['English', 'You will develop embedded software and implement device drivers.', 'include'],
  ['误标职责', '任职要求：负责嵌入式系统软件的设计、编程和调试。', 'include'],
  ['通用开发', '岗位职责：开发Java服务。任职要求：掌握C/C++与Linux。', 'exclude'],
  ['纯硬件', '岗位职责：完成嵌入式电路和PCB设计。', 'review'],
  ['技能要求', '任职要求：熟悉STM32和FreeRTOS，有嵌入式软件开发经验优先。', 'review'],
  ['销售', '岗位职责：负责嵌入式产品销售，协助客户开发市场。', 'review'],
  ['纯测试', '岗位职责：负责嵌入式软件测试，编写测试报告。', 'review'],
  ['公司简介', '公司介绍：负责嵌入式软件开发。岗位职责：负责行政工作。', 'exclude'],
  ['标题直通', '岗位职责：负责道路数据采集和标注。', 'exclude'],
];
for (const [name, jd, expected] of cases) {
  assert.equal(matchEmbeddedEvidence({ '岗位名称': '嵌入式软件工程师', '岗位描述': jd }, model).decision, expected, name);
}
console.log(`${cases.length} embedded evidence fixtures passed`);
