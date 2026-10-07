import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutsourceProfile } from '../outsource-agents.mjs';
import { buildOutsourceKimiWorker } from '../outsource-runner.mjs';
import { buildKimiCliArgs, buildKimiTaskContent } from '../kimi-backend.mjs';

test('Kimi outsource preserves model and starts without a resumed session', () => {
  const profile = normalizeOutsourceProfile({name:'kimi-k3',backend:'kimi',model:'kimi-code/k3'});
  const worker = buildOutsourceKimiWorker({...profile,kimiSessionId:'do-not-inherit'});
  const args = buildKimiCliArgs({worker,taskContent:'test'});
  assert.equal(profile.backend,'kimi');
  assert.deepEqual(args,['--output-format','stream-json','--model','kimi-code/k3','-p','test']);
  assert.equal(worker.kimiSessionId,undefined);
  assert.notEqual(worker,buildOutsourceKimiWorker(profile));
});

test('Kimi outsource uses whitepaper instructions rather than employee identity', () => {
  const text = buildKimiTaskContent({worker:buildOutsourceKimiWorker({name:'kimi-k3'}),task:'检查代码',project:'test',systemPromptOverride:'你是白纸外包，无长期记忆。'});
  assert.match(text,/白纸外包/);
  assert.match(text,/检查代码/);
  assert.doesNotMatch(text,/保持这个身份和长期上下文/);
});
