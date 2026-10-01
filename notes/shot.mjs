// 临时 CDP 截图脚本：正常视口加载，滚到指定锚点，等 reveal 触发后截图。
// 用法：node shot.mjs <url> <selector> <out.png> <width> <height> [scrollAdjust]
const [url, selector, out, w, h, adjust] = process.argv.slice(2);

const res = await fetch('http://localhost:9222/json/new?' + encodeURIComponent('about:blank'), {
  method: 'PUT',
});
const t = await res.json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};

await new Promise((r) => (ws.onopen = r));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 1800));
await send('Runtime.evaluate', {
  expression: `var el = document.querySelector(${JSON.stringify(selector)});
    var y = el.getBoundingClientRect().top + window.scrollY + (${Number(adjust) || 0});
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });`,
});
await new Promise((r) => setTimeout(r, 1600));
const shot = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
await send('Target.closeTarget' in {} ? 'Page.close' : 'Page.close');
ws.close();
console.log('saved', out);
process.exit(0);
