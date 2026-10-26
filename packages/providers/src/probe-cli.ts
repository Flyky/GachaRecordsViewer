import { randomUUID } from 'node:crypto';
import { mkdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { MiyousheClient } from './miyoushe/client.js';
import { ProbeError } from './miyoushe/errors.js';
import { runProbe } from './miyoushe/probe.js';

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      help: { type: 'boolean', short: 'h' },
      uid: { type: 'string' },
      region: { type: 'string' },
      pool: { type: 'string', default: '301' },
      pages: { type: 'string', default: '2' },
      'wait-seconds': { type: 'string', default: '180' },
    }, allowPositionals: false }));
  } catch {
    throw new ProbeError('protocol', 'options');
  }
  if (values.help) {
    console.log('米游社国服原神只读探针（不保存 Token，不写入抽卡数据库）');
    console.log('pnpm probe:miyoushe [--uid 游戏UID] [--region cn_gf01|cn_qd01] [--pool 301] [--pages 1|2] [--wait-seconds 180]');
    console.log('默认角色池最多两页，每页 5 条。可用 --region 限定服务器；仍有多个档案时需提供 --uid。');
    return;
  }

  if (values.region !== undefined && values.region !== 'cn_gf01' && values.region !== 'cn_qd01') {
    throw new ProbeError('protocol', 'options');
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const directory = fileURLToPath(new URL(`../../../.probe/${randomUUID()}/`, import.meta.url));
  const qrFile = join(directory, 'qr.png');
  try {
    const summary = await runProbe(new MiyousheClient({ signal: controller.signal }), {
      ...(values.uid === undefined ? {} : { uid: values.uid }),
      ...(values.region === undefined ? {} : { region: values.region }),
      pool: values.pool,
      pages: Number(values.pages),
      maxWaitMs: Number(values['wait-seconds']) * 1000,
      signal: controller.signal,
      onQr: async (ticket) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await QRCode.toFile(qrFile, ticket.url, { width: 360, margin: 3, errorCorrectionLevel: 'M' });
        console.log(JSON.stringify({ stage: 'qr_ready', file: qrFile, expiresAt: new Date(ticket.expiresAt).toISOString() }));
        console.log('请在有效期内使用本人官方米游社 App 扫码确认。Ctrl+C 取消；二维码结束后删除。');
      },
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(summary));
  } finally {
    controller.abort();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await unlink(qrFile).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify(error instanceof ProbeError ? error.toJSON() : { code: 'local_error', stage: 'probe' }));
  process.exitCode = error instanceof ProbeError && error.code === 'cancelled' ? 130 : 1;
}
