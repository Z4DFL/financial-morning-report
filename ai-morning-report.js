// AI 行业晨报 v1 — 多信源聚合 + 大事件识别 + 微信推送
// 每天早上 9:00 通过 cron-job.org 触发 → GitHub Action → Server酱 → 微信
// 数据源: 量子位 / 新浪科技 / IT之家 / 雷峰网
// 用法: node ai-morning-report.js           → 完整流程（抓取 + 生成 + 推送）
//       node ai-morning-report.js --fetch   → 仅抓取，保存 ai-data.json 与报告
//       node ai-morning-report.js --report  → 从 ai-data.json 读取，生成并推送
//       node ai-morning-report.js --dry     → 生成报告但不推送

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SENDKEY = process.env.SENDKEY || "";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
const TZ = "Asia/Shanghai";

// ═══════════════════════════════════════════════════════════════
// HTTP 工具
// ═══════════════════════════════════════════════════════════════

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i === retries) throw err;
      console.log(`请求失败 (${err.name === "AbortError" ? "超时" : err.message})，重试 ${i + 1}/${retries}...`);
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 信源配置
// ═══════════════════════════════════════════════════════════════

const SINA_TECH_LID = 2515; // 新浪滚动·科技

const RSS_SOURCES = [
  { name: "量子位", url: "https://www.qbitai.com/feed", weight: 5, limit: 15 },
  { name: "雷峰网", url: "https://www.leiphone.com/feed", weight: 4, limit: 20 },
  { name: "爱范儿", url: "https://www.ifanr.com/feed", weight: 4, limit: 20 },
  { name: "钛媒体", url: "https://www.tmtpost.com/rss.xml", weight: 3, limit: 20 },
  { name: "极客公园", url: "https://www.geekpark.net/rss", weight: 3, limit: 20 },
  { name: "IT之家", url: "https://www.ithome.com/rss/", weight: 3, limit: 30 },
];

// ═══════════════════════════════════════════════════════════════
// 关键词
// ═══════════════════════════════════════════════════════════════

// 强 AI 词：命中才算 AI 新闻
const STRONG_AI = /(人工智能|大模型|大语言模型|生成式|AIGC|AGI|智能体|Agent|多模态|算力|GPU|NPU|英伟达|NVIDIA|OpenAI|Anthropic|Claude|ChatGPT|GPT|Gemini|Perplexity|Copilot|Cursor|Midjourney|Stable Diffusion|DeepSeek|通义|千问|Qwen|Kimi|豆包|文心|混元|Llama|Sora|具身|人形机器人|机器人|自动驾驶|智驾|机器学习|深度学习|神经网络|智算|AI芯片|算力芯片|AI眼镜|AI手机|AI PC|AI编程|AI搜索|AI视频|AI医疗|AI修图|推理模型|推理|Token|大装置|向量数据库|RAG|微调|Transformer|MCP|HBM|光模块|服务器|数据中心|端侧模型|预训练|强化学习|数据集|Robotaxi|文生图|文生视频)/i;

// 仅在标题里出现的弱词，用于辅助（不单独认定）
const WEAK_AI = /(?<![A-Za-z])AI(?![A-Za-z])|人工智能/i;

// 明显不是 AI 行业的话题，避免误收
const OFF_TOPIC = /(量子计算|量子比特|量子芯片|量子通信|光量子|门锁|鼠标|键盘|耳机|路由器|充电器|插座|冰箱|空调|洗衣机|扫地机|汽车销量|手机销量|楼市|房价|网球|足球|电影票房)/;

// 早报/盘点类合集：信息密度高但不算单条事件
const ROUNDUP = /(早报|早知道|晚报|午报|简报|周报|日报|盘点|速览|一览|汇总|集锦|一周要闻)/;

// 事件性词汇：出现才算“大事”
const EVENT_WORDS = /(发布|推出|上线|开源|融资|收购|并购|上市|IPO|裁员|禁令|监管|处罚|起诉|合作|签约|突破|首次|停服|关停|涨价|降价|中标|量产|交付|获批|备案|接入|升级|对标|开源|破亿|亿元|亿美元|亿美金)/;

