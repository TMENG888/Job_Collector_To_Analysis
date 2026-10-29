import {collectionTransportPolicy} from './channel_acquisition.mjs';

// Reuse the high-yield channel's transport, not an entire historical checkout.
// Maxima are observations from different queries, never a promised yield.
export const collectorIntegrationBaselines=Object.freeze({
  zhaopin:{reference:'a4513be',transport:'session_json_api',pagination:'explicit_server_end',historicalMaximum:52038},
  job51:{reference:'b920ce8',transport:'session_client_api',pagination:'website_next_with_cursor_resume',historicalMaximum:6901},
  shixiseng:{reference:'fac77dd',transport:'public_json_api',pagination:'checkpointed_pages_and_cached_details',historicalMaximum:5758},
  iguopin:{reference:'fac77dd',transport:'public_json_api',pagination:'checkpointed_pages',historicalMaximum:2230},
  jobonline:{reference:'fac77dd',transport:'public_json_api',pagination:'single_public_window_per_keyword_city',historicalMaximum:1912},
  mohrss:{reference:'fac77dd',transport:'server_embedded_json',pagination:'official_pages_with_related_search',historicalMaximum:257},
  liepin:{reference:'fac77dd',transport:'website_session_api',pagination:'official_search_response',historicalMaximum:40},
  nowcoder:{reference:'fac77dd',transport:'nowpick_form_api',pagination:'verified_public_pages',historicalMaximum:3256},
});

const number=(value,fallback)=>value!=null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):fallback;
export function collectionRequestProfile(platform,request={},env=process.env){
  const minimumIntervalMs=Math.max(collectionTransportPolicy.minimumIntervalMs,
    number(platform==='zhaopin'?env.JOB_ZHAOPIN_INTERVAL_MS:undefined,number(request.minimumIntervalMs,3000)));
  const burstSize=number(env.JOB_HTTP_BURST_SIZE,0),burstRecoveryMs=number(env.JOB_HTTP_BURST_RECOVERY_MS,0);
  return {minimumIntervalMs,jitterMs:number(request.jitterMs,700),attempts:platform==='zhaopin'?1:number(request.attempts,2),
    burstSize:burstRecoveryMs>0?burstSize:0,burstRecoveryMs:burstSize>0?burstRecoveryMs:0};
}
