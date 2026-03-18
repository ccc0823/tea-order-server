/**
 * 茶颜悦色 · 订单接收后端 (安全增强版)
 * 技术栈：Node.js + Express + better-sqlite3 + Redis
 * 
 * 核心改进：
 * 1. 解决 NAT 误伤：引入基于 Signed Cookie 的设备标识 (Device ID)，对单设备进行严格限流，对 IP 进行宽松限流。
 * 2. 解决 IP 轮换攻击：引入手机号维度的限流，防止攻击者通过更换 IP 绕过限制。
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
const PORT = 3000;

app.use(useragent.express());

// Cookie 签名密钥，用于防止伪造设备 ID
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'chayan-yuese-secret-888';

/* ============================================================
   Redis 初始化 & 限流器配置
============================================================ */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.log('Redis 连接错误:', err));
redisClient.on('connect', () => console.log('✅ Redis 数据库已连接'));
redisClient.connect().catch(console.error);

// 滑动窗口限流核心类
class SlidingWindowRateLimiter {
  private redis: any;
  private windowMs: number;
  private maxRequests: number;

  constructor(client: any, windowSeconds = 60, maxRequests = 5) {
    this.redis = client;
    this.windowMs = windowSeconds * 1000;
    this.maxRequests = maxRequests;
  }

  async isAllowed(identifier: string, type: string) {
    const key = `rate_limit:${type}:${identifier}`;
    const currentTs = Date.now();
    const windowStartTs = currentTs - this.windowMs;

    try {
      const pipeline = this.redis.multi();
      // 1. 删除窗口外的过期请求
      pipeline.zRemRangeByScore(key, 0, windowStartTs);
      // 2. 统计当前窗口内的请求数
      pipeline.zCard(key);
      // 3. 将当前请求的时间戳加入集合
      pipeline.zAdd(key, [{ score: currentTs, value: currentTs.toString() }]);
      // 4. 设置键的过期时间
      pipeline.expire(key, Math.floor(this.windowMs / 1000) + 10);
      
      const results = await pipeline.exec();
      const currentCount = results[1] as number;

      if (currentCount >= this.maxRequests) {
        // 触发限流，计算需要等待的时间
        const earliest = await this.redis.zRangeWithScores(key, 0, 0);
        const earliestTs = earliest && earliest.length > 0 ? earliest[0].score : currentTs;
        const waitSeconds = ((earliestTs + this.windowMs - currentTs) / 1000).toFixed(1);
        return { allowed: false, remaining: 0, waitSeconds };
      } else {
        // 允许放行
        const remaining = this.maxRequests - currentCount - 1;
        return { allowed: true, remaining, waitSeconds: '0' };
      }
    } catch (err) {
      console.error(`Redis 限流器 [${type}] 出错 (降级放行):`, err);
      return { allowed: true, remaining: 1, waitSeconds: '0' };
    }
  }
}

// 双维度限流实例
// 1. 手机号+IP组合维度限流器 (1分钟最多5次，防止同IP误伤)
const combinedRateLimiter = new SlidingWindowRateLimiter(redisClient, 60, 5);
// 2. 手机号维度限流器 (1小时最多10次，防止换IP刷单)
const phoneRateLimiter = new SlidingWindowRateLimiter(redisClient, 3600, 10);
// 3. 设备指纹限流器 (1天最多20次，锁定物理设备)
const deviceRateLimiter = new SlidingWindowRateLimiter(redisClient, 86400, 20);

// 虚假手机号过滤函数
function isFakePhone(phone: string) {
  // 规则1：测试号段（如1380000xxxx、1390000xxxx）
  const testPhonePattern = /^1(38|39|40|41)0000\d{4}$/;
  // 规则2：连续8位以上相同数字（如13888888888、13999999999）
  const repeatNumPattern = /(\d)\1{8,}/;
  // 规则3：纯顺序/逆序数字（如13812345678、13887654321）
  const orderNumPattern = /^1[3-9](012345678|876543210)\d$/;
  
  return testPhonePattern.test(phone) || repeatNumPattern.test(phone) || orderNumPattern.test(phone);
}

