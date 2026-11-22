import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Optional

from omegaconf import DictConfig, ListConfig, OmegaConf

# config の中の環境変数の参照 (${oc.env:NAME} や ${oc.env:NAME,既定値}) の名前
ENV_NAME_PATTERN = re.compile(r"oc\.env\s*:\s*['\"]?\s*([A-Za-z_][\w.-]*)")

# 環境変数を引く値の代わりに置く印 (値の参照を辿った先の判定に使用)
ENV_MARK = "\x00ml_dashboard_env\x00"

# 語の途中でも消す値の長さの下限 (これより短い値は前後が英数字でない所だけ)
MIN_SUBSTRING_LENGTH = 4


def uses_env(value: Any) -> bool:
    """
    書いたままの値が環境変数の参照を含むかを判定する関数

    Parameters
    ----------
    value: Any
        config に書いたままの値

    Returns
    ----------
    found: bool
        ${...} の中に oc.env を含む文字列の場合は True
    """
    found = isinstance(value, str) and "${" in value and "oc.env" in value

    return found


def mask_env(node: Any) -> Any:
    """
    環境変数を参照する値を印に置き換える関数

    Parameters
    ----------
    node: Any
        書いたままの config (辞書, リスト, 値)

    Returns
    ----------
    masked: Any
        環境変数を参照する値を ENV_MARK にした config
    """
    if isinstance(node, dict):
        masked: Any = {key: mask_env(value) for key, value in node.items()}
    elif isinstance(node, list):
        masked = [mask_env(value) for value in node]
    else:
        masked = ENV_MARK if uses_env(node) else node

    return masked


def has_mark(value: Any) -> bool:
    """
    解決した値が環境変数の印を含むかを判定する関数

    Parameters
    ----------
    value: Any
        解決した値

    Returns
    ----------
    found: bool
        印を含む場合は True
    """
    if isinstance(value, dict):
        found = any(has_mark(item) for item in value.values())
    elif isinstance(value, list):
        found = any(has_mark(item) for item in value)
    else:
        found = isinstance(value, str) and ENV_MARK in value

    return found


def resolve_child(parent: Any, key: Any) -> Any:
    """
    config の子の値を, 値の参照を解決して取り出す関数

    Parameters
    ----------
    parent: Any
        親の DictConfig か ListConfig
    key: Any
        子のキーか番号

    Returns
    ----------
    value: Any
        解決した値 (辞書とリストは Python の型)
    """
    value = parent[key]
    if isinstance(value, (DictConfig, ListConfig)):
        value = OmegaConf.to_container(value, resolve=True)

    return value


def keep_env_refs(raw: Any, masked: Any, real: Any) -> Any:
    """
    環境変数を引く値を書いたままにし, 他の値を解決した config を作る関数

    Parameters
    ----------
    raw: Any
        書いたままの config (辞書かリスト)
    masked: Any
        環境変数を参照する値を印にした DictConfig か ListConfig
    real: Any
        学習に使う DictConfig か ListConfig

    Returns
    ----------
    kept: Any
        環境変数を引く値 (他の項目を介して引くものも) は書いたまま,
        他の値は解決した config
    """
    items = raw.items() if isinstance(raw, dict) else enumerate(raw)
    kept_items: list[tuple[Any, Any]] = []
    for key, value in items:
        if isinstance(value, (dict, list)):
            kept_items.append(
                (key, keep_env_refs(value, masked[key], real[key]))
            )
            continue
        if not isinstance(value, str) or "${" not in value:
            kept_items.append((key, value))
            continue

        # 印を辿る参照と, 印で解決できなくなる参照は書いたまま
        try:
            hidden = has_mark(resolve_child(masked, key))
            resolved = None if hidden else resolve_child(real, key)
        except Exception:
            hidden = True
        kept_items.append((key, value if hidden else resolved))
    kept: Any = (
        dict(kept_items) if isinstance(raw, dict)
        else [value for _, value in kept_items]
    )

    return kept


def config_without_env(cfg: DictConfig) -> dict[str, Any]:
    """
    環境変数の値を含まない, 画面に返す config を作る関数

    Parameters
    ----------
    cfg: DictConfig
        学習に使う config

    Returns
    ----------
    config: dict[str, Any]
        環境変数を引く値は書いたまま, 他の値は解決した config
    """
    raw = OmegaConf.to_container(cfg, resolve=False)
    if not isinstance(raw, dict):
        return {}
    masked = OmegaConf.create(mask_env(raw))
    kept = keep_env_refs(raw, masked, cfg)
    config = {str(key): value for key, value in kept.items()}

    return config


