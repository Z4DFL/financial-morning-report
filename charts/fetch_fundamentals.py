"""金融市场晨报 - 增强数据获取脚本
通过 Yahoo Finance 获取估值指标、VIX、美债收益率、加密货币等数据。
输出到 market-fundamentals.json，供 morning-report.js 读取。
"""
import json, sys
import yfinance as yf
import pandas as pd


def safe_get(info, key, default="—"):
    """安全获取 yfinance info 字段"""
    val = info.get(key)
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return default
    return val


def get_etf_fundamentals(ticker, name):
    """获取 ETF/指数的估值数据"""
    try:
        t = yf.Ticker(ticker)
        info = t.info
        return {
            "name": name,
            "ticker": ticker,
            "price": safe_get(info, "regularMarketPrice", safe_get(info, "previousClose")),
            "pe": safe_get(info, "trailingPE"),
            "forwardPE": safe_get(info, "forwardPE"),
            "pb": safe_get(info, "priceToBook"),
            "eps": safe_get(info, "trailingEps"),
            "fiftyDayAvg": safe_get(info, "fiftyDayAverage"),
            "twoHundredDayAvg": safe_get(info, "twoHundredDayAverage"),
            "marketCap": safe_get(info, "marketCap"),
            "ytdReturn": safe_get(info, "ytdReturn"),
        }
    except Exception as e:
        print(f"  ⚠ {ticker} ({name}): {e}")
        return None


def get_vix():
    """获取 VIX 恐慌指数"""
    try:
        t = yf.Ticker("^VIX")
        info = t.info
        price = safe_get(info, "regularMarketPrice", safe_get(info, "previousClose"))
        return {
            "name": "VIX 恐慌指数",
            "price": price,
            "fiftyDayAvg": safe_get(info, "fiftyDayAverage"),
        }
    except Exception as e:
        print(f"  ⚠ VIX: {e}")
        return None


def get_treasury_yield():
    """获取美国10年期国债收益率"""
    try:
        t = yf.Ticker("^TNX")
        info = t.info
        price = safe_get(info, "regularMarketPrice", safe_get(info, "previousClose"))
        return {
            "name": "美国10年国债",
            "ticker": "^TNX",
            "price": price,
            "label": "收益率" if price != "—" else "—",
        }
    except Exception as e:
        print(f"  ⚠ 美债: {e}")
        return None


def get_crypto():
    """获取主要加密货币价格"""
    result = []
    tickers = {
        "BTC-USD": "比特币",
        "ETH-USD": "以太坊",
    }
    for ticker, name in tickers.items():
        try:
            t = yf.Ticker(ticker)
            info = t.info
            price = safe_get(info, "regularMarketPrice", safe_get(info, "previousClose"))
            changePct = safe_get(info, "regularMarketChangePercent")
            result.append({
                "name": name,
                "ticker": ticker,
                "price": price,
                "changePct": changePct,
            })
        except Exception as e:
            print(f"  ⚠ {name}: {e}")
    return result


def main():
    print("[增强数据] 获取估值指标和全球市场数据...")

    fundamentals = []

    # 美股主要指数 ETF
    etfs = [
        ("SPY", "标普500 ETF"),
        ("QQQ", "纳斯达克100 ETF"),
        ("DIA", "道琼斯 ETF"),
        ("IWM", "罗素2000 ETF"),
    ]
    for ticker, name in etfs:
        data = get_etf_fundamentals(ticker, name)
        if data:
            fundamentals.append(data)
            print(f"  ✓ {name}")

    # VIX
    vix = get_vix()
    if vix:
        fundamentals.append(vix)
        print(f"  ✓ VIX")

    # 美债
    treasury = get_treasury_yield()
    if treasury:
        fundamentals.append(treasury)
        print(f"  ✓ 美债收益率")

    # 加密货币
    crypto = get_crypto()
    for c in crypto:
        print(f"  ✓ {c['name']}")

    output = {
        "fundamentals": fundamentals,
        "crypto": crypto,
    }

    with open("market-fundamentals.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=str)

    print(f"[增强数据] 已保存到 market-fundamentals.json ({len(fundamentals)} 项)")


if __name__ == "__main__":
    main()
