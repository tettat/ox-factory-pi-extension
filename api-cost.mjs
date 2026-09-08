import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_GPT55_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.5';
const OPENAI_GPT54_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.4';
const MINIMAX_PRICING_SOURCE = 'https://platform.minimaxi.com/docs/guides/pricing-paygo';
const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const ZAI_PRICING_SOURCE = 'https://docs.z.ai/guides/overview/pricing';
const OBSERVED_AT = '2026-09-08';
const REFERENCE_CNY_PER_USD = 7;
const OPENAI_LONG_CONTEXT = { inputThresholdTokens: 272000, inputMultiplier: 2, cachedInputMultiplier: 2, outputMultiplier: 1.5 };
const providerExclusive = { inputTokenMode: 'exclusive', allowSchemaLessUsage: true };
const openaiInclusive = { currency: 'USD', inputTokenMode: 'inclusive', longContext: OPENAI_LONG_CONTEXT };

function price(input, cachedInput, output, options = {}) {
  return {
    input,
    cachedInput,
    output,
    currency: options.currency || 'USD',
    source: options.source,
    observedAt: options.observedAt || OBSERVED_AT,
    basis: options.basis,
    inputTokenMode: options.inputTokenMode || 'inclusive',
    allowSchemaLessUsage: Boolean(options.allowSchemaLessUsage),
    ...(options.aliasOf ? { aliasOf: options.aliasOf } : {}),
    ...(options.cnyPerUsd ? { cnyPerUsd: options.cnyPerUsd } : {}),
    ...(options.cacheWrite != null ? { cacheWrite: options.cacheWrite } : {}),
    ...(options.longContext ? { longContext: options.longContext } : {}),
    ...(options.tiers ? { tiers: options.tiers } : {}),
  };
}

function openaiPrice(input, cachedInput, output, options = {}) {
  return price(input, cachedInput, output, {
    ...openaiInclusive,
    source: options.source || OPENAI_PRICING_SOURCE,
    basis: options.basis || 'openai-standard-short-context',
    ...options,
  });
}

function openaiProviderAlias(input, cachedInput, output, options = {}) {
  return openaiPrice(input, cachedInput, output, {
    ...providerExclusive,
    source: options.source || OPENAI_GPT55_SOURCE,
    basis: options.basis || 'openai-standard-short-context-via-provider-alias',
    ...options,
  });
}

function cnyPrice(input, cachedInput, output, options = {}) {
  return price(input, cachedInput, output, {
    ...providerExclusive,
    currency: 'CNY',
    cnyPerUsd: REFERENCE_CNY_PER_USD,
    basis: options.basis || 'provider-paygo-cny-converted-to-usd',
    ...options,
  });
}

function clonePrice(entry, patch = {}) {
  return JSON.parse(JSON.stringify({ ...entry, ...patch }));
}

// Reference tariff, not a claim about subscription billing, tier or context size.
const gpt55Alias = openaiProviderAlias(5, 0.5, 30, { aliasOf: 'gpt-5.5', source: OPENAI_GPT55_SOURCE });
const glm52 = price(1.4, 0.26, 4.4, {
  ...providerExclusive,
  currency: 'USD',
  source: ZAI_PRICING_SOURCE,
  basis: 'zai-paygo',
});

