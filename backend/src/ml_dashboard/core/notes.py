import json
import os
import re
import tempfile
import threading
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

# メモとタグの大きさの上限
MAX_NOTE = 20_000
MAX_TAGS = 20
MAX_TAG = 40


class RunNote(BaseModel):
    note: str = Field(default="", max_length=MAX_NOTE)
    tags: list[str] = Field(default_factory=list, max_length=MAX_TAGS)
    starred: bool = False

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, tags: list[str]) -> list[str]:
        """
        タグの前後の空白を除き, 空と重複を除く関数

        Parameters
        ----------
        tags: list[str]
            送られたタグ

        Returns
        ----------
        cleaned: list[str]
            整えたタグ, 順は保持
        """
        cleaned: list[str] = []
        for tag in tags:
            value = re.sub(r"\s+", " ", tag).strip()
            if len(value) > MAX_TAG:
                raise ValueError(f"タグは {MAX_TAG} 文字までです: {value}")
            if value and value not in cleaned:
                cleaned.append(value)

        return cleaned

    def is_empty(self) -> bool:
        """
        何も書かれていないかを判定する関数

        Parameters
        ----------
        None

        Returns
        ----------
        empty: bool
            メモもタグも星も無いかどうか
        """
        empty = not self.note and not self.tags and not self.starred

        return empty


class NoteStore:
    def __init__(self, data_dir: Path):
        # プロジェクトごとのメモを置くディレクトリを保存
        self.notes_dir = data_dir / "notes"

        # 同時の書き込みで更新が失われないようにロックを用意
        self.lock = threading.Lock()

    def path(self, project_id: str) -> Path:
        """
        プロジェクトのメモのファイルを取得する関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID (英数字とハイフン)

        Returns
        ----------
        path: Path
            メモを保存するファイル
        """
        path = self.notes_dir / f"{project_id}.json"

        return path

    def load(self, project_id: str) -> dict[str, RunNote]:
        """
        プロジェクトの実験のメモを読み込む関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID

        Returns
        ----------
        notes: dict[str, RunNote]
            実験の ID ごとのメモ, 壊れた項目は除外
        """
        try:
            text = self.path(project_id).read_text(encoding="utf-8")
            data = json.loads(text)
        except (OSError, ValueError):
            return {}

        notes = {}
        for run_id, value in data.items() if isinstance(data, dict) else []:
            try:
                notes[str(run_id)] = RunNote.model_validate(value)
            except ValueError:
                continue

        return notes

    def save(self, project_id: str, run_id: str, note: RunNote) -> RunNote:
        """
        実験のメモを保存する関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID
        run_id: str
            実験の ID
        note: RunNote
            保存するメモ, 空の場合は削除

        Returns
        ----------
        note: RunNote
            保存したメモ
        """
        with self.lock:
            notes = self.load(project_id)
            if note.is_empty():
                notes.pop(run_id, None)
            else:
                notes[run_id] = note

            # 一時ファイルに書いてから置き換え, 書きかけを読まれないように設定
            self.notes_dir.mkdir(parents=True, exist_ok=True)
            text = json.dumps(
                {key: value.model_dump() for key, value in notes.items()},
                ensure_ascii=False, indent=2
            )
            with tempfile.NamedTemporaryFile(
                "w", dir=self.notes_dir, suffix=".tmp", delete=False,
                encoding="utf-8"
            ) as file:
                file.write(text)
            os.replace(file.name, self.path(project_id))

        return note
