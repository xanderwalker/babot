import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupUsbLease } from '../src/setup-usb-lease.mjs';
import { ConnectionManager, BABOT_CONNECTION_LOCK } from '../src/connection-manager.mjs';
const flush = async () => { for(let i=0;i<15;i++) await Promise.resolve(); };
function locks() {
  const held = new Set();
  return { held, async request(name, options, callback) {
    assert.equal(name, BABOT_CONNECTION_LOCK);
    assert.deepEqual(options, {mode:'exclusive',ifAvailable:true});
    if(held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({name}); } finally { held.delete(name); }
  } };
}

test('installer and replay cannot own USB together, including while cleanup is pending', async () => {
  const shared=locks(); const lease=new SetupUsbLease(shared);
  let reconnects=0;
  const replay=new ConnectionManager({reconnect:async()=>{reconnects++;return true;},disconnect:async()=>{},connect:async()=>true},{locks:shared,isVisible:()=>true});
  assert.equal(await lease.acquire(),true);
  assert.equal(await replay.start(),false);
  assert.equal(reconnects,0);
  let close; const closing=lease.close(()=>new Promise(resolve=>{close=resolve;}));
  assert.equal(await replay.connect(),false);
  close(); await closing; await flush();
  assert.equal(await replay.start(),true);
  assert.equal(reconnects,1);
  await replay.dispose();
});

test('failed installer cleanup retains lease until actual closure succeeds', async()=>{
  const shared=locks(), first=new SetupUsbLease(shared), second=new SetupUsbLease(shared);
  await first.acquire();
  await assert.rejects(first.close(async()=>{throw new Error('port busy');}),/port busy/);
  assert.equal(await second.acquire(),false);
  await assert.rejects(first.close(async()=>({closed:false})),/not confirmed/);
  assert.equal(await second.acquire(),false);
  await first.close(async()=>{});await flush();
  assert.equal(await second.acquire(),true);
  await second.dispose(async()=>{});
});

test('a StrictMode-disposed installer cannot acquire a stale queued lease',async()=>{
  const shared=locks(); const old=new SetupUsbLease(shared);
  const acquire=old.acquire(); await old.dispose(async()=>{});
  assert.equal(await acquire,false);
  const current=new SetupUsbLease(shared);
  assert.equal(await current.acquire(),true);
  await current.dispose(async()=>{});
  assert.equal(await current.acquire(),false);
});