// 观点/活动类噪声：演讲、论坛、专访尽量不进头部
const FLUFF_WORDS = /(演讲|致辞|专访|对话|圆桌|论坛|峰会|大会|沙龙|开幕|出席|呼吁|建言|获奖|评选|开幕|举办)/;

// 纯市场噪声
const NOISE_WORDS = /(涨停|跌停|一字板|连板|股价|概念股|ETF|基金净值|龙虎榜|游资|解禁)/;

// 标题党
const CLICKBAIT = /(震惊|刚刚|突发|重磅|速看|不看后悔|惊呆了|出大事|炸裂|疯传|史诗级|必读|赶紧|马上|揭秘|内幕|真相|竟然|想不到|注意了|定了|官宣了|终于|别错过|逆天|看呆了|说中了|太突然)/;

// ═══════════════════════════════════════════════════════════════
// 采集：新浪科技滚动
// ═══════════════════════════════════════════════════════════════

async function fetchSinaTech() {
  try {
    const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${SINA_TECH_LID}&k=&num=100&page=1`;
    const res = await fetchWithRetry(url, {
      headers: { Referer: "https://news.sina.com.cn/roll/", "User-Agent": UA },
    });
    const json = await res.json();
    return (json.result?.data ?? []).map((a) => ({
      title: (a.title || "").trim(),
      url: a.url || "",
      time: new Date(parseInt(a.ctime, 10) * 1000),
      intro: (a.intro || "").trim(),
      source: (a.media_name || "新浪科技").trim(),
      weight: 4,
    }));
  } catch (e) {
    console.log("  新浪科技获取失败:", e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// 采集：RSS
// ═══════════════════════════════════════════════════════════════

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&");
}

function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? stripHtml(m[1]) : "";
}

function parseRss(xml) {
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  return items.map((it) => {
    const link = pickTag(it, "link") || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const desc = pickTag(it, "description");
    return {
      title: pickTag(it, "title"),
      url: link,
      time: new Date(pickTag(it, "pubDate") || Date.now()),
      intro: desc.slice(0, 160),
      source: "",
      weight: 0,
    };
  }).filter((x) => x.title && x.url && !isNaN(x.time.getTime()));
}

async function fetchRss(cfg) {
  try {
    const res = await fetchWithRetry(cfg.url, { headers: { "User-Agent": UA } });
    const xml = await res.text();
    const items = parseRss(xml).slice(0, cfg.limit);
    return items.map((x) => ({ ...x, source: cfg.name, weight: cfg.weight }));
  } catch (e) {
    console.log(`  ${cfg.name} 获取失败:`, e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// 清洗、去重、打分
// ═══════════════════════════════════════════════════════════════

function normalizeTitle(t) {
  return (t || "").replace(/^[^：]{2,14}：/, "").replace(/[\s\p{P}]/gu, "").toLowerCase();
}

const VERTICAL_SOURCES = new Set(["量子位", "雷峰网"]);

function isAINews(x) {
  const title = x.title || "";
  const intro = x.intro || "";
  if (STRONG_AI.test(title)) return true;
  if (WEAK_AI.test(title) && STRONG_AI.test(intro)) return true;
  // 垂直 AI 媒体的稿子：标题没点名、正文明确讲 AI 也收
  if (VERTICAL_SOURCES.has(x.source) && STRONG_AI.test(intro)) return true;
  return false;
}

const EVENT_STRONG = /(发布|推出|上线|开源|融资|收购|并购|签约|中标|量产|交付|获批|禁令|监管|处罚|起诉|裁员|停服|涨价|降价)/;

function isFluff(x) {
  if (FLUFF_WORDS.test(x.title)) return true;
  const intro = x.intro || "";
  const meeting = /(出席|演讲|致辞|圆桌|对话|论坛|峰会|大会|沙龙)/.test(intro);
  // 会议发言稿：正文是会议场景，标题里又没有实打实的动作
  if (meeting && !EVENT_STRONG.test(x.title)) return true;
  return false;
}

function cleanIntro(s) {
  return (s || "")
    .replace(/^IT之家\s*\d+\s*月\s*\d+\s*日消息\s*[，,、]?\s*/, "")
    .replace(/^新浪科技讯\s*/, "")
    .replace(/^证券日报网讯\s*/, "")
    .replace(/^每经AI快讯\s*[，,]?\s*/, "")
    .replace(/^财联社\s*\d+\s*月\s*\d+\s*日讯\s*[（(][^）)]*[）)]\s*/, "")
    .replace(/作者\s*[丨|｜][\s\S]{0,30}?编辑\s*[丨|｜][\s\S]{0,8}?(?=[，。]|最近|日前|近日|昨天|今日|随着)/, "")
    .replace(/[（(]IT之家注[：:][\s\S]*?[）)]/g, "")
    .replace(/[（(]现汇率约合[\s\S]*?[）)]/g, "")
    .replace(/[（(]约合[\s\S]{0,20}?元人民币[）)]/g, "")
    .replace(/^[◎●]\s*记者\s*(?:[^\s，。]{2,4}\s*){1,2}[，,]?\s*/, "")
    .replace(/#?欢迎关注[^#]*$/g, "")
    .replace(/更多精彩内容[^#]*$/g, "")
    .replace(/[（(]微信号[：:][^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, n = 110) {
  const t = (s || "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const m = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return (m > 40 ? cut.slice(0, m + 1) : cut) + "…";
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function similar(a, b) {
  if (!a || !b) return false;
  if (a.slice(0, 12) === b.slice(0, 12)) return true;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size) > 0.62;
}

function dedupe(items) {
  const kept = [];
  const norms = [];
  for (const it of items) {
    const n = normalizeTitle(it.title);
    if (norms.some((k) => similar(n, k))) continue;
    norms.push(n);
    kept.push(it);
  }
  return kept;
}

function scoreItem(it, now) {
  const t = it.title;
  const hours = (now - it.time) / 3600000;
  let score = it.weight * 2;

  if (EVENT_WORDS.test(t)) score += 6;
  if (STRONG_AI.test(t)) score += 4;
  if (/(开源|融资|收购|发布|监管|禁令|量产|交付|IPO)/.test(t)) score += 3;

  if (hours <= 6) score += 4;
  else if (hours <= 12) score += 2;
  else if (hours > 36) score -= 4;

  if (FLUFF_WORDS.test(t)) score -= 8;
  if (NOISE_WORDS.test(t)) score -= 10;
  if (t.length > 40) score -= 2;
  if (t.length < 8) score -= 3;

  return Math.round(score * 10) / 10;
}

const CATEGORIES = [
  { name: "政策与监管", re: /(监管|政策|法案|合规|备案|标准|治理|禁令|诉讼|版权|伦理|出口管制|安全审查)/ },
  { name: "资本与并购", re: /(融资|IPO|上市|收购|并购|估值|投资|轮融资|独角兽|亿美元|亿元)/ },
  { name: "算力与芯片", re: /(芯片|GPU|NPU|算力|数据中心|英伟达|NVIDIA|AMD|英特尔|昇腾|寒武纪|壁仞|摩尔线程|HBM|存储|光模块|服务器|液冷)/ },
  { name: "模型与产品", re: /(大模型|模型|发布|推出|上线|开源|智能体|Agent|多模态|生成式|AIGC|Claude|GPT|Gemini|DeepSeek|Qwen|Kimi|豆包|文心|混元|Llama|Sora|视频生成|语音)/ },
  { name: "应用与落地", re: /(落地|应用|机器人|具身|自动驾驶|智驾|医疗|教育|金融|制造|工厂|客服|编程|办公|电商|广告|短剧|游戏)/ },
  { name: "研究前沿", re: /(论文|研究|实验|突破|登顶|榜单|评测|基准|Nature|Science|arXiv|图灵)/ },
];

function classify(it) {
  for (const c of CATEGORIES) if (c.re.test(it.title)) return c.name;
  return "其他动态";
}

// 早报/合集：把标题里的各条拆成独立条目，避免一条顶十条
function splitRoundupTitle(x) {
  const m = x.title.match(/^[【\[][^】\]]{2,10}[】\]]\s*([\s\S]*)$/);
  const body = m ? m[1] : x.title;
  return body
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10)
    .map((s) => ({
      ...x,
      title: s.replace(/^[0-9]+[.、]\s*/, "").replace(/[。；;]$/, ""),
      fromRoundup: true,
      weight: Math.max(1, x.weight - 1),
    }));
}

function expandRoundups(items) {
  const out = [];
  const briefs = [];
  for (const x of items) {
    if (!ROUNDUP.test(x.title)) {
      out.push(x);
      continue;
    }
    const parts = splitRoundupTitle(x);
    if (parts.length >= 2) out.push(...parts);
    briefs.push(x);
  }
  return { items: out, briefs: briefs.slice(0, 2) };
}

async function collect() {
  console.log("[1/3] 抓取信源...");
  const [sina, ...rss] = await Promise.all([
    fetchSinaTech(),
    ...RSS_SOURCES.map((cfg) => fetchRss(cfg)),
  ]);
  const raw = [...sina, ...rss.flat()];
  const { items: expanded, briefs } = expandRoundups(raw);
  const all = expanded;
  console.log(`  原始条目: ${raw.length}（新浪 ${sina.length} / RSS ${raw.length - sina.length} ；合集拆条后 ${all.length}）`);

  const now = Date.now();
  const st = { total: all.length, ai: 0, fresh: 0, clean: 0 };
  const DEBUG = !!process.env.DEBUG;
  const filtered = [];
  for (const x of all) {
    if (!x.title || !x.url) continue;
    if (!isAINews(x)) { if (DEBUG) console.log("  SKIP(非AI)", x.source, "|", x.title); continue; }
    st.ai++;
    if (now - x.time.getTime() > 48 * 3600000) { if (DEBUG) console.log("  SKIP(过期)", x.title); continue; }
    st.fresh++;
    if (CLICKBAIT.test(x.title) || NOISE_WORDS.test(x.title) || OFF_TOPIC.test(x.title) || ROUNDUP.test(x.title) || isFluff(x)) {
      if (DEBUG) console.log("  SKIP(质量)", x.source, "|", x.title);
      continue;
    }
    st.clean++;
    filtered.push({ ...x, intro: cleanIntro(x.intro), score: scoreItem(x, now), category: classify(x) });
  }
  const unique = dedupe(filtered.sort((a, b) => b.score - a.score));
  console.log(`  原始 ${st.total} → AI相关 ${st.ai} → 48h内 ${st.fresh} → 质量过滤 ${st.clean} → 去重 ${unique.length}`);
  return { items: unique, briefs };
}

// ═══════════════════════════════════════════════════════════════
// 选稿：大事件 + 分类要闻
// ═══════════════════════════════════════════════════════════════

const MAX_EVENTS = 3;
const MAX_PER_CATEGORY = 4;
const MAX_TOTAL = 20;

function select(items) {
  const sorted = [...items].sort((a, b) => b.score - a.score || b.time - a.time);

  const events = sorted
    .filter((x) => EVENT_WORDS.test(x.title) && !FLUFF_WORDS.test(x.title))
    .slice(0, MAX_EVENTS);

  const used = new Set(events.map((x) => x.url));
  const byCat = {};
  for (const it of sorted) {
    if (used.has(it.url)) continue;
    const cat = it.category;
    if (cat === "其他动态") continue;
    byCat[cat] = byCat[cat] || [];
    if (byCat[cat].length >= MAX_PER_CATEGORY) continue;
    byCat[cat].push(it);
    used.add(it.url);
    if (used.size >= MAX_TOTAL) break;
  }
  return { events, byCat, total: used.size };
}

// ═══════════════════════════════════════════════════════════════
// 格式化
// ═══════════════════════════════════════════════════════════════

function fmtTime(d) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

function fmtDate(d) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, year: "numeric", month: "long", day: "numeric", weekday: "long",
  }).format(d);
}

function oneLine(it) {
  const intro = clip(it.intro, 110);
  return `**${it.title}** — ${it.source} · ${fmtTime(it.time)}\n   ${intro ? `> ${intro}\n   ` : ""}[原文](${it.url})`;
}

// —— 兜底：AI 不可用时的“影响”模板句 ——
function fallbackImpact(it) {
  const t = it.title;
  if (/(收购|并购|融资|IPO|上市|估值|亿美元|亿元)/.test(t)) return "资本动作，关注交易对价与后续整合。";
  if (/(政策|监管|草案|备案|标准|禁令|法案)/.test(t)) return "政策信号，关注落地口径与时间表。";
  if (/(开源|发布|推出|上线|量产|交付|突破)/.test(t)) return "产品与技术进展，关注落地节奏。";
  return "";
}

// —— AI 编辑层：关键词、综述、逐条“影响” ——
async function aiEnhance(events, byCat) {
  if (!AI_API_KEY) {
    console.log("  未配置 AI_API_KEY，使用模板句兜底");
    return null;
  }

  const ordered = [...events, ...CATEGORIES.flatMap((c) => byCat[c.name] || [])];
  if (!ordered.length) return null;

  const list = ordered
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.intro ? ` ／ ${clip(it.intro, 70)}` : ""}`)
    .join("\n");

  const prompt = `你是中文 AI 行业媒体的资深编辑，读者是证券从业者。
下面是今天筛出的 ${ordered.length} 条 AI 新闻（编号、来源、标题、摘要）：

${list}

请只输出一个 JSON 对象（不要 markdown 代码块，不要任何解释），格式：
{"keywords":["不超过6字","...","..."],"overview":"100-140字","impacts":[{"id":1,"impact":"20-40字"}]}

要求：
1. keywords 给 3 个，概括今天 AI 圈的主线（如“算力阵营松动”“资本退潮”）；
2. overview 说清今天最重要的三条主线并给判断，不要复述标题；
3. impacts 必须覆盖 1 到 ${ordered.length} 每一条，不得遗漏；
4. impact 要具体（公司、环节、金额、后续看什么），不要“值得关注”“意义重大”这类空话；
5. 赛事、软文、纯观点稿，impact 写“参考价值有限”；
6. 摘要中的数字若与常识明显不符，impact 以“⚠️ 存疑：”开头说明。`;

  try {
    const res = await fetchWithRetry(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content || "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("返回内容不是 JSON");
    const parsed = JSON.parse(text.slice(start, end + 1));

    const impacts = new Map();
    for (const entry of parsed?.impacts ?? []) {
      const id = Number(entry?.id);
      if (Number.isFinite(id)) impacts.set(id, String(entry.impact || "").trim());
    }
    ordered.forEach((it, i) => {
      it.impact = impacts.get(i + 1) || fallbackImpact(it);
    });

    console.log(`  AI 编辑: 关键词 ${(parsed?.keywords ?? []).length} 个 / 影响 ${impacts.size} 条`);
    return {
      keywords: (parsed?.keywords ?? []).filter(Boolean).slice(0, 3).map((k) => String(k).slice(0, 12)),
      overview: String(parsed?.overview || "").trim(),
    };
  } catch (e) {
    console.log("  AI 编辑失败，改用模板句:", e.message);
    ordered.forEach((it) => {
      if (!it.impact) it.impact = fallbackImpact(it);
    });
    return null;
  }
}

function eventBlock(it, i) {
  const lines = [`**${i + 1}｜${it.title}**`];
  if (it.intro) lines.push(`事件：${clip(it.intro, 90)}`);
  if (it.impact) lines.push(`影响：${it.impact}`);
  lines.push(`来源：[${it.source} ${fmtTime(it.time)}](${it.url})`);
  return lines.join("\n");
}

function briefBlock(it) {
  const head = it.title ? `**${clip(it.title, 40)}**` : "";
  return `- ${head}——${clip(it.intro, 60) || "见原文"}\n  [${it.source} ${fmtTime(it.time)}](${it.url})`;
}

function formatReport({ events, byCat, total, brief, ai }, nowDate) {
  let md = `# AI 行业晨报\n\n**${fmtDate(nowDate)}** · 共 ${total} 条\n\n`;

  if (ai?.overview) md += `> **今日看点**\n> ${ai.overview}\n\n`;
  if (ai?.keywords?.length) md += `关键词：${ai.keywords.join(" · ")}\n\n`;

  if (events.length) {
    md += `## 今日大事件\n\n`;
    md += events.map((it, i) => eventBlock(it, i)).join("\n\n") + "\n\n";
  }

  for (const c of CATEGORIES) {
    const list = byCat[c.name];
    if (!list || !list.length) continue;
    md += `## ${c.name}\n\n`;
    for (const it of list) {
      md += `- **${it.title}**${it.impact ? `——${it.impact}` : ""}\n  [${it.source} ${fmtTime(it.time)}](${it.url})\n\n`;
    }
  }

  if (brief?.length) {
    md += `## 行业简报\n\n`;
    for (const it of brief) md += briefBlock(it) + "\n\n";
  }

  md += `\n---\n*信源: ${["新浪科技", ...RSS_SOURCES.map((s) => s.name)].join(" · ")} | 生成于 ${new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(nowDate)}*`;
  return md;
}

// ═══════════════════════════════════════════════════════════════
// 推送
// ═══════════════════════════════════════════════════════════════

async function sendRaw(title, desp) {
  if (!SENDKEY) throw new Error("未配置 SENDKEY，无法推送");
  const url = `https://sctapi.ftqq.com/${SENDKEY}.send`;
  const body = new URLSearchParams({ title, desp });
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const result = await res.json();
  if (result.code !== 0) throw new Error(`Server酱返回: ${JSON.stringify(result)}`);
  return result;
}

async function sendNotification(title, content) {
  await sendRaw(title, content);
  console.log("晨报已发送到微信");
}

// 失败兜底：脚本任何环节出错，用同一个 server 酱通道推一条告警
async function notifyFailure(err) {
  console.error("脚本执行失败:", err.message);
  if (!SENDKEY) {
    console.error("（未配置 SENDKEY，无法发送失败告警）");
    return;
  }
  const now = new Date();
  const when = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  try {
    await sendRaw(
      `⚠️ AI 晨报生成失败 - ${when}`,
      `**执行出错**：${err.message}\n\n时间：${when}\n\n[查看 Actions 日志](https://github.com/Z4DFL/financial-morning-report/actions)`,
    );
    console.log("失败告警已发送");
  } catch (e) {
    console.error("失败告警发送失败:", e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════

function todayStr(d = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replace(/\//g, "-");
}

async function main() {
  const mode = process.argv[2] || "";
  const now = new Date();

  if (mode === "--test-alert") {
    await sendRaw("AI 晨报告警通道测试", "这是一条测试告警：如果你收到它，说明失败兜底通道可用。");
    console.log("告警通道测试已发送");
    return;
  }

  let payload;
  if (mode === "--report") {
    if (!existsSync("ai-data.json")) {
      throw new Error("未找到 ai-data.json，请先运行 --fetch");
    }
    payload = JSON.parse(readFileSync("ai-data.json", "utf-8"));
    console.log("[报告生成模式] 读取 ai-data.json");
  } else {
    console.log("=== AI 行业晨报 v1 ===\n");
    const { items, briefs } = await collect();
    if (!items.length) {
      throw new Error("未采集到任何 AI 相关新闻（可能是信源全部不可用）");
    }
    const picked = select(items);
    console.log(`[2/3] 选稿: 大事件 ${picked.events.length} 条 / 分类 ${Object.keys(picked.byCat).length} 组 / 共 ${picked.total} 条`);

    console.log("[3/3] AI 编辑...");
    const ai = await aiEnhance(picked.events, picked.byCat);
    if (!ai) {
      picked.events.forEach((it) => { if (!it.impact) it.impact = fallbackImpact(it); });
      for (const list of Object.values(picked.byCat)) {
        list.forEach((it) => { if (!it.impact) it.impact = fallbackImpact(it); });
      }
    }

    payload = { items, briefs, ...picked, ai, generatedAt: now.toISOString() };
    writeFileSync("ai-data.json", JSON.stringify(payload, null, 2), "utf-8");
  }

  const report = formatReport(payload, now);
  const file = `ai-morning-report-${todayStr(now)}.md`;
  writeFileSync(file, report, "utf-8");
  console.log(`[4/4] 已保存 ${file}（${report.length} 字）`);

  if (mode === "--dry" || mode === "--fetch") {
    console.log("（未推送）");
    return;
  }

  await sendNotification(`AI 行业晨报 - ${new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "long", day: "numeric" }).format(now)}`, report);
}

main().catch(async (err) => {
  await notifyFailure(err);
  process.exit(1);
});
