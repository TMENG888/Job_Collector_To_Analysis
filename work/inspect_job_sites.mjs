const sites = {
  shixi: 'https://www.shixiseng.com/interns?keyword=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91&city=%E5%85%A8%E5%9B%BD&type=intern',
  boss: 'https://www.zhipin.com/web/geek/jobs?query=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91&city=101280100',
  liepin: 'https://www.liepin.com/zhaopin/?workYearCode=1&key=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91',
  zhaopin: 'https://www.zhaopin.com/jobs?jl=763&kw=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91',
  job51: 'https://we.51job.com/pc/search?jobArea=030200&keyword=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91&searchType=2',
  iguopin: 'https://www.iguopin.com/job/list?keyword=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91',
  mohrss: 'http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist?textfield=%E6%99%BA%E8%83%BD%E4%BD%93%E5%BC%80%E5%8F%91',
};

const markers = [
  '__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__INITIAL_DATA__', 'window.__',
  'totalPage', 'pageCount', 'pagination', 'jobList', 'positionList', 'searchResult',
];

for (const [name, url] of Object.entries(sites)) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36' } });
  const html = await response.text();
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map((match) => match[1]);
  const result = {
    name,
    status: response.status,
    length: html.length,
    markers: Object.fromEntries(markers.map((marker) => [marker, html.indexOf(marker)])),
    scripts: scripts.slice(-12),
  };
  console.log(JSON.stringify(result));
}
