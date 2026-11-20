import {writeFile, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
// Windows scanners/readers can temporarily deny replacement. Never delete the
// destination to work around it: exhaust bounded retries and preserve the old file.
export async function replaceFile(temp, file, { platform = process.platform, move = rename, wait = sleep } = {}) {
  for (let attempt = 0;;attempt++) {
    try { await move(temp,file); return; }
    catch(error) {
      if (platform !== 'win32' || !['EBUSY','EACCES','EPERM'].includes(error.code) || attempt >= 5) throw error;
      await wait(20 * 2 ** attempt);
    }
  }
}
export async function atomicWrite(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp,data,{mode:0o600,flag:'wx'});await replaceFile(temp,file); }
  finally { await unlink(temp).catch(()=>{}); }
}
