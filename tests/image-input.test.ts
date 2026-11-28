/**
 * ── 聊天图片输入 的测试 ──
 *
 * 图片这一层最容易出的问题不是"显示不出来"，而是**悄悄发错**：
 *  · 图片只进了界面、没进请求体 → 模型答非所问，用户以为它"看不懂图"；
 *  · 图片被塞进 assistant/tool 消息 → OpenAI 兼容网关直接 400；
 *  · 历史每轮重发旧图 → 视觉 token 随轮数叠加，几轮就超窗口；
 *  · 没有文字时拼出空 content → 端点报"content 不能为空"。
 *
 * 运行：npx tsx tests/image-input.test.ts
 */
import assert from 'node:assert/strict';
import {
  CHAT_IMAGE_MAX_COUNT,
  buildUserContent,
  imagePlaceholder,
  imagesOf,
  type ChatImage,
} from '../src/lib/ai/image-input';
import { IMAGE_TOKEN_ESTIMATE, estimateRequestTokens } from '../src/lib/ai/agent';
import { dataUrlByteLength, fitWithin } from '../src/lib/ui/image-upload';

let passed = 0;
function ok(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}`);
    throw e;
  }
}

const img = (id: string, name = `${id}.png`): ChatImage => ({
  id,
  dataUrl: 'data:image/webp;base64,AAAA',
  name,
  width: 800,
  height: 600,
});

console.log('\n[P1] 内容拼装');

ok('没有图片时保持纯字符串（兼容旧端点与旧调用方）', () => {
  assert.equal(buildUserContent('你好'), '你好');
  assert.equal(buildUserContent('你好', []), '你好');
});

ok('有图片时是数组，文本在前、图片在后', () => {
  const content = buildUserContent('看看这张图', [img('a'), img('b')]);
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: 'text', text: '看看这张图' });
  assert.equal(content[1]!.type, 'image_url');
  assert.equal(content[2]!.type, 'image_url');
  for (const part of content.slice(1)) {
    assert.ok(part.type === 'image_url' && part.image_url.url.startsWith('data:image/'));
    assert.equal(part.type === 'image_url' ? part.image_url.detail : '', 'auto');
  }
});

ok('只有图片没有文字时补一句明确任务，不产出空 content', () => {
  const content = buildUserContent('', [img('a')]);
  assert.ok(Array.isArray(content));
  assert.equal(content[0]!.type, 'text');
  assert.ok(content[0]!.type === 'text' && content[0]!.text.trim().length > 0);
  assert.equal(content.filter((p) => p.type === 'text').length, 1);
});

ok(`一轮最多 ${CHAT_IMAGE_MAX_COUNT} 张（常量被 UI 与提示共用）`, () => {
  assert.equal(CHAT_IMAGE_MAX_COUNT, 3);
});

console.log('\n[P2] 历史与重试');

ok('历史占位只保留文件名，不带 data URL', () => {
  const note = imagePlaceholder([img('a', '截图 1.png'), img('b', '截图 2.png')]);
  assert.match(note, /截图 1\.png/);
  assert.match(note, /截图 2\.png/);
  assert.doesNotMatch(note, /data:image/);
});

ok('imagesOf 容忍旧数据（缺失 / 半截对象 / 空 url）', () => {
  assert.deepEqual(imagesOf({}), []);
  assert.deepEqual(imagesOf({ images: [] }), []);
  assert.deepEqual(
    imagesOf({ images: [img('ok'), { id: 'bad', dataUrl: '' } as ChatImage] }).map((i) => i.id),
    ['ok'],
  );
});

console.log('\n[P3] token 估算');

ok('图片按固定值计入，不按 base64 长度（否则一张图就撑爆预算）', () => {
  const huge = { ...img('a'), dataUrl: `data:image/webp;base64,${'A'.repeat(200_000)}` };
  const withImage = estimateRequestTokens([
    { role: 'system', content: 'sys' },
    { role: 'user', content: buildUserContent('看图', [huge]) },
  ]);
  const textOnly = estimateRequestTokens([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '看图' },
  ]);
  const delta = withImage - textOnly;
  assert.ok(delta >= IMAGE_TOKEN_ESTIMATE, `差值 ${delta} 应至少包含一次图片估值`);
  // 若按字符串长度估算，这个差值会是 5 万+；断言它远低于此
  assert.ok(delta < IMAGE_TOKEN_ESTIMATE + 100, `差值 ${delta} 不应随 base64 长度膨胀`);
});

ok('多张图片按张数线性计入', () => {
  const one = estimateRequestTokens([{ role: 'user', content: buildUserContent('x', [img('a')]) }]);
  const three = estimateRequestTokens([
    { role: 'user', content: buildUserContent('x', [img('a'), img('b'), img('c')]) },
  ]);
  assert.ok(three - one >= IMAGE_TOKEN_ESTIMATE * 2 - 50);
});

console.log('\n[P4] 压缩辅助');

ok('fitWithin 等比缩到长边内，不放大', () => {
  assert.deepEqual(fitWithin(2048, 1024, 1024), { width: 1024, height: 512 });
  assert.deepEqual(fitWithin(500, 300, 1024), { width: 500, height: 300 });
  assert.deepEqual(fitWithin(0, 0, 1024), { width: 1, height: 1 });
});

ok('dataUrlByteLength 按 base64 实际字节算（含填充）', () => {
  assert.equal(dataUrlByteLength('data:image/png;base64,AAAA'), 3);
  assert.equal(dataUrlByteLength('data:image/png;base64,AAA='), 2);
  assert.equal(dataUrlByteLength('data:image/png;base64,AA=='), 1);
  assert.equal(dataUrlByteLength('not-a-data-url'), 0);
});

console.log(`\n✓ image-input 测试通过：${passed} 项`);
