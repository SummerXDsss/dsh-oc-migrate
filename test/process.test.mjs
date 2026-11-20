import {test} from 'node:test';import assert from 'node:assert/strict';import{executeToFile}from'../packages/opencode-client/src/process.mjs';
test('多 MiB JSON 即使原生命令立即退出也完整读取，不被管道截断',async()=>{
 const r=await executeToFile(process.execPath,['-e',`process.stdout.write(JSON.stringify({text:'中文'.repeat(1024*1024)}));process.exit(0)`]);assert.equal(JSON.parse(r.stdout).text.length,2*1024*1024);
});
test('原生命令错误保留退出码与 stderr',async()=>{await assert.rejects(executeToFile(process.execPath,['-e',"process.stderr.write('native failure');process.exit(7)"]),e=>e.code===7&&e.stderr==='native failure');});
test('超时和输出上限生效',async()=>{
 await assert.rejects(executeToFile(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:30}),e=>e.code==='ETIMEDOUT');
 await assert.rejects(executeToFile(process.execPath,['-e',"process.stdout.write('a'.repeat(1024*1024))"],{maxBuffer:1024}),e=>e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});
