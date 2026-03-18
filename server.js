/**
 * 茶颜悦色 · 订单接收后端 (安全增强版 - 纯JS版本)
 * 移除所有TypeScript语法，适配Node.js运行
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000; // 适配Render的端口环境变量

app.use(useragent.express());

// Cookie 签名密钥
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'chayan-yuese-secret-888';

/* ============================================================
   Redis 初始化 & 限流器配置 (移除TS的private/类型注解)
============================================================ */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.log('Redis 连接错误:', err));
redisClient.on('connect', () => console.log('✅ Redis 数据库已连接'));
redisClient.connect().catch(console.error);

// 滑动窗口限流核心类 (移除TS语法)
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

// 虚假手机号过滤函数 (移除TS类型注解)
function isFakePhone(phone) {
  const testPhonePattern = /^1(38|39|40|41)0000\d{4}$/;
  const repeatNumPattern = /(\d)\1{8,}/;
  const orderNumPattern = /^1[3-9](012345678|876543210)\d$/;
  
  return testPhonePattern.test(phone) || repeatNumPattern.test(phone) || orderNumPattern.test(phone);
}

// 设备指纹生成函数 (移除TS类型注解)
function getDeviceFingerprint(req) {
  const clientIp = getClientIp(req);
  const agent = req.useragent;
  const deviceInfo = [
    agent.browser,
    agent.version,
    agent.os,
    agent.device,
    req.headers['screen-resolution'] || 'unknown'
  ].join('-');
  const fingerprint = crypto.createHash('md5')
    .update(deviceInfo + clientIp + COOKIE_SECRET)
    .digest('hex');
  return fingerprint;
}

// 获取真实IP (移除TS类型注解)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  if (Array.isArray(forwarded)) return forwarded[0];
  return realIp || (forwarded ? forwarded.split(',')[0].trim() : req.ip) || 'unknown';
}

/* ============================================================
   数据库初始化
============================================================ */
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
  console.log('✅ 已自动迁移：添加 status 字段');
} catch(e) { /* 忽略已存在的错误 */ }

console.log('✅ SQLite 数据库已就绪');

/* ============================================================
   中间件
============================================================ */
app.use(cors());
app.use(express.json());
app.use(cookieParser(COOKIE_SECRET)); // 补上之前遗漏的cookie解析中间件

/* ============================================================
   接口：POST /api/submit-order
============================================================ */
app.post('/api/submit-order', async (req, res) => {
  const clientIp = getClientIp(req);
  const { userPhone, orderId } = req.body;

  // 第一层：虚假手机号过滤
  if (userPhone && isFakePhone(userPhone)) {
    console.log(`🛑 拦截虚假手机号: ${userPhone}`);
    return res.status(400).json({ 
      code: 400, 
      msg: '手机号无效，请填写真实可用的手机号～' 
    });
  }

  // 第二层：设备指纹限流
  const deviceFingerprint = getDeviceFingerprint(req);
  const deviceResult = await deviceRateLimiter.isAllowed(deviceFingerprint, 'device_fingerprint');
  if (!deviceResult.allowed) {
    console.log(`🛑 设备指纹限流拦截: ${deviceFingerprint} (IP: ${clientIp})`);
    return res.status(429).json({ 
      code: 429, 
      msg: `当前设备点单次数过多，请24小时后重试～` 
    });
  }

  // 第三层：手机号维度限流
  if (userPhone) {
    const phoneResult = await phoneRateLimiter.isAllowed(`phone:${userPhone}`, 'phone');
    if (!phoneResult.allowed) {
      console.log(`🛑 手机号限流拦截: ${userPhone}`);
      return res.status(429).json({ 
        code: 429, 
        msg: `该手机号点单太频繁啦！请等待 ${phoneResult.waitSeconds} 秒后重试～` 
      });
    }
  }

  // 第四层：手机号+IP组合维度限流
  if (userPhone) {
    const combinedResult = await combinedRateLimiter.isAllowed(`phone:${userPhone}|ip:${clientIp}`, 'combined');
    if (!combinedResult.allowed) {
      console.log(`🛑 组合限流拦截: ${userPhone} | IP: ${clientIp}`);
      return res.status(429).json({ 
        code: 429, 
        msg: `当前设备点单太频繁啦！请等待 ${combinedResult.waitSeconds} 秒后重试～` 
      });
    }
  }

  // 业务逻辑
  const {
    userName,
    deliveryType,
    deliveryAddress,
    remark,
    orderItems,
    totalPrice,
    createTime
  } = req.body;

  if (!orderId || !userPhone) {
    return res.status(400).json({ code: 400, msg: '参数错误：缺少 orderId 或 userPhone' });
  }
  if (!/^1[3-9]\d{9}$/.test(userPhone)) {
    return res.status(400).json({ code: 400, msg: '手机号格式错误' });
  }
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    return res.status(400).json({ code: 400, msg: '订单商品不能为空' });
  }

  const existing = db.prepare('SELECT id FROM orders WHERE order_id = ?').get(orderId);
  if (existing) {
    return res.json({ code: 200, msg: '订单已接收（重复提交）', data: { orderId } });
  }

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

    console.log(`📦 新订单入库：${orderId} 手机：${userPhone} 金额：¥${totalPrice}`);

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
   其他接口 (保持原样，移除TS类型注解)
============================================================ */
app.get('/api/order-status/:orderId', (req, res) => {
  const { orderId } = req.params;
  try {
    const row = db.prepare('SELECT order_id, status, total_price FROM orders WHERE order_id = ?').get(orderId);
    if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' });
    res.json({ code: 200, data: { orderId: row.order_id, status: row.status, totalPrice: row.total_price } });
  } catch(err) {
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

app.post('/api/confirm-order', (req, res) => {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456789'; // 改为环境变量更安全
  const clientPassword = req.headers['x-admin-password'];
  if (clientPassword !== ADMIN_PASSWORD) return res.status(401).json({ code: 401, msg: '无权限' });
  const { orderId } = req.body;
  try {
    const result = db.prepare("UPDATE orders SET status = 'confirmed' WHERE order_id = ?").run(orderId);
    if (result.changes === 0) return res.status(404).json({ code: 404, msg: '订单不存在' });
    res.json({ code: 200, msg: '订单已确认', data: { orderId } });
  } catch(err) {
    res.status(500).json({ code: 500, msg: '操作失败' });
  }
});

app.get('/api/orders', (req, res) => {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456789';
  const clientPassword = req.headers['x-admin-password'];
  if (clientPassword !== ADMIN_PASSWORD) return res.status(401).json({ code: 401, msg: '暗号错误' });
  try {
    const rows = db.prepare('SELECT * FROM orders ORDER BY received_at DESC').all();
    const result = rows.map(r => ({ ...r, order_items: JSON.parse(r.order_items || '[]') }));
    res.json({ code: 200, data: result, total: result.length });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 绑定端口（适配Render，必须监听0.0.0.0和环境变量端口）
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 茶颜悦色订单服务启动成功：http://0.0.0.0:${PORT}`);
});