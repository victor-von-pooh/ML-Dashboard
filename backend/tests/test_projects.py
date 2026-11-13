from pathlib import Path

from ml_dashboard.core.projects import (
    default_config_for,
    experiment_config_for,
    find_projects,
    read_submodules,
)


def make_project(project: Path, defaults: list[str]) -> None:
    """
    default の config を持つプロジェクトを作る関数

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ
    defaults: list[str]
        configs/default に置く config の名前

    Returns
    ----------
    None
    """
    (project / "configs" / "default").mkdir(parents=True)
    (project / "configs" / "experiment").mkdir(parents=True)
    for name in ["train.yaml", *defaults]:
        (project / "configs" / "default" / name).write_text("{}\n")


def test_default_config_by_name(tmp_path: Path) -> None:
    """
    スクリプトの名前から default の config を選ぶ順序を確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    make_project(tmp_path, ["hf.yaml", "train_hf.yaml", "train_big.yaml"])
    default = tmp_path / "configs" / "default"

    assert default_config_for(tmp_path, None) == default / "train.yaml"
    assert default_config_for(tmp_path, "train.py") == default / "train.yaml"
    # hf.yaml と train_hf.yaml の両方がある場合は hf.yaml
    assert default_config_for(tmp_path, "train_hf.py") == default / "hf.yaml"
    assert (
        default_config_for(tmp_path, "train_big.py")
        == default / "train_big.yaml"
    )
    # train_ で始まらない名前と, train_ だけの名前は train.yaml
    (default / "trainer.yaml").write_text("{}\n")
    assert default_config_for(tmp_path, "trainer.py") == default / "train.yaml"
    assert default_config_for(tmp_path, "train_.py") == default / "train.yaml"


def test_default_config_from_script(tmp_path: Path) -> None:
    """
    スクリプトの本文に書かれた default の config を優先することを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    make_project(tmp_path, ["pinn.yaml", "other.yaml"])
    default = tmp_path / "configs" / "default"

    # 名前の規則では pinn.yaml だが, 本文は train.yaml を読む
    (tmp_path / "train_pinn.py").write_text(
        'load_config("configs/default/train.yaml", args.experiment)\n'
    )
    assert (
        default_config_for(tmp_path, "train_pinn.py") == default / "train.yaml"
    )

    # 本文で他の名前を読む場合は, 名前と関係なくその config
    (tmp_path / "train_x.py").write_text(
        'load_config(str(DIR / "configs/default/other.yaml"), path)\n'
    )
    assert default_config_for(tmp_path, "train_x.py") == default / "other.yaml"

    # 複数ある場合と, 無いファイルの場合は名前の規則
    (tmp_path / "train_pinn.py").write_text(
        '"configs/default/train.yaml" or "configs/default/other.yaml"\n'
    )
    assert (
        default_config_for(tmp_path, "train_pinn.py") == default / "pinn.yaml"
    )
    (tmp_path / "train_pinn.py").write_text('"configs/default/none.yaml"\n')
    assert (
        default_config_for(tmp_path, "train_pinn.py") == default / "pinn.yaml"
    )


def test_experiment_config_for(tmp_path: Path) -> None:
    """
    スクリプトの既定の experiment の config を選ぶことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    make_project(tmp_path, [])
    experiment = tmp_path / "configs" / "experiment"
    for name in ("train.yaml", "hf.yaml"):
        (experiment / name).write_text("{}\n")

    assert experiment_config_for(tmp_path, "train.py") == (
        "configs/experiment/train.yaml"
    )
    assert experiment_config_for(tmp_path, "train_hf.py") == (
        "configs/experiment/hf.yaml"
    )
    assert experiment_config_for(tmp_path, "train_pinn.py") == (
        "configs/experiment/train.yaml"
    )


def test_read_submodules(tmp_path: Path) -> None:
    """
    .gitmodules の書き方の違いを読めることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    assert read_submodules(tmp_path) == set()

    # 引用符, ./ の付いたパス, CRLF, 値の無い行
    (tmp_path / ".gitmodules").write_bytes(
        b'[submodule "a"]\r\n\tpath = "quoted"\r\n'
        b'[submodule "b"]\n\tpath = ./lib/b/\n'
        b'[submodule "c"]\n\tpath =\n\turl = https://example.com/c\n'
    )
    assert read_submodules(tmp_path) == {
        tmp_path / "quoted", tmp_path / "lib" / "b"
    }


def test_find_projects_skips_nested_submodule(tmp_path: Path) -> None:
    """
    深い場所の submodule の中のプロジェクトを探さないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    make_project(tmp_path / "tasks" / "a", [])
    make_project(tmp_path / "vendor" / "lib" / "example", [])
    (tmp_path / ".gitmodules").write_text(
        '[submodule "lib"]\n\tpath = vendor/lib\n'
    )

    assert find_projects(tmp_path) == [tmp_path / "tasks" / "a"]
