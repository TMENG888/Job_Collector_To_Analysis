import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { fetchJsonWithTimeout } from '../job_collector_ui/public/http-client.js';

const origin = 'http://127.0.0.1:8788';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/slow') return;
  if (req.url === '/body') { res.writeHead(200); res.write('{'); return; }
  if (req.url === '/error') { res.writeHead(409); res.end('{"error":"busy"}'); return; }
  res.end('{"ok":true}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const testOrigin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  assert.deepEqual(await fetchJsonWithTimeout(testOrigin), {ok:true});
  await assert.rejects(fetchJsonWithTimeout(testOrigin+'/error'), e => e.status === 409 && e.message === 'busy');
  for (const route of ['/slow', '/body']) await assert.rejects(fetchJsonWithTimeout(testOrigin+route, {}, 80), /请求超时/);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(fetchJsonWithTimeout(testOrigin, {}, 500), /无法连接本地服务/);

  const timings = {};
  for (const route of ['/platforms', '/api/platforms', '/api/state']) {
    const start = performance.now(), response = await fetch(origin+route);
    assert.ok(response.ok); await response.text(); timings[route] = Math.round(performance.now()-start);
  }
  browser = await chromium.launch({headless:true, executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  await page.goto(origin+'/platforms');
  const button = page.locator('[data-platform-login="boss"]');
  await button.waitFor();
  await page.evaluate(() => {
    window.originalBoss = document.querySelector('[data-platform-login="boss"]');
    window.platformMutations = 0;
    new MutationObserver(records => { window.platformMutations += records.length; }).observe(document.querySelector('#platformGroups'), {subtree:true,childList:true,attributes:true,characterData:true});
    window.originalBoss.focus();
  });
  await page.waitForTimeout(6700);
  assert.ok(await page.evaluate(() => window.originalBoss === document.querySelector('[data-platform-login="boss"]')));
  assert.ok(await page.evaluate(() => document.activeElement === window.originalBoss));
  assert.equal(await page.evaluate(() => window.platformMutations), 0, 'unchanged polls must not mutate DOM');
  assert.ok(requests.filter(p=>p==='/api/platforms').length >= 3);
  assert.equal(requests.filter(p=>p==='/api/insights/datasets').length, 0);

  let active = 0, maxActive = 0, slowCalls = 0;
  const platforms = await (await fetch(origin+'/api/platforms')).json();
  await page.route('**/api/platforms', async route => {
    active++; maxActive = Math.max(maxActive, active); slowCalls++;
    await new Promise(r => setTimeout(r, 3500));
    active--; await route.fulfill({json:platforms});
  });
  await page.locator('#refreshPlatforms').click();
  await page.waitForTimeout(7500);
  assert.equal(maxActive, 1, 'slow polls must not stack');
  assert.ok(slowCalls <= 3);
  await page.unrouteAll({behavior:'wait'});
  await page.waitForTimeout(4000);

  let posts = 0;
  await page.route('**/api/platforms/boss/login', async route => {
    posts++;
    await new Promise(r => setTimeout(r, 3500));
    await route.fulfill({json:{message:'mock login: no real browser opened'}});
  });
  await button.click();
  await page.waitForTimeout(3100);
  assert.ok(await button.isDisabled(), 'poll must preserve pending login disabled state');
  await page.waitForTimeout(1200);
  assert.equal(posts, 1);
  await page.route('**/api/platforms', route => route.abort('connectionrefused'));
  await page.locator('#refreshPlatforms').click();
  await page.waitForFunction(() => document.querySelector('#refreshPlatforms').title.includes('无法连接'));
  await page.unroute('**/api/platforms');
  await page.locator('#refreshPlatforms').click();
  await page.waitForFunction(() => document.querySelector('#refreshPlatforms').title === '本地服务连接正常');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:true,timingsMs:timings,unchangedPollDomMutations:0,maxConcurrentPlatformRequests:maxActive,loginPosts:posts,pageErrors:errors}));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); server.close();
}
