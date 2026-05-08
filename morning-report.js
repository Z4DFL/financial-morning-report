// 金融市场晨报 — 每天早上 9:00 通过 Server酱 推送到微信
// 数据源: 新浪财经 (A股指数/外汇/大宗商品/新闻)
import { writeFileSync } from "node:fs";

const SENDKEY = process.env.SENDKEY || "SCT346359T1ErBbbcPAUM5AZo4fy2pXSpa";

// ---- HTTP helpers ----

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (i === retries) throw err;
      const code = err.cause?.code;
      if (err.name === "AbortError" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND") {
        console.log(`请求失败 (${err.name === "AbortError" ? "超时" : code})，重试 ${i + 1}/${retries}...`);
      } else {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchSina(codes) {
  const r = await fetchWithRetry(`https://hq.sinajs.cn/?list=${codes}`, {
    headers: { Referer: "https://finance.sina.com.cn", "User-Agent": UA },
  });
  const buf = await r.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const result = {};
  for (const line of text.split("\n")) {
    const m = line.match(/var hq_str_(\w+)="([^"]*)"/);
    if (m) result[m[1]] = m[2].split(",");
  }
  return result;
}

// ---- 数据获取 ----

async function fetchIndices() {
  const data = await fetchSina("s_sh000001,s_sz399001,s_sz399006,s_sh000688");
  const order = ["s_sh000001", "s_sz399001", "s_sz399006", "s_sh000688"];
  return order
    .map((key) => {
      const f = data[key];
      if (!f) return null;
      return {
        name: f[0],
        code: key,
        price: parseFloat(f[1]) || 0,
        changePct: parseFloat(f[3]) || 0,
        changeAmt: parseFloat(f[2]) || 0,
      };
    })
    .filter(Boolean);
}

async function fetchForexData() {
  const data = await fetchSina("fx_susdcny,fx_seurusd,fx_sjpycny");
  const nameMap = {
    fx_susdcny: "美元/人民币",
    fx_seurusd: "欧元/美元",
    fx_sjpycny: "日元/人民币",
  };
  const codeMap = { fx_susdcny: "USDCNY", fx_seurusd: "EURUSD", fx_sjpycny: "JPYCNY" };

  return Object.entries(data).map(([key, fields]) => ({
    name: nameMap[key] || fields[9],
    code: codeMap[key] || key,
    price: parseFloat(fields[1]) || 0,
    changePct: parseFloat(fields[11]) || 0,
    changeAmt: parseFloat(fields[10]) || 0,
  }));
}

async function fetchCommodityData() {
  const data = await fetchSina("hf_XAU,hf_CL,hf_OIL");
  const nameMap = { XAUUSD: "伦敦金", CL: "WTI 原油", OIL: "布伦特原油" };

  return [
    { key: "XAUUSD", ...data.hf_XAU },
    { key: "CL", ...data.hf_CL },
    { key: "OIL", ...data.hf_OIL },
  ].map(({ key, ...fields }) => {
    const f = Object.values(fields);
    const hasPrevClose = f[1] != null && f[1].trim() !== "";
    const rawPrev = parseFloat(f[1]);
    const price = parseFloat(f[0]) || 0;

    return {
      name: f[13] || nameMap[key] || key,
      code: key,
      price,
      prevClose: hasPrevClose ? rawPrev : NaN,
      changePct: hasPrevClose && rawPrev !== 0 ? ((price - rawPrev) / rawPrev * 100) : NaN,
      changeAmt: hasPrevClose ? price - rawPrev : NaN,
    };
  });
}

async function fetchNews() {
  const url =
    "https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=50&page=1";

  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://news.sina.com.cn/roll/", "User-Agent": UA },
  });
  const json = await res.json();
  const articles = json.result?.data ?? [];

  const today = new Date();
  const todayStart =
    new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000;

  return articles
    .filter((a) => parseInt(a.ctime) >= todayStart)
    .slice(0, 10)
    .map((a) => ({
      title: a.title,
      url: a.url,
      time: new Date(parseInt(a.ctime) * 1000).toLocaleTimeString("zh-CN", { hour12: false }),
    }))
    .filter((a, i, arr) => arr.findIndex((x) => x.title === a.title) === i)
    .slice(0, 10);
}

// ---- 市场概览生成 ----

