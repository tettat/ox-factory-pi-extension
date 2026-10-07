import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublicConversation } from '../public-conversation.mjs';
import { buildRouter } from '../web-server.mjs';
import { createJob, appendJobEvent } from '../jobs.mjs';
test('public speech survives tool floods, groups deltas, excludes thinking and restores steer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-conversation-'));
  const job = { id: 'a', eventFile: join(dir, 'a.jsonl') };
  const append = ev => appendFileSync(job.eventFile, JSON.stringify(ev) + '\n');
  try {
    append({ type: 'text', text: '先检查', time: '1' });
    append({ type: 'text', text: '代码。', time: '2' });
    for (let i = 0; i < 1200; i++) append({ type: 'tool', text: 'tool output' });
    append({ type: 'thinking', text: 'private reasoning' });
    append({ type: 'steer', text: '不要重启', queuedJobId: 'b', time: '3' });
    append({ type: 'text', text: '收到', time: '4' });
    let blocks = readPublicConversation(job);
    assert.deepEqual(blocks.map(b => b.text), ['先检查代码。', '不要重启', '收到']);
    blocks[0].text = 'mutated';
    append({ type: 'text', text: '，继续。', time: '5' });
    blocks = readPublicConversation(job);
    assert.equal(blocks[0].text, '先检查代码。');
    assert.equal(blocks[2].text, '收到，继续。');
    appendFileSync(job.eventFile, '{"type":"text","text":"半');
    assert.equal(readPublicConversation(job).length, 3);
    appendFileSync(job.eventFile, '行"}\n');
    assert.equal(readPublicConversation(job)[2].text, '收到，继续。半行');
    append({ type: 'text', text: '长'.repeat(25000) });
    assert.ok(readPublicConversation(job).every(b => b.type !== 'text' || b.text.length <= 12000));
    assert.equal(readPublicConversation(job).filter(b => b.type === 'text').map(b => b.text).join('').length, '先检查代码。收到，继续。半行'.length + 25000);
    writeFileSync(job.eventFile, JSON.stringify({type:'text',text:'new file'}) + '\n');
    assert.equal(readPublicConversation(job)[0].text, 'new file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public conversation API pages older speech without marking jobs read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-conversation-api-'));
  try {
    const job = createJob(dir, { worker: 'fixture', task: 'test' });
    for (let i = 0; i < 45; i++) {
      appendJobEvent(job, {type:'text',text:`speech ${i}`});
      appendJobEvent(job, {type:'tool',text:'tool noise'});
    }
    const router = buildRouter({workersDir:dir});
    async function get(offset) {
      let body, status;
      await router({method:'GET',url:`/api/jobs/${job.id}?conversation=1&offset=${offset}`,headers:{}}, {
        writeHead(code){status=code;},end(value){body=JSON.parse(value);}
      });
      assert.equal(status,200);return body;
    }
    const first=await get(0), second=await get(first.nextOffset);
    assert.equal(first.blocks.length,40);assert.equal(first.hasMore,true);
    assert.equal(second.blocks.length,5);assert.equal(second.hasMore,false);
    assert.equal(first.blocks[0].text,'speech 0');assert.equal(second.blocks[4].text,'speech 44');
    assert.equal(first.read,undefined);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
