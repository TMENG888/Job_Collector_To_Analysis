// Describe transports truthfully; a server-rendered JSON field is not a JSON API.
export const channelAcquisition = Object.freeze({
  shixiseng:{mode:'public_json_api',authentication:'public',pagination:'page',directHttpReady:true,browserRequired:false},
  iguopin:{mode:'public_json_api',authentication:'public',pagination:'page',directHttpReady:true,browserRequired:false},
  mohrss:{mode:'server_embedded_json',authentication:'public',pagination:'pageNo',directHttpReady:true,browserRequired:false},
  zhaopin:{mode:'session_json_api',authentication:'manual_login_cookie',pagination:'pageIndex',directHttpReady:true,browserRequired:false,sessionCookieFile:'ui_data/zhaopin_login/cookies.json',pauseReason:''},
  jobonline:{mode:'public_json_api',authentication:'public',pagination:'keyword_city',directHttpReady:true,browserRequired:false},
  job51:{mode:'session_client_api',authentication:'manual_slider_session',pagination:'platform_client',directHttpReady:false,browserRequired:true,pauseReason:'需人工过一次阿里云滑块验证；之后复用本地会话监听网站接口，效率低于纯HTTP但稳定合规'},
  liepin:{mode:'website_session_api',authentication:'official_website_session',pagination:'currentPage',directHttpReady:false,browserRequired:true,pauseReason:'仅通过官网页面自身的搜索响应取数；验证即停，不进行 HTTP 重放或验证绕过'},
  nowcoder:{mode:'nowpick_form_api',authentication:'public',pagination:'page',directHttpReady:true,browserRequired:false,note:'NOWPICK 网关 /u/job/square-search，POST x-www-form-urlencoded；GET 返回 405，白名单仅登记该路径'},
});

export const explicitWebsiteSessionPlatforms=Object.freeze(['liepin']);
export const collectionTransportPolicy=Object.freeze({mode:'direct_http_validated_data',browserAutomation:false,htmlFallback:false,approvedEmbeddedData:['mohrss'],explicitWebsiteSessionPlatforms,minimumIntervalMs:2500,perOriginConcurrency:1,maxAttempts:2,cooldownMs:15*60*1000});

export const HYBRID_MODE='http_preferred_browser_fallback';
export const browserFallbackPlatforms=Object.freeze(['zhaopin','job51','jobonline']);
// 会话代理平台：其采集本质是调用网站接口（非页面 RPA），仅需本地浏览器提供 WAF/会话。
// 允许在任何采集模式下启动受管浏览器，以便人工过验证后续采。
export const sessionProxyPlatforms=Object.freeze(['job51']);
export function collectionMode(task){
  const mode=task?.transportMode||process.env.JOB_COLLECTION_MODE||collectionTransportPolicy.mode;
  if(![collectionTransportPolicy.mode,HYBRID_MODE].includes(mode))throw Error('未知采集方式');
  return mode;
}
export function collectionPolicyFor(task){
  return collectionMode(task)===HYBRID_MODE?{...collectionTransportPolicy,mode:HYBRID_MODE,browserAutomation:true,browserFallbackPlatforms,maxBrowserWorkers:1,browserMode:'visible_dom',accessDenialFallback:false}:collectionTransportPolicy;
}
