import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Optional

# 実験のディレクトリのファイルを画面が自分で読み書きする共通の関数.
# リンクを辿って実験の外を読み書きせず, FIFO などで止まらず, 大きなファイルで
# 記憶を使い切らないため

# ファイルごとの読む大きさの上限 (バイト)
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_YAML_BYTES = 4 * 1024 * 1024
MAX_CSV_BYTES = 128 * 1024 * 1024
MAX_LOG_BYTES = 64 * 1024 * 1024

# リンクを辿らず (O_NOFOLLOW) 待たずに (O_NONBLOCK) 読む旗. 旗の無い環境では 0
READ_FLAGS = (
    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
)

# 新しい普通のファイルとして作る旗 (既にあれば作らない)
CREATE_FLAGS = (
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
)

# 作り直すときに, 消した後に別のものが置かれた場合に試す回数
CREATE_RETRIES = 3


class RunFileError(OSError):
    # 読まないファイル (リンク, 普通でないファイル, 大きすぎるファイル).
    # OSError の仲間なので, 読めないファイルと同じに扱える
    pass


def plain_stat(path: Path) -> Optional[os.stat_result]:
    """
    リンクを辿らずに, 普通のファイルの情報を返す関数

    Parameters
    ----------
    path: Path
        ファイルのパス

    Returns
    ----------
    info: Optional[os.stat_result]
        ファイルの情報. 無いか, リンクか, 普通のファイルでない場合は None
    """
    try:
        info = path.lstat()
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None

    return info


@contextmanager
def open_plain(path: Path, limit: Optional[int]) -> Iterator[BinaryIO]:
    """
    普通のファイルを, リンクを辿らず待たずに開く関数

    確かめてから開くまでにリンクや FIFO に置き換えられても外を読まず止まら
    ないように, O_NOFOLLOW と O_NONBLOCK で開き, 開いたものを fstat で
    確かめる. O_NOFOLLOW の無い環境では, lstat で確かめたファイルと開いた
    ファイルが同じかも比べる

    Parameters
    ----------
    path: Path
        ファイルのパス
    limit: Optional[int]
        大きさの上限 (バイト), None の場合は確かめない (末尾だけを読む場合)

    Returns
    ----------
    file: BinaryIO
        開いたファイル (抜けると閉じる)

    Raises
    ----------
    RunFileError
        リンク, 普通のファイルでない, 上限を超える場合
    OSError
        無いか開けない場合
    """
    # O_NOFOLLOW の無い環境は, 開く前に lstat で確かめた先を覚えておく
    expected: Optional[tuple[int, int]] = None
    if not hasattr(os, "O_NOFOLLOW"):
        link_stat = path.lstat()
        if not stat.S_ISREG(link_stat.st_mode):
            raise RunFileError(f"普通のファイルではありません: {path.name}")
        expected = (link_stat.st_dev, link_stat.st_ino)
    try:
        fd = os.open(path, READ_FLAGS)
    except OSError as error:
        # リンクを O_NOFOLLOW で開くと ELOOP (macOS などは EMLINK も)
        if path.is_symlink():
            raise RunFileError(
                f"シンボリックリンクは読みません: {path.name}"
            ) from error
        raise

    # 開いたものが普通のファイルで, 上限の中か
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (
            expected is not None
            and (opened.st_dev, opened.st_ino) != expected
        ):
            raise RunFileError(f"普通のファイルではありません: {path.name}")
        if limit is not None and opened.st_size > limit:
            raise RunFileError(
                f"大きすぎるので読みません ({opened.st_size} バイト, 上限 "
                f"{limit} バイト): {path.name}"
            )
        # 普通のファイルは待たないので, 以後は普通に読む
        os.set_blocking(fd, True)
        file = os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise
    with file:
        yield file


def read_plain(path: Path, limit: int) -> bytes:
    """
    普通のファイルを, 上限の大きさまで読む関数

    Parameters
    ----------
    path: Path
        ファイルのパス
    limit: int
        大きさの上限 (バイト)

    Returns
    ----------
    content: bytes
        中身

    Raises
    ----------
    RunFileError
        リンク, 普通のファイルでない, 上限を超える (開いた後に伸びた場合も)
    OSError
        無いか読めない場合
    """
    with open_plain(path, limit) as file:
        content = file.read(limit + 1)
    if len(content) > limit:
        raise RunFileError(f"大きすぎるので読みません: {path.name}")

    return content


def read_plain_text(
    path: Path, limit: int, encoding: str = "utf-8"
) -> str:
    """
    普通のファイルを, 上限の大きさまで文字として読む関数

    Parameters
    ----------
    path: Path
        ファイルのパス
    limit: int
        大きさの上限 (バイト)
    encoding: str = "utf-8"
        文字の符号化 (読めない文字は置き換える)

    Returns
    ----------
    text: str
        中身

    Raises
    ----------
    RunFileError
        リンク, 普通のファイルでない, 上限を超える場合
    OSError
        無いか読めない場合
    """
    text = read_plain(path, limit).decode(encoding, errors="replace")

    return text


def replace_with_plain(path: Path, content: bytes) -> None:
    """
    ファイルを, 新しい普通のファイルとして作り直す関数

    先にあるもの (リンク, FIFO, 普通のファイル) は開かずに種類を見て消して
    から, 既にあれば作らない形 (O_EXCL) で作る. リンクの先や, 他の場所と
    ハードリンクで共有した中身を書き換えないため

    Parameters
    ----------
    path: Path
        作るファイルのパス
    content: bytes
        書く中身

    Returns
    ----------
    None

    Raises
    ----------
    OSError
        ディレクトリがあるなど, 消せないか作れない場合
    """
    for attempt in range(CREATE_RETRIES):
        # 先にあるものは開かずに消す (ディレクトリは消さずに誤り)
        try:
            info = path.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            if stat.S_ISDIR(info.st_mode):
                raise IsADirectoryError(f"ディレクトリがあります: {path}")
            try:
                path.unlink()
            except FileNotFoundError:
                pass

        # 消した後に別のものが置かれた場合は, もう一度消してから作る
        try:
            fd = os.open(path, CREATE_FLAGS, 0o644)
        except FileExistsError:
            if attempt == CREATE_RETRIES - 1:
                raise
            continue
        with os.fdopen(fd, "wb") as file:
            file.write(content)
        return
