"""
CLAUDE.md の触れてよいリポジトリの一覧に無い名前を探すスクリプト

git の管理下のファイル (submodule の中は含まない) から, リポジトリの名前
らしい語で一覧に無いものを見つけたら, 場所を出して 1 で終わる
"""
import re
import subprocess
import sys
from pathlib import Path

# リポジトリの名前らしい語. 大文字の ML に - か _ が続く語と, 小文字の
# ml_ で始まるパッケージ名の形の語 (大文字小文字を区別する. 後ろに _ が
# 続く環境変数のような語は除く). 小文字の ml- は画面のクラス名 (ml-auto
# など) と取り違えないため探さない. 比べるときは名前の形をそろえる
REPO_NAME = r"\bML[-_][A-Za-z]+\b(?!_)|\bml_[a-z]+\b(?!_)"


def name_key(name: str) -> str:
    """
    リポジトリの名前を, 大文字小文字と - と _ の違いを除いた形にする関数

    Parameters
    ----------
    name: str
        名前

    Returns
    ----------
    key: str
        小文字で, - と _ を除いた形
    """
    # 小文字にして区切りを除く
    key = name.lower().replace("-", "").replace("_", "")

    return key


def allowed_repos(root: Path) -> set[str]:
    """
    CLAUDE.md の触れてよいリポジトリの一覧を読む関数

    Parameters
    ----------
    root: Path
        リポジトリのルート

    Returns
    ----------
    names: set[str]
        一覧のリポジトリの名前 (name_key の形)

    Raises
    ----------
    ValueError
        CLAUDE.md に一覧 (「(今は ...)」) が無い場合
    """
    # 「(今は A, B, ...)」の括弧の中
    text = (root / "CLAUDE.md").read_text(encoding="utf-8")
    found = re.search(r"\(今は ([^)]*)\)", text)
    if found is None:
        raise ValueError("CLAUDE.md にリポジトリの一覧がありません")
    names = {name_key(name.strip()) for name in found.group(1).split(",")}

    return names


def text_errors(root: Path, names: set[str]) -> list[str]:
    """
    管理下のファイルから一覧に無いリポジトリの名前を探す関数

    Parameters
    ----------
    root: Path
        リポジトリのルート
    names: set[str]
        触れてよいリポジトリの名前 (name_key の形)

    Returns
    ----------
    errors: list[str]
        見つけた場所と語
    """
    # git grep で当たった行 (バイナリと submodule の中は対象外)
    found = subprocess.run(
        ["git", "grep", "-n", "-I", "-P", REPO_NAME],
        cwd=root, capture_output=True, text=True, encoding="utf-8"
    )
    if found.returncode not in (0, 1):
        raise RuntimeError(found.stderr)

    # 行ごとの語を一覧の形とくらべた結果
    pattern = re.compile(REPO_NAME)
    errors = []
    for line in found.stdout.splitlines():
        place, number, text = line.split(":", 2)
        for word in pattern.findall(text):
            if name_key(word) not in names:
                errors.append(
                    f"{place}:{number}: 一覧に無いリポジトリ {word}"
                )

    return errors


def main() -> int:
    """
    一覧に無いリポジトリの名前を確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    code: int
        見つからなければ 0, あれば 1
    """
    # 一覧を読んで管理下のファイルとくらべた結果
    root = Path(__file__).resolve().parent.parent
    errors = text_errors(root, allowed_repos(root))
    for error in errors:
        print(error)
    code = 1 if errors else 0

    return code


if __name__ == "__main__":
    sys.exit(main())
