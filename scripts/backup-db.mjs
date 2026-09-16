#!/usr/bin/env node
/**
 * 在容器内为 SQLite 生成一致快照（供宿主机备份脚本调用）。
 *
 * 为什么不能直接拷 proxy.db：
 *   数据库运行在 WAL 模式下，写入先落 proxy.db-wal。直接复制 proxy.db 会得到
 *   一个缺少最新提交、甚至页级不一致的库。`VACUUM INTO` 由 SQLite 自己把当前
 *   已提交状态写成一个全新的、页一致的库文件，在线执行也安全。
 *
 * 用法：node backup-db.mjs [源库] [输出快照]
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const src = process.argv[2] || process.env.UNION_DB_FILE || '/data/proxy.db';
const out = process.argv[3] || '/tmp/proxy-snapshot.db';

if (!fs.existsSync(src)) {
  console.error('数据库不存在: ' + src);
  process.exit(1);
}

try { fs.rmSync(out, { force: true }); } catch { /* 旧的快照删不掉也不影响 VACUUM INTO 覆盖 */ }

const db = new DatabaseSync(src);
try {
  // SQLite 要求字面量，这里对单引号做转义
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const st = fs.statSync(out);
console.log(`快照已生成: ${out} (${(st.size / 1024).toFixed(1)} KB)`);