function generateOverview(indices, commodities) {
  const up = indices.filter((i) => i.changePct > 0);
  const down = indices.filter((i) => i.changePct < 0);
  const best = indices.reduce((a, b) => (a.changePct > b.changePct ? a : b));
  const gold = commodities.find((c) => c.code === "XAUUSD");
  const oil = commodities.find((c) => c.code === "CL");

  let overview = "";

  if (up.length === indices.length) {
    overview += `今日 A 股全面走强，`;
  } else if (down.length === indices.length) {
    overview += `今日 A 股全线收跌，`;
  } else {
    overview += `今日 A 股走势分化，`;
  }

  overview += `${indices.length}大指数中 ${up.length} 涨 ${down.length} 跌，`;
  overview += `${best.name}表现最佳，${best.changePct > 0 ? "上涨" : "下跌"} ${Math.abs(best.changePct).toFixed(2)}%。`;

  const lines = [];
  if (gold && !isNaN(gold.changePct)) {
    const dir = gold.changePct > 0 ? "上涨" : "下跌";
    lines.push(`伦敦金${dir} ${Math.abs(gold.changePct).toFixed(2)}% 至 ${gold.price.toFixed(0)} 美元`);
  } else if (gold) {
    lines.push(`伦敦金报 ${gold.price.toFixed(0)} 美元`);
  }
  if (oil && !isNaN(oil.changePct) && Math.abs(oil.changePct) > 0.01) {
    const dir = oil.changePct > 0 ? "上涨" : "下跌";
    lines.push(`WTI 原油${dir} ${Math.abs(oil.changePct).toFixed(2)}% 至 ${oil.price.toFixed(2)} 美元`);
  } else if (oil) {
    lines.push(`WTI 原油报 ${oil.price.toFixed(2)} 美元`);
  }
  if (lines.length > 0) {
    overview += `\n\n${lines.join("，")}。`;
  }

  return overview;
}

// ---- 报告格式化 ----

function arrow(pct) {
  return pct > 0 ? "↑" : pct < 0 ? "↓" : "→";
}

function formatReport(indices, forexList, commodities, articles) {
  const now = new Date();
  const today = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  let md = `# 金融市场晨报\n\n**${today}**\n\n`;

  md += `## 市场概览\n\n${generateOverview(indices, commodities)}\n\n`;

  md += `## A股指数\n\n`;
  md += `| 指数 | 最新价 | 涨跌幅 | 涨跌额 |\n`;
  md += `|------|--------|--------|--------|\n`;
  for (const item of indices) {
    const a = arrow(item.changePct);
    md += `| ${item.name} | ${item.price.toFixed(2)} | ${a}${item.changePct.toFixed(2)}% | ${item.changeAmt.toFixed(2)} |\n`;
  }

  md += `\n## 外汇\n\n`;
  md += `| 货币对 | 最新价 | 涨跌幅 |\n`;
  md += `|--------|--------|--------|\n`;
  for (const item of forexList) {
    const a = arrow(item.changePct);
    const d = item.code === "JPYCNY" ? 6 : 4;
    md += `| ${item.name} | ${item.price.toFixed(d)} | ${a}${item.changePct.toFixed(4)}% |\n`;
  }

  md += `\n## 大宗商品\n\n`;
  md += `| 商品 | 最新价 | 涨跌幅 |\n`;
  md += `|------|--------|--------|\n`;
  for (const item of commodities) {
    let pctStr = "—";
    if (!isNaN(item.changePct)) {
      const a = arrow(item.changePct);
      pctStr = `${a}${item.changePct.toFixed(2)}%`;
    }
    md += `| ${item.name} | ${item.price.toFixed(2)} | ${pctStr} |\n`;
  }

  if (articles.length > 0) {
    md += `\n## 今日要闻\n\n`;
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      md += `${i + 1}. [${a.title}](${a.url}) — ${a.time}\n`;
    }
  }

  md += `\n---\n*数据来源: 新浪财经  |  更新时间: ${now.toLocaleTimeString("zh-CN", { hour12: false })}*`;

  return md;
}

// ---- 发送通知 ----

async function sendNotification(title, content) {
  const url = `https://sctapi.ftqq.com/${SENDKEY}.send`;
  const body = new URLSearchParams({ title, desp: content });

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const result = await res.json();
  if (result.code === 0) {
    console.log("晨报已发送到微信");
  } else {
    console.error("发送失败:", JSON.stringify(result));
    process.exit(1);
  }
}

// ---- 主流程 ----

async function main() {
  console.log("正在获取市场数据...");

  const [indices, forexList, commodities, articles] = await Promise.all([
    fetchIndices(),
    fetchForexData(),
    fetchCommodityData(),
    fetchNews(),
  ]);

  console.log(`指数: ${indices.length} | 外汇: ${forexList.length} | 商品: ${commodities.length} | 新闻: ${articles.length}`);

  const report = formatReport(indices, forexList, commodities, articles);

  const dateStr = new Date().toISOString().slice(0, 10);
  writeFileSync(`morning-report-${dateStr}.md`, report, "utf-8");
  console.log(`已保存到 morning-report-${dateStr}.md`);

  const title = `金融市场晨报 - ${new Date().toLocaleDateString("zh-CN")}`;
  await sendNotification(title, report);
}

main().catch((err) => {
  console.error("脚本执行失败:", err);
  process.exit(1);
});
