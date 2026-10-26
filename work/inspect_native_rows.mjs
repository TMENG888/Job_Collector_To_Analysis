// 只读诊断：查看原生库中渠道行的字段形状与条数（不写任何文件）。
import {DatabaseSync} from 'node:sqlite';

const dbPath = process.argv[2];
if (!dbPath) throw Error('用法：node inspect_native_rows.mjs <统一采集数据.sqlite>');
const db = new DatabaseSync(dbPath, {readOnly: true});

console.log('metadata: ' + JSON.stringify(db.prepare('SELECT * FROM metadata').all()));
console.log('平台条数: ' + JSON.stringify(db.prepare('SELECT platform, COUNT(*) AS n FROM jobs GROUP BY platform ORDER BY n DESC').all()));

for (const platform of ['nowcoder', '智联招聘']) {
  const row = db.prepare('SELECT data FROM jobs WHERE platform = ? LIMIT 1').get(platform);
  if (!row) { console.log(`${platform}: 无数据`); continue; }
  const parsed = JSON.parse(row.data);
  const keys = Object.keys(parsed);
  console.log(`${platform}: ${keys.length} 字段 -> ${keys.join(',')}`);
  console.log(`${platform} 样例: ${JSON.stringify({job_id: parsed.job_id, job_name: parsed.job_name, company_name: parsed.company_name, city: parsed.city, salary: parsed.salary, query_keyword: parsed.query_keyword, query_city: parsed.query_city})}`);
}

const zhaopinKw = db.prepare("SELECT json_extract(data,'$.query_keyword') AS kw, COUNT(*) AS n FROM jobs WHERE platform='智联招聘' GROUP BY kw ORDER BY n DESC").all();
console.log('智联关键词分布: ' + JSON.stringify(zhaopinKw));