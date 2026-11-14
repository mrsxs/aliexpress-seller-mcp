// MCP 的图片输入：本地文件路径、http(s) 链接或 data URL，统一转成速卖通上传要的 data URL。
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

/** 边读边累计大小，超过上限立刻取消下载（不把大文件整个读进内存） */
async function readLimited(res, max) {
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new ImageInputError(`图片太大（超过 ${Math.round(max / 1024 / 1024)}MB）。`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ImageInputError(`图片太大（超过 ${Math.round(max / 1024 / 1024)}MB）。`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.bmp': 'bmp', '.gif': 'gif' };
export const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|bmp|gif);base64,[A-Za-z0-9+/=]+$/;

export class ImageInputError extends Error {}

const toDataUrl = (type, buf) => `data:image/${type};base64,${buf.toString('base64')}`;

function checkSize(bytes) {
  if (bytes > MAX_IMAGE_BYTES) throw new ImageInputError(`图片太大（${Math.round(bytes / 1024 / 1024)}MB），上限 10MB。`);
}

export async function loadImage(input, { fetchImpl = fetch } = {}) {
  const value = String(input ?? '').trim();
  if (!value) throw new ImageInputError('请提供图片：本地文件路径、http(s) 链接或 data URL。');
  if (value.startsWith('data:')) {
    if (!IMAGE_DATA_URL.test(value)) throw new ImageInputError('data URL 格式不支持（支持 jpg/png/webp/bmp/gif 的 base64）。');
    checkSize(Math.floor((value.length - value.indexOf(',') - 1) * 0.75));
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    const res = await fetchImpl(value, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new ImageInputError(`图片下载失败（HTTP ${res.status}）。`);
    const type = (res.headers.get('content-type') || '').match(/^image\/(png|jpe?g|webp|bmp|gif)/i)?.[1]?.toLowerCase();
    if (!type) throw new ImageInputError(`链接不是支持的图片类型（${res.headers.get('content-type') || '未知'}）。`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0) {
      try {
        checkSize(declared);
      } catch (err) {
        await res.body?.cancel?.().catch(() => {});
        throw err;
      }
    }
    const buf = await readLimited(res, MAX_IMAGE_BYTES);
    return toDataUrl(type === 'jpg' ? 'jpeg' : type, buf);
  }
  if (!isAbsolute(value)) throw new ImageInputError('本地图片要用绝对路径。');
  const type = MIME[extname(value).toLowerCase()];
  if (!type) throw new ImageInputError('只支持 jpg/png/webp/bmp/gif 图片。');
  let info;
  try {
    info = await stat(value);
  } catch {
    throw new ImageInputError(`找不到图片文件：${value}`);
  }
  if (!info.isFile()) throw new ImageInputError(`不是文件：${value}`);
  checkSize(info.size);
  return toDataUrl(type, await readFile(value));
}
