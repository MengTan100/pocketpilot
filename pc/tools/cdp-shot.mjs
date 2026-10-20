// 用 CDP 抓页面截图并回报视口信息，便于把"屏幕像素"换算成 CSS 坐标
import fs from 'node:fs';

const [, , wsUrl, outPath] = process.argv;
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
ws.addEventListener('open', async () => {
  const info = await send('Runtime.evaluate', {
    expression: `JSON.stringify({innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio, vvW: visualViewport.width, vvH: visualViewport.height, vvTop: visualViewport.offsetTop, scrollY: scrollY})`,
    returnByValue: true,
  });
  console.log('视口:', info.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', outPath);
  ws.close();
  process.exit(0);
});
ws.addEventListener('error', (e) => { console.error(e.message); process.exit(1); });
