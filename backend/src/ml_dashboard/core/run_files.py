import io
import os
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Optional, TextIO

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


class LimitedReader(io.RawIOBase):
    def __init__(self, file: BinaryIO, limit: int, name: str):
        # 読んだ大きさを数え, 上限を超えたら止める (開いた後に伸びた場合)
        self.file = file
        self.limit = limit
        self.name = name
        self.total = 0

    def readable(self) -> bool:
        """
        読めるかを返す関数

        Parameters
        ----------
        None

        Returns
        ----------
        readable: bool
            常に True
        """
        return True

    def readinto(self, buffer: memoryview) -> int:  # type: ignore[override]
        """
        上限を超えない範囲で読む関数

        Parameters
        ----------
        buffer: memoryview
            読んだ中身を入れる場所

        Returns
        ----------
        count: int
            読んだ大きさ

        Raises
        ----------
        RunFileError
            読んだ大きさが上限を超えた場合
        """
        data = self.file.read(len(buffer))
        self.total += len(data)
        if self.total > self.limit:
            raise RunFileError(f"大きすぎるので読みません: {self.name}")
        count = len(data)
        buffer[:count] = data

        return count


@contextmanager
def open_plain_text(
    path: Path, limit: int, encoding: str = "utf-8"
) -> Iterator[TextIO]:
    """
    普通のファイルを, 上限の大きさまで文字として少しずつ読むために開く関数

    中身を 1 つの文字列にせずに行ごとに読めるので, 大きな CSV でも記憶を
    使わない. 読めない文字は置き換え, 改行はそのまま渡す (csv のため)

    Parameters
    ----------
    path: Path
        ファイルのパス
    limit: int
        大きさの上限 (バイト). 開いた後に伸びて超えた場合も読むのを止める
    encoding: str = "utf-8"
        文字の符号化

    Returns
    ----------
    file: TextIO
        開いたファイル (抜けると閉じる)

    Raises
    ----------
    RunFileError
        リンク, 普通のファイルでない, 上限を超える場合
    OSError
        無いか読めない場合
    """
    with open_plain(path, limit) as raw:
        reader = io.BufferedReader(LimitedReader(raw, limit, path.name))
        text = io.TextIOWrapper(
            reader, encoding=encoding, errors="replace", newline=""
        )
        try:
            yield text
        finally:
            text.detach()


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
    ファイルを, 新しい普通のファイルとして置き換える関数

    同じディレクトリの一時ファイルに書き終えてから os.replace で置く. 先に
    あるもの (リンク, FIFO, 普通のファイル) は開かずに名前ごと置き換わる
    ので, リンクの先や, ハードリンクで共有した外の中身を書き換えない. 書き
    終えてから置くので, 読む側が書きかけ (空) のファイルを読むこともない

    Parameters
    ----------
    path: Path
        置くファイルのパス
    content: bytes
        書く中身

    Returns
    ----------
    None

    Raises
    ----------
    OSError
        ディレクトリがあるなど, 置けない場合 (一時ファイルは消す)
    """
    fd, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(content)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
