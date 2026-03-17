/**
 * db/init.js
 * 数据库初始化：自动创建 orders 和 order_items 两张表
 * 使用 better-sqlite3（同步 API，轻量，无需额外配置）
 */

const Database = require('better-sqlite3');
const path     = require('path');

// 数据库文件存放在 db/ 目录下
const DB_PATH = path.join(__dirname, 'orders.db');

/**
 * 初始化数据库，返回 db 实例供 server.js 复用
 */
function initDB() {
  const db = new Database(DB_PATH);

  // 开启 WAL 模式，提升并发写入性能
  db.pragma('journal_mode = WAL');

  // 订单主表
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         TEXT    NOT NULL UNIQUE,   -- 前端生成的唯一订单号，防重复
      user_name        TEXT    NOT NULL,
      user_phone       TEXT    NOT NULL,
      delivery_type    TEXT    NOT NULL DEFAULT 'pickup',  -- pickup / delivery
      delivery_address TEXT,
      remark           TEXT,
      total_price      REAL    NOT NULL DEFAULT 0,
      create_time      TEXT    NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP  -- 服务器入库时间
    );
  `);

  // 订单商品明细表
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   TEXT    NOT NULL,           -- 关联 orders.order_id
      item_id    INTEGER NOT NULL,
      item_name  TEXT    NOT NULL,
      item_price REAL    NOT NULL,
      quantity   INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );
  `);

  console.log(`📦 数据库初始化完成：${DB_PATH}`);
  return db;
}

module.exports = initDB;
