/**
 * 茶颜悦色 · 订单接收后端 (纯JS运行版)
 * 移除所有TS语法，适配Node.js + Render部署
 */
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import { createClient } from 'redis';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import * as useragent from 'express-useragent';
import crypto from 'crypto';

// 解决__dirname问题
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 初始化Express
const app = express();
const PORT = process.env.PORT || 3000; // 适配Render端口环境变量

// 中间件
app.use(cors());
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'chayan-yuese-secret-888'));
app.use(useragent.express()); // 设备指纹依赖

// Redis初始化
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.log('Redis 连接错误:', err));
redisClient.on('connect', () => console.log('✅ Redis 已连接'));
redisClient.connect().catch(console.error);

// 滑动窗口限流类（移除TS语法）
class SlidingWindowRateLimiter {
  constructor(client, windowSeconds = 60, maxRequests = 5) {
    this.redis = client;
    this.windowMs = windowSeconds * 1000;
    this.maxRequests = maxRequests;
  }

  async isAllowed(identifier, type) {
    const key = `rate_limit:${type}:${identifier}`;
    const currentTs = Date.now();
    const windowStartTs = currentTs - this.windowMs;

    try {
      const pipeline = this.redis.multi();
      pipeline.zRemRangeByScore(key, 0, windowStartTs);
      pipeline.zCard(key);
      pipeline.zAdd(key, [{ score: currentTs, value: currentTs.toString() }]);
      pipeline.expire(key, Math.floor(this.windowMs / 1000) + 10);
      
      const results = await pipeline.exec();
      const currentCount = results[1];

      if (currentCount >= this.maxRequests) {
        const earliest = await this.redis.zRangeWithScores(key, 0, 0);
        const earliestTs = earliest && earliest.length > 0 ? earliest[0].score : currentTs;
        const waitSeconds = ((earliestTs + this.windowMs - currentTs) / 1000).toFixed(1);
        return { allowed: false, remaining: 0, waitSeconds };
      } else {
        const remaining = this.maxRequests - currentCount - 1;
        return { allowed: true, remaining, waitSeconds: '0' };
      }
    } catch (err) {
      console.error(`Redis 限流器 [${type}] 出错 (降级放行):`, err);
      return { allowed: true, remaining: 1, waitSeconds: '0' };
    }
  }
}

// 限流实例
const combinedRateLimiter = new SlidingWindowRateLimiter(redisClient, 60, 5);
const phoneRateLimiter = new SlidingWindowRateLimiter(redisClient, 3600, 10);
const deviceRateLimiter = new SlidingWindowRateLimiter(redisClient, 86400, 20);

// 虚假手机号过滤
function isFakePhone(phone) {
  const testPhonePattern = /^1(38|39|40|41)0000\d{4}$/;
  const repeatNumPattern = /(\d)\1{8,}/;
  const orderNumPattern = /^1[3-9](012345678|876543210)\d$/;
  return testPhonePattern.test(phone) || repeatNumPattern.test(phone) || orderNumPattern.test(phone);
}

// 设备指纹生成
function getDeviceFingerprint(req) {
  const clientIp = getClientIp(req);
  const agent = req.useragent;
  const deviceInfo = [
    agent.browser, agent.version, agent.os, agent.device,
    req.headers['screen-resolution'] || 'unknown'
  ].join('-');
  const fingerprint = crypto.createHash('md5')
    .update(deviceInfo + clientIp + (process.env.COOKIE_SECRET || 'salt'))
    .digest('hex');
  return fingerprint;
}

// 获取真实IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  if (Array.isArray(forwarded)) return forwarded[0];
  return realIp || (forwarded ? forwarded.split(',')[0].trim() : req.ip) || 'unknown';
}

