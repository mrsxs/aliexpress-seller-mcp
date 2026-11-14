// ziniao-cli 封装：列店铺、打开店铺、获取店铺当前页面的 targetId
import { execFile } from 'node:child_process';

const CLI = process.env.ZINIAO_CLI || 'ziniao-cli';

function runCli(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    // Windows 上 npm 全局命令是 ziniao-cli.cmd，必须经 shell 执行（参数都是程序生成的数字/固定值，无注入风险）
    const opts = { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' };
    execFile(CLI, args, opts, (err, stdout, stderr) => {
      const text = String(stdout || '');
      const jsonStart = text.indexOf('{');
      if (jsonStart < 0) {
        const reason = String(stderr || '').trim() || err?.message || '无输出';
        return reject(new Error(`ziniao-cli ${args.slice(0, 2).join(' ')} 失败: ${reason}`));
      }
      let json;
      try {
        json = JSON.parse(text.slice(jsonStart));
      } catch {
        return reject(new Error(`ziniao-cli ${args.slice(0, 2).join(' ')} 输出无法解析`));
      }
      if (json.ok === false) {
        return reject(new Error(`ziniao-cli ${args.slice(0, 2).join(' ')}: ${json.error?.message || '调用失败'}`));
      }
      resolve(json);
    });
  });
}

export function assertStoreId(storeId) {
  if (!/^\d{5,24}$/.test(String(storeId || ''))) throw new Error('店铺 ID 格式不正确');
  return String(storeId);
}

export async function listStores() {
  const json = await runCli(['store', 'list', '--all']);
  // 带 --all 时结果包在 data 里，不带时在顶层
  const items = json.data?.items || json.items || [];
  return items.map((s) => ({
    storeId: String(s.storeId),
    storeName: s.storeName,
    platformName: s.platformName,
    ip: s.ip,
  }));
}

export async function openStore(storeId) {
  const json = await runCli(['store', 'open', '--id', assertStoreId(storeId)], 240_000);
  return json.data;
}

/** 通过 page exec 拿到店铺浏览器里 CLI 默认页面的 targetId，用来匹配调试端口 */
export async function getStoreTargetId(storeId) {
  const json = await runCli(['page', 'exec', '--store-id', assertStoreId(storeId), '--script', '1'], 30_000);
  const targetId = json?.data?.data?.targetId;
  if (!targetId) throw new Error('未获取到店铺页面 targetId');
  return targetId;
}
