/**
 * 茶颜悦色 · 订单接收后端
 * 技术栈：Node.js + Express + better-sqlite3
 * 启动：node server.js
 */

const express  = require('express');
const cors     = require('cors');
const Database = require('better-sqlite3');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
   数据库初始化
   文件 orders.db 会自动在同目录生成
============================================================ */
const db = new Database(path.join(__dirname, 'orders.db'));

// 建表（如果不存在）
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT    NOT NULL UNIQUE,   -- 前端生成的唯一订单号，防重复
    user_name    TEXT    NOT NULL,
    user_phone   TEXT    NOT NULL,
    delivery_type TEXT   NOT NULL,          -- 'pickup' | 'delivery'
    delivery_addr TEXT   DEFAULT '',
    remark       TEXT    DEFAULT '',
    order_items  TEXT    NOT NULL,          -- JSON 字符串
    total_price  REAL    NOT NULL,
    create_time  TEXT    NOT NULL,
    received_at  DATETIME DEFAULT (datetime('now','localtime'))
  )
`);

console.log('✅ SQLite 数据库已就绪');

/* ============================================================
   中间件
============================================================ */

// CORS：允许 GitHub Pages 前端跨域请求
app.use(cors());

// 解析 JSON 请求体
app.use(express.json());

/* ============================================================
   接口：POST /api/submit-order
   接收前端订单，写入 SQLite
============================================================ */
app.post('/api/submit-order', (req, res) => {
  const {
    orderId,
    userName,
    userPhone,
    deliveryType,
    deliveryAddress,
    remark,
    orderItems,
    totalPrice,
    createTime
  } = req.body;

  // ── 基础参数校验 ──
  if (!orderId || !userPhone) {
    return res.status(400).json({ code: 400, msg: '参数错误：缺少 orderId 或 userPhone' });
  }
  if (!/^1[3-9]\d{9}$/.test(userPhone)) {
    return res.status(400).json({ code: 400, msg: '手机号格式错误' });
  }
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    return res.status(400).json({ code: 400, msg: '订单商品不能为空' });
  }

  // ── 防重复写入（orderId 唯一） ──
  const existing = db.prepare('SELECT id FROM orders WHERE order_id = ?').get(orderId);
  if (existing) {
    // 订单已存在，视为成功（幂等处理）
    return res.json({ code: 200, msg: '订单已接收（重复提交）', data: { orderId } });
  }

  // ── 写入数据库 ──
  try {
    const stmt = db.prepare(`
      INSERT INTO orders
        (order_id, user_name, user_phone, delivery_type, delivery_addr,
         remark, order_items, total_price, create_time)
      VALUES
        (@orderId, @userName, @userPhone, @deliveryType, @deliveryAddress,
         @remark, @orderItems, @totalPrice, @createTime)
    `);

    stmt.run({
      orderId,
      userName,
      userPhone,
      deliveryType,
      deliveryAddress: deliveryAddress || '',
      remark: remark || '',
      orderItems: JSON.stringify(orderItems),
      totalPrice: Number(totalPrice) || 0,
      createTime: createTime || new Date().toLocaleString('zh-CN')
    });

    console.log(`📦 新订单已入库：${orderId}  手机：${userPhone}  金额：¥${totalPrice}`);

    return res.json({
      code: 200,
      msg: '订单接收成功',
      data: { orderId }
    });

  } catch (err) {
    console.error('数据库写入失败：', err.message);
    return res.status(500).json({ code: 500, msg: '服务器内部错误，请稍后重试' });
  }
});

/* ============================================================
   接口：GET /api/orders
   查看所有订单（本地调试用，生产环境建议加鉴权或删除）
============================================================ */
app.get('/api/orders', (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY received_at DESC').all();
  // 把 order_items 字符串还原为对象
  const result = rows.map(r => ({
    ...r,
    order_items: JSON.parse(r.order_items || '[]')
  }));
  res.json({ code: 200, data: result, total: result.length });
});

/* ============================================================
   健康检查
============================================================ */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/* ============================================================
   启动服务
============================================================ */
app.listen(PORT, () => {
  console.log(`🚀 茶颜悦色订单服务启动成功：http://localhost:${PORT}`);
  console.log(`   查看所有订单：http://localhost:${PORT}/api/orders`);
});