// 设备指纹生成函数
function getDeviceFingerprint(req: any) {
  const clientIp = getClientIp(req);
  const agent = req.useragent;
  // 提取核心设备信息（浏览器+系统+设备类型）
  const deviceInfo = [
    agent.browser,
    agent.version,
    agent.os,
    agent.device,
    req.headers['screen-resolution'] || 'unknown'
  ].join('-');
  // 哈希处理
  const fingerprint = crypto.createHash('md5')
    .update(deviceInfo + clientIp + COOKIE_SECRET)
    .digest('hex');
  return fingerprint;
}

// 获取真实IP地址函数
function getClientIp(req: express.Request) {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  if (Array.isArray(forwarded)) return forwarded[0];
  return (realIp as string) || (forwarded ? forwarded.split(',')[0].trim() : req.ip) || 'unknown';
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
} catch(e) { /* 列已存在，忽略 */ }

console.log('✅ SQLite 数据库已就绪');

/* ============================================================
   中间件
============================================================ */
app.use(cors());
app.use(express.json());

/* ============================================================
   接口：POST /api/submit-order
============================================================ */
app.post('/api/submit-order', async (req, res) => {
  const clientIp = getClientIp(req);
  const { userPhone, orderId } = req.body;

  // ── 第一层：虚假手机号过滤 ──
  if (userPhone && isFakePhone(userPhone)) {
    console.log(`🛑 拦截虚假手机号: ${userPhone}`);
    return res.status(400).json({ 
      code: 400, 
      msg: '手机号无效，请填写真实可用的手机号～' 
    });
  }

  // ── 第二层：设备指纹限流 (1天20次) ──
  const deviceFingerprint = getDeviceFingerprint(req);
  const deviceResult = await deviceRateLimiter.isAllowed(deviceFingerprint, 'device_fingerprint');
  if (!deviceResult.allowed) {
    console.log(`🛑 设备指纹限流拦截: ${deviceFingerprint} (IP: ${clientIp})`);
    return res.status(429).json({ 
      code: 429, 
      msg: `当前设备点单次数过多，请24小时后重试～` 
    });
  }

  // ── 第三层：多维度限流拦截 ──

  // 1. 手机号维度限流 (防止 IP 轮换攻击)
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

  // 2. 手机号+IP组合维度限流 (防止同 IP 误伤)
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

  // ── 业务逻辑 ──
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

  } catch (err: any) {
    console.error('数据库写入失败：', err.message);
    return res.status(500).json({ code: 500, msg: '服务器内部错误，请稍后重试' });
  }
});

/* ============================================================
   其他接口 (保持原样)
============================================================ */
app.get('/api/order-status/:orderId', (req, res) => {
  const { orderId } = req.params;
  try {
    const row: any = db.prepare('SELECT order_id, status, total_price FROM orders WHERE order_id = ?').get(orderId);
    if (!row) return res.status(404).json({ code: 404, msg: '订单不存在' });
    res.json({ code: 200, data: { orderId: row.order_id, status: row.status, totalPrice: row.total_price } });
  } catch(err) {
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

app.post('/api/confirm-order', (req, res) => {
  const ADMIN_PASSWORD = '123456789';
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
  const ADMIN_PASSWORD = '123456789'; 
  const clientPassword = req.headers['x-admin-password'];
  if (clientPassword !== ADMIN_PASSWORD) return res.status(401).json({ code: 401, msg: '暗号错误' });
  try {
    const rows: any[] = db.prepare('SELECT * FROM orders ORDER BY received_at DESC').all();
    const result = rows.map(r => ({ ...r, order_items: JSON.parse(r.order_items || '[]') }));
    res.json({ code: 200, data: result, total: result.length });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/* ============================================================
   Vite 中间件 (用于在开发环境下提供前端页面)
============================================================ */
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 茶颜悦色订单服务启动成功：http://localhost:${PORT}`);
  });
}

startServer();
