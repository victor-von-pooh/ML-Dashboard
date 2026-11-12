from fastapi import APIRouter, Request

from ml_dashboard.api.routes import (
    NOT_FOUND,
    RUN_PATH,
    get_project,
    get_run_data,
)
from ml_dashboard.core.notes import NoteStore, RunNote

router = APIRouter(prefix="/api")


def get_notes(request: Request) -> NoteStore:
    """
    アプリに保存したメモの保存先を取得する関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    notes: NoteStore
        メモの保存先
    """
    notes: NoteStore = request.app.state.notes

    return notes


@router.get("/projects/{project_id}/notes", responses=NOT_FOUND)
def list_notes(request: Request, project_id: str) -> dict[str, RunNote]:
    """
    プロジェクトの実験のメモ, タグ, 星を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    notes: dict[str, RunNote]
        実験の ID ごとのメモ (書いた実験だけ)
    """
    project = get_project(request, project_id)
    notes = get_notes(request).load(project.id)

    return notes


@router.put(RUN_PATH + "/note", responses=NOT_FOUND)
def save_note(
    request: Request, project_id: str, name: str, date: str, time: str,
    body: RunNote
) -> RunNote:
    """
    実験のメモ, タグ, 星を保存する関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    name: str
        実験の名前
    date: str
        日付のディレクトリ名
    time: str
        時刻のディレクトリ名
    body: RunNote
        保存するメモ, 空にすると削除

    Returns
    ----------
    note: RunNote
        保存したメモ
    """
    # 実在する実験にだけ保存 (実験のディレクトリには書き込まない)
    get_run_data(request, project_id, name, date, time)
    note = get_notes(request).save(project_id, f"{name}/{date}/{time}", body)

    return note
