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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      TEXT    NOT NULL UNIQUE,
    user_name     TEXT    NOT NULL,
    user_phone    TEXT    NOT NULL,
    delivery_type TEXT    NOT NULL,
    delivery_addr TEXT    DEFAULT '',
    remark        TEXT    DEFAULT '',
    order_items   TEXT    NOT NULL,
    total_price   REAL    NOT NULL,
    create_time   TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    received_at   DATETIME DEFAULT (datetime('now','localtime'))
  )
`);

// 兼容旧数据库：status 列不存在时自动添加
try {
  db.exec("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  console.log('✅ 已自动迁移：添加 status 字段');
} catch(e) { /* 列已存在，忽略 */ }

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
   接口：GET /api/order-status/:orderId
   前端轮询用：查询单个订单的状态（无需密码，仅返回状态）
============================================================ */
app.get('/api/order-status/:orderId', (req, res) => {
  const { orderId } = req.params;
  if (!orderId) return res.status(400).json({ code: 400, msg: '缺少 orderId' });

  try {
    const row = db.prepare(
      'SELECT order_id, status, total_price FROM orders WHERE order_id = ?'
    ).get(orderId);

    if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' });

    res.json({ code: 200, data: { orderId: row.order_id, status: row.status, totalPrice: row.total_price } });
  } catch(err) {
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

/* ============================================================
   接口：POST /api/confirm-order
   后台老板确认订单，将状态改为 confirmed
   需要管理密码
============================================================ */
app.post('/api/confirm-order', (req, res) => {
  const ADMIN_PASSWORD = '123456789';
  const clientPassword = req.headers['x-admin-password'];
  if (clientPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ code: 401, msg: '无权限' });
  }

  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ code: 400, msg: '缺少 orderId' });

  try {
    const result = db.prepare(
      "UPDATE orders SET status = 'confirmed' WHERE order_id = ?"
    ).run(orderId);

    if (result.changes === 0) return res.status(404).json({ code: 404, msg: '订单不存在' });

    console.log(`✅ 订单已确认：${orderId}`);
    res.json({ code: 200, msg: '订单已确认', data: { orderId } });
  } catch(err) {
    res.status(500).json({ code: 500, msg: '操作失败' });
  }
});

/* ============================================================
   接口：GET /api/orders
   【已加锁】需要提供正确的 x-admin-password 暗号才能查看
=========================================================== */
app.get('/api/orders', (req, res) => {
  // 1. 设置你的管理密码（你可以把 'admin123' 换成你喜欢的）
  const ADMIN_PASSWORD = '123456789'; 

  // 2. 从请求头里读取暗号
  const clientPassword = req.headers['x-admin-password'];

  // 3. 校验暗号
  if (clientPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ code: 401, msg: '暗号错误，拒绝进入！' });
  }

  // 4. 暗号正确，执行查询逻辑
  try {
    const rows = db.prepare('SELECT * FROM orders ORDER BY received_at DESC').all();
    const result = rows.map(r => ({
      ...r,
      order_items: JSON.parse(r.order_items || '[]')
    }));
    res.json({ code: 200, data: result, total: result.length });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '数据库查询失败' });
  }
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
