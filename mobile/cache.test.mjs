import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanConversation, mergeConversation, conversationKey, createConversationCache } from './web/cache.js';

test('local history accumulates older rows without duplicates and preserves full fetched replies', () => {
  const old = { jobs: [{ id: 'old', createdAt: '2020', updatedAt: '2021', reply: '完整长回复', summary: '摘要' }], messages: [{ id: 'm', createdAt: '2019', content: '早期消息' }] };
  const result = mergeConversation(old, { jobs: [{ id: 'new', createdAt: '2024', reply: '新回复' }, { id: 'old', createdAt: '2020', updatedAt: '2021', reply: '摘要', summary: '摘要' }] });
  assert.deepEqual(result.jobs.map(j => j.id), ['old', 'new']); assert.equal(result.jobs[0].reply, '完整长回复');
  assert.equal(result.messages[0].content, '早期消息'); assert.equal(old.jobs.length, 1);
  assert.equal(mergeConversation(result, { jobs: [{ id: 'old', updatedAt: '2025', reply: '确实更新' }] }).jobs[0].reply, '确实更新');
});

test('disk records omit read capabilities and partition owners, devices and workers', () => {
  const r = cleanConversation({ historyRead: { token: 'secret' }, jobs: [{ id: 'j', readState: { token: 'secret' }, reply: 'hi' }], messages: [{ id: 'm', readState: { token: 'secret' }, content: 'hi' }] });
  assert.doesNotMatch(JSON.stringify(r), /secret|historyRead|readState/);
  const key = conversationKey('owner', 'device', 'worker');
  for (const ids of [['another', 'device', 'worker'], ['owner', 'another', 'worker'], ['owner', 'device', 'another']]) assert.notEqual(conversationKey(...ids), key);
  assert.equal(conversationKey('owner', 'device', 'worker'), key);
});

test('restricted storage reports a failure rather than pretending the conversation is persistent', async () => {
  const cache = createConversationCache(null);
  await assert.rejects(cache.save('k', {}), /LOCAL_CACHE_UNAVAILABLE/);
  await assert.rejects(cache.load('k'), /LOCAL_CACHE_UNAVAILABLE/);
  await assert.rejects(cache.clear(), /LOCAL_CACHE_UNAVAILABLE/);
});