// SQLite数据库初始化
const db = new Database(path.join(__dirname, 'orders.db'));
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
try {
  db.exec("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  console.log('✅ 数据库字段迁移完成');
} catch(e) { /* 忽略已存在 */ }

// 订单提交接口
app.post('/api/submit-order', async (req, res) => {
  const clientIp = getClientIp(req);
  const { userPhone, orderId } = req.body;

  // 1. 虚假手机号过滤
  if (userPhone && isFakePhone(userPhone)) {
    return res.status(400).json({ code: 400, msg: '手机号无效，请填写真实手机号～' });
  }

  // 2. 设备指纹限流
  const deviceFingerprint = getDeviceFingerprint(req);
  const deviceResult = await deviceRateLimiter.isAllowed(deviceFingerprint, 'device');
  if (!deviceResult.allowed) {
    return res.status(429).json({ code: 429, msg: '当前设备点单次数过多，请24小时后重试～' });
  }

  // 3. 手机号限流
  if (userPhone) {
    const phoneResult = await phoneRateLimiter.isAllowed(`phone:${userPhone}`, 'phone');
    if (!phoneResult.allowed) {
      return res.status(429).json({ code: 429, msg: `该手机号点单太频繁，请等待 ${phoneResult.waitSeconds} 秒～` });
    }
  }

  // 4. 手机号+IP组合限流
  if (userPhone) {
    const combinedResult = await combinedRateLimiter.isAllowed(`phone:${userPhone}|ip:${clientIp}`, 'combined');
    if (!combinedResult.allowed) {
      return res.status(429).json({ code: 429, msg: `当前设备点单太频繁，请等待 ${combinedResult.waitSeconds} 秒～` });
    }
  }

  // 业务参数校验
  const { userName, deliveryType, deliveryAddress, remark, orderItems, totalPrice, createTime } = req.body;
  if (!orderId || !userPhone) return res.status(400).json({ code: 400, msg: '缺少orderId或userPhone' });
  if (!/^1[3-9]\d{9}$/.test(userPhone)) return res.status(400).json({ code: 400, msg: '手机号格式错误' });
  if (!Array.isArray(orderItems) || orderItems.length === 0) return res.status(400).json({ code: 400, msg: '订单商品不能为空' });

  // 重复订单校验
  const existing = db.prepare('SELECT id FROM orders WHERE order_id = ?').get(orderId);
  if (existing) return res.json({ code: 200, msg: '订单已接收（重复提交）', data: { orderId } });

  // 写入数据库
  try {
    const stmt = db.prepare(`
      INSERT INTO orders (order_id, user_name, user_phone, delivery_type, delivery_addr, remark, order_items, total_price, create_time)
      VALUES (@orderId, @userName, @userPhone, @deliveryType, @deliveryAddress, @remark, @orderItems, @totalPrice, @createTime)
    `);
    stmt.run({
      orderId, userName, userPhone, deliveryType,
      deliveryAddress: deliveryAddress || '',
      remark: remark || '',
      orderItems: JSON.stringify(orderItems),
      totalPrice: Number(totalPrice) || 0,
      createTime: createTime || new Date().toLocaleString('zh-CN')
    });
    console.log(`📦 订单入库：${orderId} | 手机号：${userPhone}`);
    return res.json({ code: 200, msg: '订单接收成功', data: { orderId } });
  } catch (err) {
    console.error('数据库写入失败：', err.message);
    return res.status(500).json({ code: 500, msg: '服务器内部错误，请稍后重试' });
  }
});

// 其他接口（订单状态/确认/列表）
app.get('/api/order-status/:orderId', (req, res) => {
  const row = db.prepare('SELECT order_id, status, total_price FROM orders WHERE order_id = ?').get(req.params.orderId);
  if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' });
  res.json({ code: 200, data: { orderId: row.order_id, status: row.status, totalPrice: row.total_price } });
});

app.post('/api/confirm-order', (req, res) => {
  const ADMIN_PWD = process.env.ADMIN_PASSWORD || '123456789';
  if (req.headers['x-admin-password'] !== ADMIN_PWD) return res.status(401).json({ code: 401, msg: '无权限' });
  const result = db.prepare("UPDATE orders SET status = 'confirmed' WHERE order_id = ?").run(req.body.orderId);
  if (result.changes === 0) return res.status(404).json({ code: 404, msg: '订单不存在' });
  res.json({ code: 200, msg: '订单已确认', data: { orderId: req.body.orderId } });
});

app.get('/api/orders', (req, res) => {
  const ADMIN_PWD = process.env.ADMIN_PASSWORD || '123456789';
  if (req.headers['x-admin-password'] !== ADMIN_PWD) return res.status(401).json({ code: 401, msg: '暗号错误' });
  const rows = db.prepare('SELECT * FROM orders ORDER BY received_at DESC').all();
  const result = rows.map(r => ({ ...r, order_items: JSON.parse(r.order_items || '[]') }));
  res.json({ code: 200, data: result, total: result.length });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 启动服务（必须监听0.0.0.0和PORT）
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务启动成功：http://0.0.0.0:${PORT}`);
  console.log(`✅ 环境变量PORT：${process.env.PORT}`);
});