export const DEFAULT_API_PRICES = {
  'gpt-6-astra': openaiPrice(10, 1, 50),
  'gpt-5.6-sol': openaiPrice(4, 0.4, 20),
  'gpt-5.6-terra': openaiPrice(2, 0.2, 12),
  'gpt-5.6-luna': openaiPrice(0.2, 0.02, 1.2),
  'gpt-5.5': openaiPrice(5, 0.5, 30, { source: OPENAI_GPT55_SOURCE, basis: 'openai-standard-short-context' }),
  'gpt-5.4': openaiPrice(2.5, 0.25, 15, { source: OPENAI_GPT54_SOURCE, basis: 'openai-standard-short-context' }),

  // Provider/relay aliases use provider-style usage records where `inputTokens`
  // excludes cache reads/writes, unlike Codex usage where cached input is a subset.
  'gpt-5.5-2026-04-24': clonePrice(gpt55Alias),
  'modelhub/gpt-5.5-2026-04-24': clonePrice(gpt55Alias),

  'MiniMax-M3': cnyPrice(2.1, 0.42, 8.4, {
    source: MINIMAX_PRICING_SOURCE,
    basis: 'minimax-standard-paygo-cny-converted-to-usd',
    longContext: { inputThresholdTokens: 512000, prices: { input: 4.2, cachedInput: 0.84, output: 16.8 } },
  }),
  'MiniMax-M2.7': cnyPrice(2.1, 0.42, 8.4, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),
  'MiniMax-M2.7-highspeed': cnyPrice(4.2, 0.42, 16.8, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),
  'MiniMax-M2.5': cnyPrice(2.1, 0.21, 8.4, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),
  'MiniMax-M2.5-highspeed': cnyPrice(4.2, 0.21, 16.8, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),
  'MiniMax-M2.1': cnyPrice(2.1, 0.21, 8.4, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),
  'MiniMax-M2.1-highspeed': cnyPrice(4.2, 0.21, 16.8, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),
  'MiniMax-M2': cnyPrice(2.1, 0.21, 8.4, { source: MINIMAX_PRICING_SOURCE, cacheWrite: 2.625 }),

  'deepseek-v4-flash': cnyPrice(1.5, 0.05, 4.5, {
    source: DEEPSEEK_PRICING_SOURCE,
    basis: 'deepseek-off-peak-cny-converted-to-usd',
    tiers: {
      offPeak: { input: 1.5, cachedInput: 0.05, output: 4.5 },
      peak: { input: 3.0, cachedInput: 0.10, output: 9.0 },
    },
  }),
  'deepseek-v4-pro': cnyPrice(4.5, 0.15, 13.5, {
    source: DEEPSEEK_PRICING_SOURCE,
    basis: 'deepseek-off-peak-cny-converted-to-usd',
    tiers: {
      offPeak: { input: 4.5, cachedInput: 0.15, output: 13.5 },
      peak: { input: 9.0, cachedInput: 0.30, output: 27.0 },
    },
  }),

  'opensource/glm5.2': clonePrice(glm52),
  'super-relay/opensource/glm5.2': clonePrice(glm52),
};

