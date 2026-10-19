import {channelAcquisition,collectionMode,HYBRID_MODE,browserFallbackPlatforms,sessionProxyPlatforms} from './channel_acquisition.mjs';
// Retired adapters/data are retained for audit; retirement stops new requests.
export const retiredCollectionChannels=new Set(['yupao','boss']);
export const collectionChannelAvailable=(key,task)=>!retiredCollectionChannels.has(key)&&(!channelAcquisition[key]||channelAcquisition[key].directHttpReady===true||sessionProxyPlatforms.includes(key)||collectionMode(task)===HYBRID_MODE&&browserFallbackPlatforms.includes(key));
export function collectionChannelPauseReason(key){
  if(retiredCollectionChannels.has(key))return '渠道已撤下，历史数据与断点保留';
  return channelAcquisition[key]?.pauseReason||'无浏览器 HTTP 模式未接入该渠道';
}
export function assertDirectHttpCollection(key){
  if(!channelAcquisition[key]?.directHttpReady)throw Object.assign(new Error(`${key}：${collectionChannelPauseReason(key)}；禁止启动自动化浏览器，历史断点保留`),{code:'DIRECT_HTTP_REQUIRED',stopChannel:true});
}
