import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOutsourcePiArgs, getPiInvocation } from '../outsource-runner.mjs';

test('DeepSeek Pi outsources load scoped provider and preserve each effort', () => {
  const root=mkdtempSync(join(tmpdir(),'ox-ds-test-'));
  try {
    const workersDir=join(root,'workers');
    const extensions=join(root,'extensions');
    mkdirSync(extensions); writeFileSync(join(extensions,'internlab-provider.ts'),'');
    for(const thinking of ['low','high','max']) {
      const {args}=buildOutsourcePiArgs({workersDir,profile:{name:`deepseek-flash-${thinking}`,model:'internlab/deepseek-v4-flash-0731',thinking},task:'test'});
      assert.equal(args[args.indexOf('--extension')+1],join(extensions,'internlab-provider.ts'));
      assert.equal(args[args.indexOf('--thinking')+1],thinking);
      assert.ok(args.includes('--no-session'));
    }
    assert.ok(!buildOutsourcePiArgs({profile:{model:'other/model'}}).args.includes('--extension'));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Windows outsource launch uses Node CLI rather than npm shell shim', () => {
  const invocation=getPiInvocation(['--mode','json'],{currentScript:'outsource-cli.mjs',execPath:'C:/node/node.exe',platform:'win32',exists:()=>true});
  assert.equal(invocation.command,'C:/node/node.exe');
  assert.match(invocation.args[0],/cli\.js$/);
  assert.deepEqual(invocation.args.slice(1),['--mode','json']);
});
