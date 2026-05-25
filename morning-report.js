// 金融市场晨报 v3 — 多信源聚合 + AI 总结
// 每天早上 8:30 通过 cron-job.org 触发 → GitHub Action → Server酱 → 微信
// 数据源: 新浪财经 + 东方财富 + DeepSeek AI
// 用法: node morning-report.js           → 完整流程（获取数据 + 生成报告 + 推送）
//       node morning-report.js --fetch   → 仅获取数据，保存到 market-data.json
//       node morning-report.js --report  → 从 market-data.json 读取，生成报告并推送

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SENDKEY = process.env.SENDKEY || "SCT346359T1ErBbbcPAUM5AZo4fy2pXSpa";
const AI_API_KEY = process.env.AI_API_KEY || "";      // DeepSeek / OpenAI 兼容 key
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.deepseek.com/v1";
const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";

// ═══════════════════════════════════════════════════════════════
// HTTP 工具
// ═══════════════════════════════════════════════════════════════

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
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

// ═══════════════════════════════════════════════════════════════
// 新浪财经 API (GBK 编码)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 东方财富 API (JSON)
// ═══════════════════════════════════════════════════════════════

const EM_UT = "b2884a393a59ad64002292a3e90d46a5";
const EM_HEADERS = {
  "User-Agent": UA,
  "Referer": "https://quote.eastmoney.com/",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

let _emCookie = null;

async function getEMCookie() {
  if (_emCookie) return _emCookie;
  try {
    const r = await fetchWithRetry("https://quote.eastmoney.com/", {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" },
    });
    const raw = r.headers.get("set-cookie") || "";
    const cookies = raw.split(",").map((s) => s.split(";")[0].trim()).filter(Boolean);
    _emCookie = cookies.join("; ");
    if (_emCookie) console.log(`  东方财富 cookie 已获取`);
  } catch (e) {
    console.log("  东方财富 cookie 获取失败:", e.message);
    _emCookie = "";
  }
  return _emCookie;
}

async function fetchEMJSON(url) {
  const cookie = await getEMCookie();
  const headers = { ...EM_HEADERS };
  if (cookie) headers.Cookie = cookie;
  const r = await fetchWithRetry(url, { headers });
  return r.json();
}

async function fetchEMClist(fs, fields, { pz = 200, fid = "f3", po = 1 } = {}) {
  const params = new URLSearchParams({ pn: "1", pz: String(pz), po: String(po), np: "1", fid, fs, fields, ut: EM_UT });
  const url = `https://push2.eastmoney.com/api/qt/clist/get?${params}`;
  const data = await fetchEMJSON(url);
  return data?.data?.diff ?? [];
}

// ═══════════════════════════════════════════════════════════════
// 品种配置
// ═══════════════════════════════════════════════════════════════

const INDEX_CODES = "s_sh000001,s_sh000300,s_sh000016,s_sz399001,s_sz399006,s_sh000905,s_sh000688";

const OVERSEAS_SINA = {
  int_dji:       { name: "道琼斯", ticker: "DJI" },
  int_nasdaq:    { name: "纳斯达克", ticker: "IXIC" },
  int_snp500:    { name: "标普500", ticker: "SPX" },
  int_hangseng:  { name: "恒生指数", ticker: "HSI" },
  int_hscei:     { name: "国企指数", ticker: "HSCEI" },
};

const FOREX_PAIRS = {
  fx_susdcny: { name: "美元/人民币", ticker: "USDCNY", decimals: 4 },
  fx_seurusd: { name: "欧元/美元", ticker: "EURUSD", decimals: 4 },
  fx_sjpycny: { name: "日元/人民币", ticker: "JPYCNY", decimals: 5 },
  fx_sgbpusd: { name: "英镑/美元", ticker: "GBPUSD", decimals: 4 },
  fx_seurcny: { name: "欧元/人民币", ticker: "EURCNY", decimals: 4 },
  fx_susdhkd: { name: "美元/港元", ticker: "USDHKD", decimals: 4 },
};

// 国内期货
const DOMESTIC_FUTURES = ["nf_AU0", "nf_RB0", "nf_I0", "nf_J0", "nf_M0", "nf_LH0"];

const DOMESTIC_FUTURE_META = {
  nf_AU0: { name: "沪金", unit: "元/克" },
  nf_RB0: { name: "螺纹钢", unit: "元/吨" },
  nf_I0:  { name: "铁矿石", unit: "元/吨" },
  nf_J0:  { name: "焦煤", unit: "元/吨" },
  nf_M0:  { name: "豆粕", unit: "元/吨" },
  nf_LH0: { name: "生猪", unit: "元/吨" },
};

// 海外期货
const INTL_COMMODITIES = [
  { code: "hf_XAG", key: "hf_XAG", name: "伦敦银", unit: "美元" },
  { code: "hf_HG",  key: "hf_HG",  name: "COMEX铜", unit: "美元" },
  { code: "hf_CL",  key: "hf_CL",  name: "WTI 原油", unit: "美元" },
  { code: "hf_OIL", key: "hf_OIL", name: "布伦特原油", unit: "美元" },
  { code: "hf_NG",  key: "hf_NG",  name: "天然气", unit: "美元" },
];

// ═══════════════════════════════════════════════════════════════
// 新闻过滤配置
// ═══════════════════════════════════════════════════════════════

const CLICKBAIT_PATTERNS = [
  /震惊/, /刚刚/, /突发/, /重磅/, /速看/, /不看后悔/,
  /惊呆了/, /出大事/, /炸裂/, /疯传/, /一夜暴/,
  /史诗级/, /恐怖/, /骇人/, /必读/, /赶紧/, /马上/,
  /揭秘/, /内幕/, /真相/, /竟然/, /想不到/,
  /注意了/, /定了/, /官宣了/, /终于/, /别错过/, /不要再/,
  /超级/, /极致/, /逆天/, /看呆了/, /说中了/,
  /直线涨停/, /忙得冒烟/, /板了/, /起飞了/, /太突然/,
];

const HK_RESEARCH_PATTERNS = [
  /目标价.*港元/, /目标价.*美元/, /维持.*评级/, /给予.*评级/, /首次覆盖/,
  /上调.*目标价/, /下调.*目标价/, /重申.*评级/, /升至.*港元/, /降至.*港元/,
];

const MEDIA_AUTHORITY = {
  "新华社": 5, "央视新闻": 5, "人民日报": 5, "央视网": 5, "新华网": 5,
  "央行": 5, "证监会": 5, "银保监会": 5, "国务院": 5,
  "证券时报": 4, "上海证券报": 4, "中国证券报": 4, "证券日报": 4,
  "经济参考报": 4, "中证网": 4, "中新社": 4, "中新网": 4,
  "第一财经": 3, "21世纪经济报道": 3, "经济观察报": 3, "经济日报": 3,
  "每日经济新闻": 3, "界面新闻": 3, "华尔街见闻": 3,
  "财联社": 3, "中国基金报": 3, "澎湃新闻": 3,
  "券商中国": 3, "中国经营报": 3, "金融界": 3,
  "新浪财经": 2, "东方财富": 2, "和讯网": 2, "36氪": 2,
  "腾讯财经": 2, "网易财经": 2, "凤凰财经": 2, "腾讯新闻": 2,
  "环球市场播报": 2,
};

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
const NEWS_OUTPUT_COUNT = 10;

// ═══════════════════════════════════════════════════════════════
// 新闻过滤函数
// ═══════════════════════════════════════════════════════════════

function isClickbait(title) {
  if (!title) return true;
  return CLICKBAIT_PATTERNS.some((p) => p.test(title));
}

function isHKResearch(title) {
  if (!title) return false;
  return HK_RESEARCH_PATTERNS.some((p) => p.test(title));
}

function mediaScore(name) {
  if (!name) return 0;
  for (const [key, score] of Object.entries(MEDIA_AUTHORITY)) {
    if (name.includes(key)) return score;
  }
  return 0;
}

function cleanTitle(title) {
  // 去掉开头的媒体标签，如 "焦煤跌超4%"
  return (title || "").replace(/^(视频|突发|刚刚|快讯|午评|收评|夜读)[：:：]\s*/g, "").trim();
}

// ═══════════════════════════════════════════════════════════════
// 1. A股指数 (新浪)
// ═══════════════════════════════════════════════════════════════

async function fetchIndices() {
  const data = await fetchSina(INDEX_CODES);
  const codes = INDEX_CODES.split(",");
  return codes.map((code) => {
    const f = data[code];
    if (!f || !f[1]) return null;
    // 新浪 A 指数字段: f[0]=名称, f[1]=当前价, f[2]=涨跌额, f[3]=涨跌幅(%),
    //                   f[4]=成交量(手), f[5]=成交额(万)
    const price = parseFloat(f[1]) || 0;
    const changePct = parseFloat(f[3]) || 0;
    const changeAmt = parseFloat(f[2]) || 0;
    const volume = parseFloat(f[5]) || 0; // 成交额 万元
    return { name: f[0], code, price, changePct, changeAmt, volume };
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// 2. 隔夜海外指数 (新浪 — 前一交易日收盘)
// ═══════════════════════════════════════════════════════════════

async function fetchOverseas() {
  const codes = Object.keys(OVERSEAS_SINA).join(",");
  const data = await fetchSina(codes);
  return Object.entries(data).map(([code, f]) => {
    const cfg = OVERSEAS_SINA[code] || {};
    const price = parseFloat(f[1]) || 0;
    const prevClose = parseFloat(f[2]) || 0;
    const changePct = parseFloat(f[3]) || (prevClose ? ((price - prevClose) / prevClose * 100) : 0);
    return {
      name: cfg.name || f[0] || code,
      ticker: cfg.ticker || code,
      price,
      changePct,
      changeAmt: parseFloat(f[4]) || (price - prevClose),
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// 3. 外汇 (新浪)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 4. 大宗商品 (新浪国内+海外期货)
// ═══════════════════════════════════════════════════════════════

async function fetchCommodities() {
  const domCodes = DOMESTIC_FUTURES.join(",");
  const intlCodes = INTL_COMMODITIES.map((c) => c.code).join(",");
  const [domData, intlData] = await Promise.all([
    fetchSina(domCodes),
    fetchSina(intlCodes),
  ]);

  const commodities = [];

  // 国内期货
  for (const code of DOMESTIC_FUTURES) {
    const f = domData[code];
    const meta = DOMESTIC_FUTURE_META[code] || {};
    if (!f || f.length < 8) {
      commodities.push({ name: meta.name || code, code, price: 0, changePct: NaN, changeAmt: NaN, unit: meta.unit || "" });
      continue;
    }
    // 新浪期货字段: f[0]=名称, f[1]=时间, f[2]=开盘, f[3]=最高, f[4]=最低,
    //               f[5]=买价, f[6]=卖价, f[7]=最新价, f[8]=昨收, f[9]=买量,
    //               f[10]=昨结算, f[11]=持仓量, f[12]=成交量
    const price = parseFloat(f[7]) || parseFloat(f[8]) || parseFloat(f[2]) || 0;
    const prevSettle = parseFloat(f[10]) || parseFloat(f[8]) || NaN;
    const hasPrev = !isNaN(prevSettle) && prevSettle > 0;
    commodities.push({
      name: meta.name || code, code, price,
      prevClose: hasPrev ? prevSettle : NaN,
      changePct: hasPrev ? parseFloat(((price - prevSettle) / prevSettle * 100).toFixed(2)) : NaN,
      changeAmt: hasPrev ? parseFloat((price - prevSettle).toFixed(2)) : NaN,
      unit: meta.unit || "",
    });
  }

  // 海外期货
  for (const cfg of INTL_COMMODITIES) {
    const f = intlData[cfg.key];
    if (!f) continue;
    const hasPrev = f[1] != null && f[1].trim() !== "";
    const rawPrev = parseFloat(f[1]);
    const price = parseFloat(f[0]) || 0;
    commodities.push({
      name: cfg.name, code: cfg.code, price,
      prevClose: hasPrev ? rawPrev : NaN,
      changePct: hasPrev && rawPrev !== 0 ? parseFloat(((price - rawPrev) / rawPrev * 100).toFixed(2)) : NaN,
      changeAmt: hasPrev ? parseFloat((price - rawPrev).toFixed(2)) : NaN,
      unit: cfg.unit,
    });
  }

  return commodities;
}

// ═══════════════════════════════════════════════════════════════
// 5. A股市场宽度 (东方财富 — 涨跌家数、成交额统计)
// ═══════════════════════════════════════════════════════════════

async function fetchMarketBreadth() {
  try {
    // 并行抓取 3 页数据采样，覆盖涨跌两端
    const results = await Promise.all([
      fetchEMClist("m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", "f3,f12", { pz: 100 }),
      fetchEMClist("m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", "f3,f12", { pz: 100, po: 0 }),
      fetchEMClist("m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", "f3,f12", { pz: 100, fid: "f12" }),
    ]);
    const allStocks = new Map();
    for (const batch of results) {
      for (const s of (Array.isArray(batch) ? batch : Object.values(batch || {}))) {
        allStocks.set(s.f12, parseFloat(s.f3) || 0);
      }
    }
    let up = 0, down = 0, flat = 0;
    for (const pct of allStocks.values()) {
      if (pct > 0) up++;
      else if (pct < 0) down++;
      else flat++;
    }
    return { up, down, flat, total: up + down + flat };
  } catch (e) {
    console.log("市场宽度获取失败:", e.message);
    return { up: 0, down: 0, flat: 0, total: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. 行业板块热度 (东方财富 — 涨跌前3)
// ═══════════════════════════════════════════════════════════════

async function fetchSectors() {
  try {
    const raw = await fetchEMClist("m:90+t:2", "f3,f4,f12,f14,f104,f105", { pz: 100, fid: "f3", po: 1 });
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    // East Money f3 是百分比*100，如 823 = 8.23%
    const sorted = list
      .filter((s) => s.f14 && !s.f14.includes("Ⅱ") && !s.f14.includes("Ⅲ")) // 去重：只要一级分类
      .map((s) => ({
        name: s.f14,
        changePct: parseFloat((parseFloat(s.f3) / 100).toFixed(2)),
        up: parseInt(s.f104) || 0,
        down: parseInt(s.f105) || 0,
      }))
      .sort((a, b) => b.changePct - a.changePct);
    return {
      top3: sorted.slice(0, 3),
      bottom3: sorted.slice(-3).reverse(),
    };
  } catch (e) {
    console.log("板块数据获取失败:", e.message);
    return { top3: [], bottom3: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. 新闻聚合 (新浪 + 东方财富)
// ═══════════════════════════════════════════════════════════════

async function fetchSinaNews() {
  try {
    const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=${NEWS_FETCH_COUNT}&page=1`;
    const res = await fetchWithRetry(url, {
      headers: { Referer: "https://news.sina.com.cn/roll/", "User-Agent": UA },
    });
    const json = await res.json();
    return (json.result?.data ?? []).map((a) => ({
      title: cleanTitle(a.title || ""),
      url: a.url || "",
      time: new Date(parseInt(a.ctime) * 1000),
      intro: (a.intro || "").trim(),
      media: (a.media_name || "").trim(),
      source: "新浪",
      authority: mediaScore(a.media_name),
    }));
  } catch (e) {
    console.log("新浪新闻获取失败:", e.message);
    return [];
  }
}

function deduplicateNews(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    // 取标题前 8 个字做去重 key
    const key = (a.title || "").slice(0, 8);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyNews(article) {
  const t = article.title || "";
  if (/央行|降息|加息|LPR|逆回购|MLF|存款准备金|货币政策|财政|国务院|政治局|GDP|CPI|PMI|通胀|经济数据/.test(t))
    return "宏观";
  if (/美股|港股|欧股|日股|美联储|非农|道指|纳指|标普|恒生/.test(t))
    return "海外";
  if (/板块|涨停|跌停|概念|行情|指数|A股|上证|深证|创业板|科创板/.test(t))
    return "市场";
  if (/公司|业绩|IPO|上市|财报|营收|利润|收购|回购/.test(t))
    return "公司";
  return "其他";
}

async function fetchAllNews() {
  // 新浪新闻（暂不接入东财新闻，反爬保护）
  const sinaNews = await fetchSinaNews();

  const todayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() / 1000;
  const recent = sinaNews.filter((a) => a.time.getTime() / 1000 >= todayStart - 86400);

  let filtered = recent
    .filter((a) => !isClickbait(a.title))
    .filter((a) => {
      const text = (a.title || "") + (a.intro || "");
      return FINANCE_KEYWORDS.some((kw) => text.includes(kw));
    });

  filtered = deduplicateNews(filtered);

  // 港股研报降权
  filtered.sort((a, b) => {
    const sa = isHKResearch(a.title) ? 0 : a.authority;
    const sb = isHKResearch(b.title) ? 0 : b.authority;
    if (sa !== sb) return sb - sa;
    return b.time - a.time;
  });

  // 按类别各取，宏观优先
  const categories = { "宏观": [], "市场": [], "海外": [], "公司": [], "其他": [] };
  for (const a of filtered) {
    const cat = classifyNews(a);
    if (categories[cat] && categories[cat].length < 4) categories[cat].push(a);
  }

  let result = [...categories["宏观"], ...categories["市场"], ...categories["海外"]];
  if (result.length < NEWS_OUTPUT_COUNT) {
    result = result.concat(categories["公司"], categories["其他"]);
  }
  result = result.slice(0, NEWS_OUTPUT_COUNT);
  result.sort((a, b) => b.authority - a.authority);

  return result.map((a) => ({
    title: a.title,
    url: a.url,
    time: a.time.toLocaleTimeString("zh-CN", { hour12: false }),
    intro: a.intro,
    media: a.media,
    category: classifyNews(a),
  }));
}

// ═══════════════════════════════════════════════════════════════
// 8. AI 市场总结 (DeepSeek / OpenAI 兼容 API)
// ═══════════════════════════════════════════════════════════════

async function generateAISummary(marketData) {
  if (!AI_API_KEY) {
    console.log("未配置 AI_API_KEY，跳过 AI 总结");
    return "";
  }

  const prompt = `你是一位资深证券分析师。请根据以下金融市场数据，写一段150-200字的市场综述。

要求：
1. 一句话概括今日市场核心矛盾
2. 点出2-3个主要驱动因素
3. 提示今日需关注的风险点
4. 语言精炼，避免套话

数据如下：
${marketData}

市场综述：`;

  try {
    const res = await fetchWithRetry(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.3,
      }),
    });
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.log("AI 总结生成失败:", e.message);
    return "";
  }
}

// ═══════════════════════════════════════════════════════════════
// 帮助函数
// ═══════════════════════════════════════════════════════════════

function arrow(pct) {
  if (isNaN(pct)) return "";
  return pct > 0 ? "↑" : pct < 0 ? "↓" : "→";
}

function fmtPct(pct) {
  if (isNaN(pct)) return "—";
  return `${arrow(pct)}${Math.abs(pct).toFixed(2)}%`;
}

function fmtNum(n, unit) {
  if (!n || isNaN(n)) return "—";
  if (n >= 100000000) return `${(n / 100000000).toFixed(0)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(0)}万`;
  return `${n.toFixed(0)}${unit || ""}`;
}

// ═══════════════════════════════════════════════════════════════
// 报告格式化
// ═══════════════════════════════════════════════════════════════

function formatReport({
  aiSummary, indices, overseas, sectors, breadth,
  forexList, commodities, articles, fundamentals,
}) {
  const now = new Date();
  const today = now.toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  });

  let md = `# 金融市场晨报\n\n**${today}**\n\n`;

  // —— AI 总结 ——
  if (aiSummary) {
    md += `> ${aiSummary}\n\n`;
  }

  // —— 隔夜海外 ——
  const validOverseas = overseas.filter((o) => o.price > 0);
  if (validOverseas.length > 0) {
    md += `## 隔夜海外\n\n`;
    md += `| 指数 | 收盘价 | 涨跌幅 |\n|------|--------|--------|\n`;
    for (const o of validOverseas) {
      md += `| ${o.name} | ${o.price.toFixed(2)} | ${fmtPct(o.changePct)} |\n`;
    }
    md += `\n`;
  }

  // —— 全球市场估值（来自 Yahoo Finance）——
  if (fundamentals) {
    const fundList = fundamentals.fundamentals || [];
    const cryptoList = fundamentals.crypto || [];
    if (fundList.length > 0) {
      md += `## 全球市场\n\n`;
      md += `| 标的 | 价格 | PE | 52周均线 |\n|------|------|----|----------|\n`;
      for (const f of fundList) {
        const price = typeof f.price === "number" ? f.price.toFixed(2) : f.price;
        const pe = typeof f.pe === "number" ? f.pe.toFixed(1) : f.pe;
        const f50 = typeof f.fiftyDayAvg === "number" ? f.fiftyDayAvg.toFixed(2) : "—";
        md += `| ${f.name} | ${price} | ${pe} | ${f50} |\n`;
      }
      md += `\n`;
    }
    if (cryptoList.length > 0) {
      md += `**加密货币：** `;
      md += cryptoList.map((c) => {
        const pct = typeof c.changePct === "number" ? `${c.changePct.toFixed(2)}%` : "—";
        return `${c.name} $${typeof c.price === "number" ? c.price.toFixed(0) : c.price} (${pct})`;
      }).join(" | ");
      md += `\n\n`;
    }
  }

  // —— A股昨日复盘 ——
  md += `## A股昨日复盘\n\n`;

  // 市场概览
  if (breadth.total > 0) {
    const upPct = (breadth.up / breadth.total * 100).toFixed(0);
    const downPct = (breadth.down / breadth.total * 100).toFixed(0);
    const up = indices.filter((i) => i.changePct > 0);
    const down = indices.filter((i) => i.changePct < 0);
    const best = indices.reduce((a, b) => (a.changePct > b.changePct ? a : b), indices[0]);
    const totalVol = indices.reduce((s, i) => s + (i.volume || 0), 0);

    let overview = "";
    if (up.length === indices.length) overview += "全线走强，";
    else if (down.length === indices.length) overview += "全线收跌，";
    else overview += "走势分化，";

    overview += `${indices.length}大指数 ${up.length}涨${down.length}跌，`;
    const dir = best.changePct > 0 ? "上涨" : "下跌";
    overview += `${best.name}表现最佳${dir}${Math.abs(best.changePct).toFixed(2)}%。`;
    if (breadth.total > 0) {
      overview += ` 全市场${breadth.up}家上涨/${breadth.down}家下跌。`;
    }

    md += `${overview}\n\n`;
  }

  // 指数表
  md += `| 指数 | 收盘 | 涨跌幅 | 涨跌额 | 成交额(亿) |\n|------|------|--------|--------|------------|\n`;
  for (const item of indices) {
    const vol = item.volume ? (item.volume / 10000).toFixed(0) : "—";
    md += `| ${item.name} | ${item.price.toFixed(2)} | ${fmtPct(item.changePct)} | ${item.changeAmt >= 0 ? "+" : ""}${item.changeAmt.toFixed(2)} | ${vol} |\n`;
  }

  // —— 行业板块 ——
  if (sectors.top3.length > 0) {
    md += `\n## 行业板块\n\n`;
    md += `**领涨：** `;
    md += sectors.top3.map((s) => `${s.name} ${fmtPct(s.changePct)}`).join(" | ");
    md += `\n\n**领跌：** `;
    md += sectors.bottom3.map((s) => `${s.name} ${fmtPct(s.changePct)}`).join(" | ");
    md += `\n`;
  }

  // —— 外汇 ——
  md += `\n## 外汇\n\n`;
  md += `| 货币对 | 最新价 | 涨跌幅 |\n|--------|--------|--------|\n`;
  for (const item of forexList) {
    md += `| ${item.name} | ${item.price.toFixed(item.decimals)} | ${fmtPct(item.changePct)} |\n`;
  }

  // —— 大宗商品 ——
  md += `\n## 大宗商品\n\n`;
  md += `| 商品 | 最新价 | 涨跌幅 |\n|------|--------|--------|\n`;
  for (const item of commodities) {
    md += `| ${item.name} | ${item.price.toFixed(2)} ${item.unit} | ${fmtPct(item.changePct)} |\n`;
  }

  // —— 要闻 ——
  if (articles.length > 0) {
    md += `\n## 今日要闻\n\n`;
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      md += `${i + 1}. **${a.title}** — ${a.media}\n`;
      if (a.intro) md += `   > ${a.intro}\n`;
      md += `   [阅读全文](${a.url})\n\n`;
    }
  }


  md += `\n---\n*数据: 新浪财经 + 东方财富 | 更新: ${now.toLocaleTimeString("zh-CN", { hour12: false })}*`;

  return md;
}

// ═══════════════════════════════════════════════════════════════
// 推送
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════

async function fetchAllMarketData() {
  console.log("[1/3] 获取行情数据...");
  const [indices, overseas, forexList, commodities, breadth, sectors] = await Promise.all([
    fetchIndices(),
    fetchOverseas(),
    fetchForexData(),
    fetchCommodities(),
    fetchMarketBreadth(),
    fetchSectors(),
  ]);
  console.log(`  指数:${indices.length} | 海外:${overseas.filter(o=>o.price>0).length} | 外汇:${forexList.length} | 商品:${commodities.length}`);
  console.log(`  市场宽度: ${breadth.up}涨 ${breadth.down}跌 ${breadth.flat}平`);

  console.log("[2/3] 聚合新闻...");
  const articles = await fetchAllNews();
  console.log(`  新闻: ${articles.length}条`);

  console.log("[3/3] 生成 AI 总结...");
  const dataSummary = buildDataSummary({ indices, overseas, sectors, breadth, forexList, commodities, articles });
  const aiSummary = await generateAISummary(dataSummary);
  if (aiSummary) console.log(`  AI 总结: ${aiSummary.length}字`);
  else console.log("  跳过 AI 总结");

  return { indices, overseas, forexList, commodities, breadth, sectors, articles, aiSummary };
}

async function main() {
  const mode = process.argv[2] || "";

  if (mode === "--fetch") {
    // 仅获取数据，保存 JSON
    console.log("=== 金融市场晨报 v3 [数据获取模式] ===\n");
    const data = await fetchAllMarketData();
    const dateStr = now().slice(0, 10);
    writeFileSync("market-data.json", JSON.stringify(data, null, 2), "utf-8");
    console.log(`  数据已保存到 market-data.json`);
    // 同时保存旧版报告作为备份
    const report = formatReport(data);
    writeFileSync(`morning-report-${dateStr}.md`, report, "utf-8");
    return;
  }

  if (mode === "--report") {
    // 从 JSON 读取数据，生成报告
    console.log("=== 金融市场晨报 v3 [报告生成模式] ===\n");
    if (!existsSync("market-data.json")) {
      console.error("未找到 market-data.json，请先运行 --fetch");
      process.exit(1);
    }
    let fundamentals = null;
    if (existsSync("market-fundamentals.json")) {
      fundamentals = JSON.parse(readFileSync("market-fundamentals.json", "utf-8"));
    }
    const data = JSON.parse(readFileSync("market-data.json", "utf-8"));
    data.fundamentals = fundamentals;
    const report = formatReport(data);

    const dateStr = now().slice(0, 10);
    writeFileSync(`morning-report-${dateStr}.md`, report, "utf-8");
    console.log(`  已保存到 morning-report-${dateStr}.md`);

    const title = `金融市场晨报 - ${new Date().toLocaleDateString("zh-CN")}`;
    await sendNotification(title, report);
    return;
  }

  // 默认：完整流程
  console.log("=== 金融市场晨报 v3 ===\n");
  const data = await fetchAllMarketData();
  if (existsSync("market-fundamentals.json")) {
    try { data.fundamentals = JSON.parse(readFileSync("market-fundamentals.json", "utf-8")); } catch {}
  }
  const report = formatReport(data);

  const dateStr = now().slice(0, 10);
  writeFileSync(`morning-report-${dateStr}.md`, report, "utf-8");
  console.log(`  已保存到 morning-report-${dateStr}.md`);

  writeFileSync("market-data.json", JSON.stringify(data, null, 2), "utf-8");

  const title = `金融市场晨报 - ${new Date().toLocaleDateString("zh-CN")}`;
  await sendNotification(title, report);
}

function now() {
  return new Date().toISOString();
}

function buildDataSummary({ indices, overseas, sectors, breadth, forexList, commodities, articles }) {
  const lines = [];
  lines.push("## A股指数");
  for (const i of indices) lines.push(`${i.name}: ${i.price.toFixed(2)} ${fmtPct(i.changePct)}`);
  lines.push(`涨跌比: ${breadth.up}/${breadth.down}/${breadth.flat}`);
  lines.push("\n## 隔夜海外");
  for (const o of overseas.filter(o => o.price > 0)) lines.push(`${o.name}: ${o.price.toFixed(2)} ${fmtPct(o.changePct)}`);
  if (sectors.top3.length > 0) {
    lines.push("\n## 板块");
    lines.push("领涨: " + sectors.top3.map(s => `${s.name} ${fmtPct(s.changePct)}`).join(", "));
    lines.push("领跌: " + sectors.bottom3.map(s => `${s.name} ${fmtPct(s.changePct)}`).join(", "));
  }
  lines.push("\n## 外汇");
  for (const f of forexList) lines.push(`${f.name}: ${f.price.toFixed(f.decimals)}`);
  lines.push("\n## 商品");
  for (const c of commodities.filter(c => c.price > 0)) lines.push(`${c.name}: ${c.price.toFixed(2)}`);
  if (articles.length > 0) {
    lines.push("\n## 今日要闻标题");
    for (const a of articles.slice(0, 5)) lines.push(`- ${a.title}`);
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error("脚本执行失败:", err);
  process.exit(1);
});
