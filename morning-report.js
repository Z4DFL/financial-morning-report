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

// ---- 品种配置 ----

const INDEX_CODES = [
  "s_sh000001,s_sh000300,s_sh000016,s_sz399001,s_sz399006,s_sh000905,s_sh000688",
];

const FOREX_PAIRS = {
  fx_susdcny: { name: "美元/人民币", ticker: "USDCNY", decimals: 4 },
  fx_seurusd: { name: "欧元/美元", ticker: "EURUSD", decimals: 4 },
  fx_sjpycny: { name: "日元/人民币", ticker: "JPYCNY", decimals: 5 },
  fx_sgbpusd: { name: "英镑/美元", ticker: "GBPUSD", decimals: 4 },
  fx_seurcny: { name: "欧元/人民币", ticker: "EURCNY", decimals: 4 },
  fx_susdhkd: { name: "美元/港元", ticker: "USDHKD", decimals: 4 },
};

const INTL_COMMODITIES = [
  { code: "hf_XAG", key: "hf_XAG", name: "伦敦银", unit: "美元" },
  { code: "hf_HG", key: "hf_HG", name: "COMEX铜", unit: "美元" },
  { code: "hf_CL", key: "hf_CL", name: "WTI 原油", unit: "美元" },
  { code: "hf_OIL", key: "hf_OIL", name: "布伦特原油", unit: "美元" },
];

// ---- 新闻质量配置 ----

const CLICKBAIT_PATTERNS = [
  /震惊/, /刚刚/, /突发/, /紧急/, /重磅/, /速看/, /不看后悔/,
  /惊呆了/, /出大事/, /炸裂/, /疯传/, /一夜暴/,
  /史诗级/, /恐怖/, /骇人/, /必读/, /赶紧/, /马上/,
  /揭秘/, /内幕/, /真相/, /竟然/, /想不到/,
  /注意了/, /定了/, /官宣了/, /终于/, /别错过/, /不要再/,
  /超级/, /极致/, /逆天/, /看呆了/, /说中了/,
];

const MEDIA_AUTHORITY = {
  "新华社": 5, "央视新闻": 5, "人民日报": 5, "央视网": 5, "新华网": 5,
  "证券时报": 4, "上海证券报": 4, "中国证券报": 4, "证券日报": 4,
  "经济参考报": 4, "中证网": 4, "中新社": 4, "中新网": 4,
  "第一财经": 3, "21世纪经济报道": 3, "经济观察报": 3, "经济日报": 3,
  "每日经济新闻": 3, "界面新闻": 3, "华尔街见闻": 3,
  "财联社": 3, "中国基金报": 3, "澎湃新闻": 3,
  "券商中国": 3, "中国经营报": 3, "金融界": 3,
  "新浪财经": 2, "东方财富": 2, "和讯网": 2, "36氪": 2,
  "腾讯财经": 2, "网易财经": 2, "凤凰财经": 2, "腾讯新闻": 2,
};

// 金融相关关键词，用于筛选财经新闻
const FINANCE_KEYWORDS = [
  "股", "市", "基金", "债", "汇", "央行", "美联储", "IPO",
  "A股", "港股", "美股", "指数", "板块", "涨停", "跌停",
  "经济", "GDP", "CPI", "PMI", "通胀", "利率", "降息", "加息",
  "黄金", "原油", "商品", "期货", "期权", "外汇", "人民币",
  "银行", "券商", "保险", "信托", "监管", "证监会", "银保监",
  "科技", "芯片", "新能源", "汽车", "房地产", "医药", "消费",
  "业绩", "财报", "营收", "利润", "分红", "回购", "收购",
  "上市", "融资", "投资", "估值", "目标价", "评级",
];

const NEWS_FETCH_COUNT = 80;
const NEWS_OUTPUT_COUNT = 8;

// ---- 新闻过滤函数 ----

function isClickbait(title) {
  if (!title) return true;
  return CLICKBAIT_PATTERNS.some((p) => p.test(title));
}

function mediaScore(name) {
  if (!name) return 0;
  for (const [key, score] of Object.entries(MEDIA_AUTHORITY)) {
    if (name.includes(key)) return score;
  }
  return 0;
}

// ---- 数据获取 ----

async function fetchIndices() {
  const data = await fetchSina(INDEX_CODES[0]);
  const order = INDEX_CODES[0].split(",");
  return order
    .map((code) => {
      const f = data[code];
      if (!f) return null;
      return {
        name: f[0],
        code,
        price: parseFloat(f[1]) || 0,
        changePct: parseFloat(f[3]) || 0,
        changeAmt: parseFloat(f[2]) || 0,
      };
    })
    .filter(Boolean);
}

async function fetchForexData() {
  const codes = Object.keys(FOREX_PAIRS).join(",");
  const data = await fetchSina(codes);

  return Object.entries(data).map(([key, fields]) => {
    const cfg = FOREX_PAIRS[key] || {};
    return {
      name: cfg.name || fields[9] || key,
      code: cfg.ticker || key,
      decimals: cfg.decimals || 4,
      price: parseFloat(fields[1]) || 0,
      changePct: parseFloat(fields[11]) || 0,
      changeAmt: parseFloat(fields[10]) || 0,
    };
  });
}

