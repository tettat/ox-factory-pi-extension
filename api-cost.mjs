import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const source = 'https://developers.openai.com/api/docs/pricing';
// Reference tariff, not a claim about subscription billing, tier or context size.
export const DEFAULT_API_PRICES = Object.fromEntries([
  ['gpt-6-astra',10,1,50], ['gpt-5.6-sol',4,0.4,20],
  ['gpt-5.6-terra',2,0.2,12], ['gpt-5.6-luna',0.2,0.02,1.2],
].map(([model,input,cachedInput,output])=>[model,{input,cachedInput,output,source,observedAt:'2026-09-07',basis:'standard-short-context'}]));
export function readApiPrices(workersDir) {
  const file=join(workersDir,'config','api-prices.json');
  if(!existsSync(file)) return DEFAULT_API_PRICES;
  // Invalid configuration must not silently fall back to a plausible price.
  try {const value=JSON.parse(readFileSync(file,'utf8')); return value.models && typeof value.models==='object' ? value.models : {};}
  catch {return {};}
}
const valid = value=>typeof value==='number' && Number.isFinite(value) && value>=0;
const legacyCodexUsage = job=>!job.tokenUsageSchema && Boolean(job.codexThreadId || job.codexTurnId);
export function estimateApiCost(job, prices={}) {
  const missing=status=>({status,usd:null,currency:'USD'});
  const price=job.apiPrice || prices[job.model];
  if(!price || !['input','cachedInput','output'].every(key=>valid(price[key]))) return missing('price_missing');
  const inferredLegacyCodex = legacyCodexUsage(job);
  if(job.tokenUsageSchema!=='codex-inclusive-v1' && !inferredLegacyCodex) return missing('usage_unknown');
  if(!['inputTokens','cachedInputTokens','outputTokens'].every(key=>valid(job[key])) || job.cachedInputTokens>job.inputTokens) return missing('usage_incomplete');
  const inputUsd=(job.inputTokens-job.cachedInputTokens)*price.input/1e6;
  const cachedUsd=job.cachedInputTokens*price.cachedInput/1e6;
  const outputUsd=job.outputTokens*price.output/1e6;
  return {status:'estimated',usd:Number((inputUsd+cachedUsd+outputUsd).toFixed(10)),currency:'USD',inputUsd,cachedUsd,outputUsd,
    legacyInferred:inferredLegacyCodex,
    provisional:!['done','failed','aborted','stale'].includes(job.status),price,
    note:`按参考 API 单价折算；非实际扣费，不含缓存写入、图片生成、搜索等额外收费；未自动识别长上下文、Fast 或区域加价。${inferredLegacyCodex?' 该 job 缺少新 schema，因存在 Codex thread/turn 记录，按历史 Codex token 字段保守估算。':''}`};
}
export function summarizeApiCosts(jobs,prices) {
  const costs=jobs.map(job=>estimateApiCost(job,prices));
  const known=costs.filter(cost=>cost.usd!=null);
  const sum=known.reduce((total,cost)=>total+cost.usd,0);
  return {usd:known.length?Number(sum.toFixed(10)):null,pricedJobs:known.length,unpricedJobs:costs.length-known.length,
    avgUsd:known.length?sum/known.length:null};
}
