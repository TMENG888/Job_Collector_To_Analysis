import fs from 'node:fs/promises';
const root = new URL('../job_collector_ui/public/maps/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const cities = { 北京:110000, 天津:120000, 上海:310000, 重庆:500000, 广州:440100, 深圳:440300, 杭州:330100, 成都:510100, 武汉:420100, 南京:320100, 苏州:320500, 西安:610100, 长沙:430100, 合肥:340100, 郑州:410100, 济南:370100, 青岛:370200, 厦门:350200, 福州:350100, 无锡:320200, 宁波:330200, 东莞:441900, 佛山:440600, 珠海:440400, 昆明:530100, 沈阳:210100, 大连:210200 };
const errors = [];
const features = [];
for (const [name, code] of Object.entries(cities)) {
  try {
    let response = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${code}_full.json`, { signal: AbortSignal.timeout(20000) });
    if(response.status===404)response=await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${code}.json`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geo = await response.json();
    if (!geo.features?.length) throw new Error('Missing features');
    await fs.writeFile(new URL(`${code}.geojson`, root), JSON.stringify(geo));
    // Union represented as a MultiPolygon; district polygons preserve actual city boundaries.
    const polygons = geo.features.flatMap((f) => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    features.push({ type:'Feature', properties:{ name, adcode:code }, geometry:{ type:'MultiPolygon', coordinates:polygons } });
  } catch (error) { errors.push({name, error:error.message}); }
}
await fs.writeFile(new URL('cities.geojson', root), JSON.stringify({type:'FeatureCollection', features}));
await fs.writeFile(new URL('source.json', root), JSON.stringify({source:'DataV 公开行政区边界',url:'https://geo.datav.aliyun.com/areas_v3/bound/',cached_at:new Date().toISOString(),cities,errors},null,2));
console.log(JSON.stringify({cached:features.length,errors}));
