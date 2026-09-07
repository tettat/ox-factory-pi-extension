const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalWithCachedTokens'];
const mean = (values) => values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) : null;

// Use job metadata before quality-turn filtering: missing measurements must remain visible.
export function summarizeModelExecution(jobs = []) {
  const groups = new Map();
  for (const job of jobs) {
    const model = String(job.model || '').trim() || '未记录模型';
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model).push(job);
  }
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([model, rows]) => {
    const completed = rows.filter(job=>job.status === 'done');
    // A steer job measures injection acknowledgement, not completion of a model task.
    const eligible = completed.filter(job=>job.deliveryMode !== 'steer');
    const durations = eligible.flatMap(job => {
      if (!job.startedAt || !job.finishedAt) return [];
      const start = Date.parse(job.startedAt), end = Date.parse(job.finishedAt);
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [end-start] : [];
    }).sort((a,b)=>a-b);
    const middle = Math.floor(durations.length/2);
    const median = durations.length ? (durations.length%2 ? durations[middle] : (durations[middle-1]+durations[middle])/2) : null;
    return {
      model, jobs: rows.length, completed: completed.length,
      excludedSteer: completed.length-eligible.length,
      durationSamples: durations.length, missingDuration: eligible.length-durations.length,
      avgDurationMs: mean(durations), medianDurationMs: median,
      tokens: Object.fromEntries(TOKEN_FIELDS.map(field => {
        const values = eligible.map(job=>job[field]).filter(value=>typeof value === 'number' && Number.isFinite(value) && value>=0);
        return [field, {average:mean(values), samples:values.length, missing:eligible.length-values.length}];
      })),
    };
  });
}