def flat_value(flat: dict[str, Any], key: str) -> tuple[bool, Any]:
    """
    . でつないだキーの値を, 親の項目が値の場合も含めて探す関数

    Parameters
    ----------
    flat: dict[str, Any]
        . でつないだキーと値の辞書
    key: str
        探すキー

    Returns
    ----------
    found: bool
        キーか親のキーがある場合は True
    value: Any
        見つけた値 (親のキーの場合は親の値), 無ければ None
    """
    parts = key.split(".")
    for end in range(len(parts), 0, -1):
        name = ".".join(parts[:end])
        if name in flat:
            return True, flat[name]

    return False, None


def diff_without_env(
    diff: dict[str, Any], default_flat: dict[str, Any],
    cfg_flat: dict[str, Any]
) -> dict[str, dict[str, object]]:
    """
    ML-Found の差分の値を, 環境変数の値を含まない値に置き換える関数

    Parameters
    ----------
    diff: dict[str, Any]
        ML-Found の get_diff の差分 (解決した値)
    default_flat: dict[str, Any]
        config_without_env で作った default の config を平らにしたもの
    cfg_flat: dict[str, Any]
        config_without_env で作った学習に使う config を平らにしたもの

    Returns
    ----------
    hidden: dict[str, dict[str, object]]
        変わった項目ごとの default の値と experiment の値
    """
    hidden: dict[str, dict[str, object]] = {}
    flats = (("default", default_flat), ("experiment", cfg_flat))
    for key, value in diff.items():
        sides: dict[str, object] = {}
        for side, flat in flats:
            found, kept = flat_value(flat, str(key))
            sides[side] = kept if found else value.get(side)
        hidden[str(key)] = sides

    return hidden


def env_replacements(
    texts: Iterable[str], environ: Optional[dict[str, str]] = None
) -> list[tuple[str, str]]:
    """
    文の中で消す環境変数の値と, 代わりに出す参照の組を作る関数

    Parameters
    ----------
    texts: Iterable[str]
        config に書いたままの文 (ファイルの中身)
    environ: Optional[dict[str, str]] = None
        環境変数, None の場合は今のプロセスのもの

    Returns
    ----------
    replacements: list[tuple[str, str]]
        値と ${oc.env:名前} の組 (長い値から)
    """
    environ = dict(os.environ) if environ is None else environ
    names = {
        name for text in texts for name in ENV_NAME_PATTERN.findall(text)
    }
    pairs = {
        (environ[name], f"${{oc.env:{name}}}")
        for name in names if environ.get(name)
    }
    replacements = sorted(pairs, key=lambda pair: (-len(pair[0]), pair[1]))

    return replacements


def read_texts(paths: Iterable[Path]) -> list[str]:
    """
    config のファイルの中身を, 読めるものだけ読む関数

    Parameters
    ----------
    paths: Iterable[Path]
        config のファイル

    Returns
    ----------
    texts: list[str]
        読めたファイルの中身
    """
    texts = []
    for path in paths:
        try:
            texts.append(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue

    return texts


def redact(text: str, replacements: list[tuple[str, str]]) -> str:
    """
    文の中の環境変数の値を, 参照の書き方に置き換える関数

    Parameters
    ----------
    text: str
        警告や誤りの文
    replacements: list[tuple[str, str]]
        env_replacements で作った値と参照の組

    Returns
    ----------
    redacted: str
        環境変数の値を ${oc.env:名前} にした文
    """
    if not replacements:
        return text

    # 短い値は語の一部 (10 の中の 1 など) を消さないように, 前後が英数字で
    # ない所だけを対象. 置き換えた参照の中を再び置き換えないように 1 回で置換
    shown = dict(replacements)
    pattern = "|".join(
        re.escape(value) if len(value) >= MIN_SUBSTRING_LENGTH
        else rf"(?<![0-9A-Za-z]){re.escape(value)}(?![0-9A-Za-z])"
        for value, _ in replacements
    )
    redacted = re.sub(pattern, lambda match: shown[match.group(0)], text)

    return redacted