async function fetchCommodityData() {
  // 国内期货和海外期货分开请求
  const [domesticData, intlData] = await Promise.all([
    fetchSina("nf_AU0"),
    fetchSina(INTL_COMMODITIES.map((c) => c.code).join(",")),
  ]);

  const commodities = [];

  // 沪金连续 (nf_AU0) — 国内期货格式
  const nfFields = domesticData["nf_AU0"];
  if (nfFields && nfFields.length > 7) {
    const name = "沪金连续";
    const rawPrice = parseFloat(nfFields[7]);
    const price = isNaN(rawPrice) ? 0 : rawPrice;
    const prevSettle = parseFloat(nfFields[4]) || NaN;
    const hasPrev = !isNaN(prevSettle) && prevSettle > 0;
    commodities.push({
      name,
      code: "AU0",
      price,
      prevClose: hasPrev ? prevSettle : NaN,
      changePct: hasPrev ? ((price - prevSettle) / prevSettle * 100) : NaN,
      changeAmt: hasPrev ? price - prevSettle : NaN,
      unit: "元/克",
    });
    console.log(`nf_AU0 字段: name=${name} price=${price} prevSettle=${prevSettle}`);
  } else {
    console.log("nf_AU0 数据为空，可能非交易时段");
    commodities.push({
      name: "沪金连续",
      code: "AU0",
      price: 0,
      prevClose: NaN,
      changePct: NaN,
      changeAmt: NaN,
      unit: "元/克",
    });
  }

  // 海外期货 (hf_ 格式)
  for (const cfg of INTL_COMMODITIES) {
    const f = intlData[cfg.key];
    if (!f) continue;
    const hasPrevClose = f[1] != null && f[1].trim() !== "";
    const rawPrev = parseFloat(f[1]);
    const price = parseFloat(f[0]) || 0;
    commodities.push({
      name: cfg.name,
      code: cfg.code,
      price,
      prevClose: hasPrevClose ? rawPrev : NaN,
      changePct: hasPrevClose && rawPrev !== 0 ? ((price - rawPrev) / rawPrev * 100) : NaN,
      changeAmt: hasPrevClose ? price - rawPrev : NaN,
      unit: cfg.unit,
    });
  }

  return commodities;
}

async function fetchNews() {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=${NEWS_FETCH_COUNT}&page=1`;

  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://news.sina.com.cn/roll/", "User-Agent": UA },
  });
  const json = await res.json();
  let articles = json.result?.data ?? [];

  const todayStart =
    new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() / 1000;

  // 第一层: 今日文章
  articles = articles.filter((a) => parseInt(a.ctime) >= todayStart);

  // 第二层: 金融相关性过滤
  articles = articles.filter((a) => {
    const text = (a.title || "") + (a.keywords || "");
    return FINANCE_KEYWORDS.some((kw) => text.includes(kw));
  });

  // 第三层: 标题党过滤
  articles = articles.filter((a) => !isClickbait(a.title));

  // docid 去重
  const seen = new Set();
  articles = articles.filter((a) => {
    const id = a.docid || a.title;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // 按媒体权威性降序，同分按时间倒序
  articles.sort((a, b) => {
    const sa = mediaScore(a.media_name);
    const sb = mediaScore(b.media_name);
    if (sa !== sb) return sb - sa;
    return parseInt(b.ctime) - parseInt(a.ctime);
  });

  articles = articles.slice(0, NEWS_OUTPUT_COUNT);

  // 最终按时间正序展示
  articles.sort((a, b) => parseInt(a.ctime) - parseInt(b.ctime));

  return articles.map((a) => ({
    title: a.title || "",
    url: a.url || "",
    time: new Date(parseInt(a.ctime) * 1000).toLocaleTimeString("zh-CN", { hour12: false }),
    intro: (a.intro || "").trim(),
    media: (a.media_name || "").trim(),
  }));
}

// ---- 市场概览生成 ----

function generateOverview(indices, commodities) {
  const up = indices.filter((i) => i.changePct > 0);
  const down = indices.filter((i) => i.changePct < 0);
  const best = indices.reduce((a, b) => (a.changePct > b.changePct ? a : b));
  const gold = commodities.find((c) => c.code === "AU0");
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
  const dir = best.changePct > 0 ? "上涨" : "下跌";
  overview += `${best.name}表现最佳，${dir} ${Math.abs(best.changePct).toFixed(2)}%。`;

  const lines = [];
  if (gold && !isNaN(gold.changePct)) {
    const gdir = gold.changePct > 0 ? "上涨" : "下跌";
    lines.push(`沪金${gdir} ${Math.abs(gold.changePct).toFixed(2)}% 至 ${gold.price.toFixed(2)} 元/克`);
  } else if (gold && gold.price > 0) {
    lines.push(`沪金报 ${gold.price.toFixed(2)} 元/克`);
  }
  if (oil && !isNaN(oil.changePct) && Math.abs(oil.changePct) > 0.01) {
    const odir = oil.changePct > 0 ? "上涨" : "下跌";
    lines.push(`WTI 原油${odir} ${Math.abs(oil.changePct).toFixed(2)}% 至 ${oil.price.toFixed(2)} 美元`);
  } else if (oil && oil.price > 0) {
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
    md += `| ${item.name} | ${item.price.toFixed(2)} | ${a}${item.changePct.toFixed(2)}% | ${item.changeAmt >= 0 ? "+" : ""}${item.changeAmt.toFixed(2)} |\n`;
  }

  md += `\n## 外汇\n\n`;
  md += `| 货币对 | 最新价 | 涨跌幅 |\n`;
  md += `|--------|--------|--------|\n`;
  for (const item of forexList) {
    const a = arrow(item.changePct);
    md += `| ${item.name} | ${item.price.toFixed(item.decimals)} | ${a}${item.changePct.toFixed(4)}% |\n`;
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
    md += `| ${item.name} | ${item.price.toFixed(2)} ${item.unit} | ${pctStr} |\n`;
  }

  if (articles.length > 0) {
    md += `\n## 今日要闻\n\n`;
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      md += `${i + 1}. **${a.title}**`;
      if (a.media) md += ` — ${a.media}`;
      md += `\n`;
      if (a.intro) md += `   > ${a.intro}\n`;
      md += `   [阅读全文](${a.url})\n\n`;
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