export function readApiPrices(workersDir) {
  const file=join(workersDir,'config','api-prices.json');
  if(!existsSync(file)) return DEFAULT_API_PRICES;
  // Invalid configuration must not silently fall back to a plausible price.
  try {const value=JSON.parse(readFileSync(file,'utf8')); return value.models && typeof value.models==='object' ? value.models : {};}
  catch {return {};}
}
const valid = value=>typeof value==='number' && Number.isFinite(value) && value>=0;
const legacyCodexUsage = job=>!job.tokenUsageSchema && Boolean(job.codexThreadId || job.codexTurnId);
function jobTime(job) {
  return job.startedAt || job.createdAt || job.updatedAt || job.completedAt || job.finishedAt || job.usageUpdatedAt;
}
function beijingParts(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}
function isDeepSeekPeak(value) {
  const parts = beijingParts(value);
  if (!parts) return false;
  if (['Sat','Sun'].includes(parts.weekday)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}
function effectivePriceForJob(job, basePrice) {
  const effective = clonePrice(basePrice);
  let pricingTier = effective.pricingTier || 'standard';
  if (effective.tiers?.peak && effective.tiers?.offPeak) {
    pricingTier = isDeepSeekPeak(jobTime(job)) ? 'peak' : 'off-peak';
    const tier = pricingTier === 'peak' ? effective.tiers.peak : effective.tiers.offPeak;
    Object.assign(effective, tier);
  }
  const long = effective.longContext;
  if (long && Number(job.inputTokens || 0) > Number(long.inputThresholdTokens || Infinity)) {
    pricingTier = 'long-context';
    if (long.prices) {
      Object.assign(effective, long.prices);
    } else {
      effective.input *= Number(long.inputMultiplier || 1);
      effective.cachedInput *= Number(long.cachedInputMultiplier || long.inputMultiplier || 1);
      effective.output *= Number(long.outputMultiplier || 1);
    }
  }
  return { price: effective, pricingTier };
}
export function estimateApiCost(job, prices={}) {
  const missing=status=>({status,usd:null,currency:'USD'});
  const basePrice=job.apiPrice || prices[job.model];
  if(!basePrice || !['input','cachedInput','output'].every(key=>valid(basePrice[key]))) return missing('price_missing');
  const {price, pricingTier}=effectivePriceForJob(job, basePrice);
  if(!price || !['input','cachedInput','output'].every(key=>valid(price[key]))) return missing('price_missing');
  const inferredLegacyCodex = legacyCodexUsage(job);
  const inputTokenMode = job.tokenUsageSchema==='codex-inclusive-v1' || inferredLegacyCodex ? 'inclusive' : price.inputTokenMode || 'inclusive';
  const schemaAllowsUsage = job.tokenUsageSchema==='codex-inclusive-v1' || inferredLegacyCodex || (price.allowSchemaLessUsage && inputTokenMode === 'exclusive');
  if(!schemaAllowsUsage) return missing('usage_unknown');
  if(!valid(job.inputTokens) || !valid(job.outputTokens)) return missing('usage_incomplete');
  const cachedInputTokens = job.cachedInputTokens == null ? 0 : job.cachedInputTokens;
  if(!valid(cachedInputTokens)) return missing('usage_incomplete');
  if(inputTokenMode === 'inclusive' && cachedInputTokens>job.inputTokens) return missing('usage_incomplete');
  const uncachedInputTokens = inputTokenMode === 'inclusive' ? job.inputTokens-cachedInputTokens : job.inputTokens;
  const nativeInput=uncachedInputTokens*price.input/1e6;
  const nativeCached=cachedInputTokens*price.cachedInput/1e6;
  const nativeOutput=job.outputTokens*price.output/1e6;
  const nativeAmount=nativeInput+nativeCached+nativeOutput;
  const nativeCurrency = price.currency || 'USD';
  if(nativeCurrency !== 'USD' && nativeCurrency !== 'CNY') return missing('currency_unsupported');
  const cnyPerUsd = nativeCurrency === 'CNY' ? Number(price.cnyPerUsd || REFERENCE_CNY_PER_USD) : 1;
  if(nativeCurrency === 'CNY' && (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0)) return missing('currency_unsupported');
  const inputUsd=nativeInput/cnyPerUsd;
  const cachedUsd=nativeCached/cnyPerUsd;
  const outputUsd=nativeOutput/cnyPerUsd;
  const usd=inputUsd+cachedUsd+outputUsd;
  return {status:'estimated',usd:Number(usd.toFixed(10)),currency:'USD',inputUsd,cachedUsd,outputUsd,
    nativeAmount:Number(nativeAmount.toFixed(10)),nativeCurrency,
    ...(nativeCurrency === 'CNY' ? { fx: { from: 'CNY', to: 'USD', cnyPerUsd } } : {}),
    legacyInferred:inferredLegacyCodex,
    inputTokenMode,
    pricingTier,
    uncachedInputTokens,
    provisional:!['done','failed','aborted','stale'].includes(job.status),price,
    note:`按参考 API 单价折算；非实际扣费，不含缓存写入、图片生成、搜索等额外收费；已按可识别规则处理长上下文或峰谷价，未自动识别 Fast/priority 或区域加价。${nativeCurrency === 'CNY' ? ` 原始价格为 CNY，按 ${cnyPerUsd} CNY/USD 参考换算。` : ''}${inferredLegacyCodex?' 该 job 缺少新 schema，因存在 Codex thread/turn 记录，按历史 Codex token 字段保守估算。':''}`};
}
export function summarizeApiCosts(jobs,prices) {
  const costs=jobs.map(job=>estimateApiCost(job,prices));
  const known=costs.filter(cost=>cost.usd!=null);
  const sum=known.reduce((total,cost)=>total+cost.usd,0);
  return {usd:known.length?Number(sum.toFixed(10)):null,pricedJobs:known.length,unpricedJobs:costs.length-known.length,
    avgUsd:known.length?sum/known.length:null};
}
