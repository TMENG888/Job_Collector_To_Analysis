import {browserSites, safeBrowserURL, publicResourceURL} from '../work/job-browser-contracts.mjs';

export {browserSites};
export const SHELL_HEIGHT = 56;
export const BROWSER_HEIGHT = 152;
export const FOOTER_HEIGHT = 26;
export const PANEL_WIDTH = 340;
export const MAX_TABS = 8;
export const COMMANDS = new Set(['state','workspace']);

export function checkedBaseURL(value = 'http://127.0.0.1:8788') {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('工作台仅支持本机127.0.0.1 HTTP服务');
  return u.origin;
}
export function workspaceURL(base, route) {
  const routes = {tasks:'/tasks', quality:'/sources', insights:'/insights', matching:'/matching', assistant:'/?view=assistant'};
  if (!Object.hasOwn(routes, route)) throw Error('未知工作台页面');
  return checkedBaseURL(base) + routes[route];
}
export function isWorkspaceURL(value, base) {
  try {const u = new URL(value);return u.origin === checkedBaseURL(base) && !u.username && !u.password;} catch {return false;}
}
export function workspaceViewForURL(value, base) {
  if (!isWorkspaceURL(value, base)) return null;
  const u = new URL(value);
  if (u.searchParams.get('view') === 'assistant') return 'assistant';
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (first==='sources') return 'quality';
  if (['tasks','quality','insights','matching'].includes(first)) return first;
  if(first==='browser')return 'tasks';
  return u.pathname === '/' ? 'tasks' : null;
}
export function recruitingURL(value) {return safeBrowserURL(value);}
export function isRecruitingURL(value) {try {recruitingURL(value);return true;} catch {return false;}}
export function allowRecruitingResource(value) {
  if (/^(?:data|blob):/.test(value)) return true;
  if (value.startsWith('wss:')) value='https:'+value.slice(4);
  // Do not expose the local control API, files or internal-network addresses to websites.
  return publicResourceURL(value) && new URL(value).protocol === 'https:';
}
export function viewBounds(width, height, mode, zoomFactor=1) {
  const top = Math.round((mode === 'browser' ? BROWSER_HEIGHT : SHELL_HEIGHT)*zoomFactor);
  return {x:0, y:top, width:Math.max(0, width - (mode === 'browser' ? Math.round(PANEL_WIDTH*zoomFactor) : 0)), height:Math.max(0, height-top-Math.round(FOOTER_HEIGHT*zoomFactor))};
}
export function navigationDecision(value) {
  // about:blank is never used as recovery navigation: leave the current page intact.
  return isRecruitingURL(value) ? 'allow' : 'deny';
}
