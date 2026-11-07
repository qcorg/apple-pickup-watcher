// Notification and page text, in English and Chinese. Each notification is { priority 1–5, title, message, click? }:
// 5 is a hit or its reminder, 1–2 arrive quietly.

const en = {
  hit: (t, others) => ({
    priority: 5, click: t.link,
    title: `In stock for pickup: ${t.label}`,
    message: [`${t.store}: ${t.quote}`, ...others.map((o) => `Also: ${o}`)].join('\n'),
  }),
  reminder: (t, n, max) => ({
    priority: 5, click: t.link,
    title: `Still in stock (${n}/${max}): ${t.label}`,
    message: `${t.store}: ${t.quote}`,
  }),
  gone: (store, label, quote) => ({ priority: 3, title: `No longer available: ${label}`, message: `${store}: ${quote || 'no data'}` }),
  changed: (lines) => ({ priority: 3, title: 'Pickup status changed', message: lines.join('\n') }),
  blocked: (mins, detail) => ({ priority: 4, title: `Apple is pushing back, pausing ${mins} min`, message: `${detail}. Checks resume on their own.` }),
  failing: (n, detail) => ({ priority: 4, title: `${n} checks in a row failed`, message: detail }),
  recovered: () => ({ priority: 3, title: 'Checks are working again', message: 'Pickup checks are succeeding again.' }),
  heartbeat: ({ total, ok, hit, paused, interval }) => ({
    priority: 2,
    title: 'Pickup Watcher daily summary',
    message: `${ok} of ${total} checks succeeded in the last 24 h, one every ${interval} s.\nNow: ${hit}${paused ? ' (paused)' : ''}`,
  }),
  test: () => ({ priority: 3, title: 'Pickup Watcher test', message: 'If you can read this, notifications work.' }),
  inStockAt: (store, label) => `${label} at ${store}`,
  nothingInStock: 'nothing in stock',
  testPrefix: '[test] ',
  needLocation: 'Set your ZIP or postcode.',
  needProducts: 'Add at least one product to watch.',
};

const zh = {
  hit: (t, others) => ({
    priority: 5, click: t.link,
    title: `可以取货了：${t.label}`,
    message: [`${t.store}：${t.quote}`, ...others.map((o) => `另有：${o}`)].join('\n'),
  }),
  reminder: (t, n, max) => ({
    priority: 5, click: t.link,
    title: `提醒（${n}/${max}）：${t.label} 仍可取货`,
    message: `${t.store}：${t.quote}`,
  }),
  gone: (store, label, quote) => ({ priority: 3, title: `取货没有了：${label}`, message: `${store}：${quote || '无数据'}` }),
  changed: (lines) => ({ priority: 3, title: '取货状态有变化', message: lines.join('\n') }),
  blocked: (mins, detail) => ({ priority: 4, title: `被 Apple 拦截，暂停 ${mins} 分钟`, message: `${detail}，之后自动继续。` }),
  failing: (n, detail) => ({ priority: 4, title: `连续 ${n} 次检查失败`, message: detail }),
  recovered: () => ({ priority: 3, title: '检查已恢复', message: '取货检查恢复正常。' }),
  heartbeat: ({ total, ok, hit, paused, interval }) => ({
    priority: 2,
    title: '取货监控日报',
    message: `过去 24 小时检查 ${total} 次，成功 ${ok} 次，每 ${interval} 秒一次。\n当前：${hit}${paused ? '（已暂停）' : ''}`,
  }),
  test: () => ({ priority: 3, title: '取货监控测试通知', message: '收到这条说明通知正常。' }),
  inStockAt: (store, label) => `${store} ${label} 可取货`,
  nothingInStock: '都无货',
  testPrefix: '[测试] ',
  needLocation: '请填写邮编。',
  needProducts: '请至少添加一个要监控的产品。',
};

export const texts = (lang) => (lang === 'zh' ? zh : en);
