"""金融市场晨报 - 图表生成脚本
从 market-data.json 读取数据，生成三张图表 PNG。
在 GitHub Actions 中运行: python charts/generate_charts.py
"""
import json, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

CHARTS_DIR = os.path.dirname(os.path.abspath(__file__))

# 中文字体设置
plt.rcParams.update({
    "figure.figsize": (10, 6),
    "figure.dpi": 150,
    "font.size": 11,
    "axes.titlesize": 14,
    "axes.titleweight": "bold",
    "axes.labelsize": 11,
    "xtick.labelsize": 9,
    "ytick.labelsize": 10,
    "legend.fontsize": 10,
    "figure.titlesize": 16,
})

# 尝试设置中文字体
for font in ["SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC", "DejaVu Sans"]:
    try:
        plt.rcParams["font.sans-serif"] = [font, "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
        break
    except Exception:
        continue

# 配色
RED = "#C44E52"
GREEN = "#55A868"
BLUE = "#4C72B0"
ORANGE = "#DD8452"
GRAY = "#8C8C8C"

def load_data():
    """加载市场数据 JSON"""
    data_path = "market-data.json"
    if not os.path.exists(data_path):
        print(f"错误: 找不到 {data_path}，请先运行 node morning-report.js --fetch")
        sys.exit(1)
    with open(data_path, "r", encoding="utf-8") as f:
        return json.load(f)


def chart_index_performance(indices):
    """A股指数表现 - 水平条形图"""
    names = [i["name"] for i in indices]
    pcts = [i["changePct"] for i in indices]
    colors = [RED if p < 0 else GREEN for p in pcts]

    fig, ax = plt.subplots(figsize=(10, 5))
    bars = ax.barh(names, pcts, color=colors, edgecolor="white", height=0.6)

    for bar, pct in zip(bars, pcts):
        x = bar.get_width()
        label = f"{pct:+.2f}%"
        ax.text(x + 0.1 if x >= 0 else x - 0.1, bar.get_y() + bar.get_height() / 2,
                label, ha="left" if x >= 0 else "right", va="center", fontsize=10)

    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_title("A股主要指数涨跌幅", fontweight="bold")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.xaxis.set_major_formatter(mticker.FormatStrFormatter("%+.1f%%"))
    plt.tight_layout()
    fig.savefig(os.path.join(CHARTS_DIR, "index_performance.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ index_performance.png")


def chart_market_breadth(breadth):
    """市场涨跌分布 - 环形图"""
    up, down, flat = breadth["up"], breadth["down"], breadth["flat"]
    total = up + down + flat
    if total == 0:
        print("  ⚠ 市场宽度数据为空，跳过 market_breadth.png")
        return

    labels = [f"上涨 {up}家\n({up/total*100:.0f}%)",
              f"下跌 {down}家\n({down/total*100:.0f}%)",
              f"平盘 {flat}家\n({flat/total*100:.0f}%)"]
    sizes = [up, down, flat]
    colors_pie = [RED, GREEN, GRAY]

    fig, ax = plt.subplots(figsize=(6, 6))
    wedges, texts = ax.pie(sizes, labels=labels, colors=colors_pie,
                           startangle=90, textprops={"fontsize": 11})

    # 中心圆 → 环形图
    centre = plt.Circle((0, 0), 0.55, fc="white")
    ax.add_artist(centre)
    ax.text(0, 0, f"共{total}家", ha="center", va="center", fontsize=14, fontweight="bold")

    ax.set_title("A股市场涨跌分布", fontweight="bold")
    plt.tight_layout()
    fig.savefig(os.path.join(CHARTS_DIR, "market_breadth.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ market_breadth.png")


def chart_sector_heatmap(sectors):
    """板块热力图 - 水平条形图（涨跌前10）"""
    if not sectors or (not sectors.get("top3") and not sectors.get("bottom3")):
        print("  ⚠ 板块数据为空，跳过 sector_heatmap.png")
        return

    # 由于 market-data.json 只保存了 top3/bottom3，我们做一个简洁的对比图
    top = sectors.get("top3", [])
    bottom = sectors.get("bottom3", [])

    all_items = list(reversed(bottom)) + list(reversed(top))
    names = [s["name"] for s in all_items]
    pcts = [s["changePct"] for s in all_items]
    colors = [GREEN if p > 0 else RED for p in pcts]

    fig, ax = plt.subplots(figsize=(8, 4))
    bars = ax.barh(names, pcts, color=colors, edgecolor="white", height=0.55)

    for bar, pct in zip(bars, pcts):
        x = bar.get_width()
        label = f"{pct:+.2f}%"
        ax.text(x + 0.05 if x >= 0 else x - 0.05, bar.get_y() + bar.get_height() / 2,
                label, ha="left" if x >= 0 else "right", va="center", fontsize=10)

    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_title("行业板块涨跌排行", fontweight="bold")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    fig.savefig(os.path.join(CHARTS_DIR, "sector_heatmap.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ sector_heatmap.png")


def main():
    print("[图表] 生成市场可视化图表...")
    data = load_data()
    indices = data.get("indices", [])
    breadth = data.get("breadth", {})
    sectors = data.get("sectors", {})

    chart_index_performance(indices)
    chart_market_breadth(breadth)
    chart_sector_heatmap(sectors)
    print("[图表] 完成")


if __name__ == "__main__":
    main()
