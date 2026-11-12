import re
from pathlib import Path
from typing import Optional

from ml_dashboard.core.models import EnvSection, LogEntry

# ML-Found の既定のログの書式
DEFAULT_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

# 書式の項目ごとに当てはめる正規表現
FIELD_PATTERNS = {
    "asctime": r"(?P<asctime>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d{3})?)",
    "levelname": r"(?P<levelname>DEBUG|INFO|WARNING|ERROR|CRITICAL)",
    "message": r"(?P<message>.*)"
}

# 書式の中の %(name)s のような項目
FIELD = re.compile(r"%\((\w+)\)[-#0 +]*\d*(?:\.\d+)?[sdfr]")

# 環境の情報として表示する節の見出し
ENV_TITLES = {
    "プロジェクトの git 情報:": "Project git",
    "ML-Found の情報:": "ML-Found",
    "OS の情報:": "OS",
    "PyTorch の情報:": "PyTorch"
}

# エポックごとの指標のログ (ML-Found の Trainer が書く形)
EPOCH_LINE = re.compile(r"^エポック (\d+): (.*)$")


def build_pattern(log_format: str) -> Optional[re.Pattern[str]]:
    """
    ログの書式から 1 行目を見分ける正規表現を作る関数

    Parameters
    ----------
    log_format: str
        logging の書式 (experiment.log_format)

    Returns
    ----------
    pattern: Optional[re.Pattern[str]]
        正規表現, レベルとメッセージを含まない書式の場合は None
    """
    # 項目の外は文字どおりに一致させ, 項目は種類ごとの正規表現に置き換え
    parts = []
    position = 0
    names = []
    for match in FIELD.finditer(log_format):
        parts.append(re.escape(log_format[position:match.start()]))
        name = match.group(1)
        names.append(name)
        parts.append(FIELD_PATTERNS.get(name, r".*?"))
        position = match.end()
    parts.append(re.escape(log_format[position:]))

    # レベルとメッセージが無い書式では記録を分けられない
    if "levelname" not in names or "message" not in names:
        return None
    pattern = re.compile("^" + "".join(parts) + "$")

    return pattern


def parse_log(
    path: Path, log_format: str = DEFAULT_FORMAT
) -> list[LogEntry]:
    """
    train.log を記録ごとに分ける関数

    Parameters
    ----------
    path: Path
        train.log のパス
    log_format: str = DEFAULT_FORMAT
        logging の書式 (experiment.log_format)

    Returns
    ----------
    entries: list[LogEntry]
        時刻, レベル, メッセージの記録, 書式が違う行はレベル無しの記録
    """
    if not path.is_file():
        return []

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    pattern = build_pattern(log_format)

    # 書式に合う行が 1 つも無い場合は 1 行ずつの記録として扱い
    if pattern is None or not any(pattern.match(line) for line in lines):
        entries = [
            LogEntry(time=None, level=None, message=line) for line in lines
        ]
        return entries

    # 書式に合う行で新しい記録を始め, 合わない行は直前の記録に追加
    entries = []
    for line in lines:
        match = pattern.match(line)
        if match:
            groups = match.groupdict()
            entries.append(
                LogEntry(
                    time=groups.get("asctime"), level=groups["levelname"],
                    message=groups["message"]
                )
            )
        elif entries:
            entries[-1].message += "\n" + line
        else:
            entries.append(LogEntry(time=None, level=None, message=line))

    # 末尾の空行の除去
    for entry in entries:
        entry.message = entry.message.rstrip()

    return entries


def find_message(entries: list[LogEntry], prefix: str) -> Optional[str]:
    """
    指定した書き出しの最後のメッセージの続きを取得する関数

    Parameters
    ----------
    entries: list[LogEntry]
        ログの記録
    prefix: str
        メッセージの書き出し

    Returns
    ----------
    rest: Optional[str]
        書き出しより後ろの文字列, 無い場合は None
    """
    rest = None
    for entry in entries:
        if entry.message.startswith(prefix):
            rest = entry.message[len(prefix):].strip()

    return rest


def parse_number(text: Optional[str]) -> Optional[float]:
    """
    文字列の先頭の数値を取り出す関数

    Parameters
    ----------
    text: Optional[str]
        数値で始まる文字列

    Returns
    ----------
    value: Optional[float]
        取り出した数値, 無い場合は None
    """
    if text is None:
        return None

    match = re.match(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", text)
    value = float(match.group(0)) if match else None

    return value


def parse_items(body: str, separator: str) -> dict[str, str]:
    """
    節の本文を項目名と値に分ける関数

    Parameters
    ----------
    body: str
        節の本文
    separator: str
        項目名と値の区切り

    Returns
    ----------
    items: dict[str, str]
        項目名と値
    """
    items = {}
    for line in body.splitlines():
        line = line.strip()
        if separator not in line:
            continue
        key, value = line.split(separator, 1)
        items[key.strip()] = value.strip()

    return items


def parse_env(entries: list[LogEntry]) -> list[EnvSection]:
    """
    ログから実験環境の情報を取り出す関数

    Parameters
    ----------
    entries: list[LogEntry]
        ログの記録

    Returns
    ----------
    sections: list[EnvSection]
        git, ML-Found, OS, PyTorch の情報
    """
    sections = []
    for entry in entries:
        head, _, body = entry.message.partition("\n")
        title = ENV_TITLES.get(head.strip())
        if title is not None:
            sections.append(
                EnvSection(title=title, items=parse_items(body, ": "))
            )

    return sections


def parse_packages(entries: list[LogEntry]) -> dict[str, str]:
    """
    ログからパッケージの一覧を取り出す関数

    Parameters
    ----------
    entries: list[LogEntry]
        ログの記録

    Returns
    ----------
    packages: dict[str, str]
        パッケージ名と版
    """
    body = find_message(entries, "パッケージ一覧:")
    packages = parse_items(body, "==") if body else {}

    return packages


def parse_epoch_metrics(
    entries: list[LogEntry]
) -> list[dict[str, Optional[float]]]:
    """
    ログのエポックごとの指標から記録を作り直す関数

    Parameters
    ----------
    entries: list[LogEntry]
        ログの記録

    Returns
    ----------
    rows: list[dict[str, Optional[float]]]
        エポックと指標の値, history.csv が無い学習中や失敗した実験で使う
    """
    rows = []
    for entry in entries:
        match = EPOCH_LINE.match(entry.message)
        if match is None:
            continue
        row: dict[str, Optional[float]] = {"epoch": float(match.group(1))}
        for item in match.group(2).split(", "):
            key, _, value = item.partition("=")
            try:
                row[key.strip()] = float(value)
            except ValueError:
                row[key.strip()] = None
        rows.append(row)

    return rows
