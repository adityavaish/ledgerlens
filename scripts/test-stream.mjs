import { CopilotClient } from '@github/copilot-sdk';

const c = new CopilotClient({ useLoggedInUser: true, logLevel: 'error' });
await c.start();
const s = await c.createSession({
  model: 'gpt-4o',
  systemMessage: { mode: 'replace', content: 'Respond with just: hello world' },
  onPermissionRequest: () => ({ kind: 'denied-by-rules' }),
});

console.log('Session type:', typeof s);
console.log('on type:', typeof s.on);
console.log('send type:', typeof s.send);

// Test sendAndWait (blocking - this should work)
console.log('\n--- Testing sendAndWait ---');
const t1 = Date.now();
const r1 = await s.sendAndWait({ prompt: 'hi' }, 30000);
const content = r1?.data?.content;
console.log(`sendAndWait result (${Date.now()-t1}ms):`, content ? content.slice(0, 100) : 'NO CONTENT');

// Test send() + on() events
console.log('\n--- Testing send() + on() ---');
let gotMessage = false;
s.on('content', (d) => {
  console.log('on(content):', JSON.stringify(d).slice(0, 100));
});
s.on('idle', () => {
  console.log('on(idle) fired');
  if (!gotMessage) console.log('WARNING: idle without message!');
  process.exit(0);
});
s.on('error', (e) => {
  console.log('on(error):', e);
  process.exit(1);
});

// Also try the internal event names
const origDispatch = s._dispatchEvent.bind(s);
s._dispatchEvent = (evt, data) => {
  const type = evt?.type ? evt.type : typeof evt;
  console.log(`_dispatch: ${type}`);
  origDispatch(evt, data);
};

s.send({ prompt: 'say bye' });
console.log('send() called');

setTimeout(() => {
  console.log('Timeout - exiting');
  process.exit(0);
}, 30000);
