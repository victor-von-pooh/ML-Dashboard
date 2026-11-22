from omegaconf import OmegaConf

from ml_dashboard.core.env_refs import (
    config_without_env,
    env_replacements,
    redact,
)


def test_default_value() -> None:
    """
    既定値付きの参照の名前を拾い, 値を書いたままにすることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    text = "token: ${oc.env:TOKEN,fallback}\n"
    environ = {"TOKEN": "s3cr3t-value", "OTHER": "other-value"}
    assert env_replacements([text], environ=environ) == [
        ("s3cr3t-value", "${oc.env:TOKEN}")
    ]

    cfg = OmegaConf.create({
        "token": "${oc.env:ML_DASHBOARD_TEST_NONE,fallback}", "plain": 1
    })
    assert config_without_env(cfg) == {
        "token": "${oc.env:ML_DASHBOARD_TEST_NONE,fallback}", "plain": 1
    }


def test_name_from_reference() -> None:
    """
    名前を参照で決める場合は解決した config から名前を引き, 引けなければ
    全ての環境変数の値を消すことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    environ = {"TOKEN": "s3cr3t-value", "OTHER": "other-value"}
    text = "name: TOKEN\nvalue: ${oc.env:${name}}\n"
    cfg = OmegaConf.create(text)
    assert env_replacements([text], cfg, environ) == [
        ("s3cr3t-value", "${oc.env:TOKEN}")
    ]

    # config が無い場合と, 相対の参照で引けない場合は安全側に全て
    everything = [
        ("s3cr3t-value", "${oc.env:TOKEN}"),
        ("other-value", "${oc.env:OTHER}")
    ]
    assert env_replacements([text], None, environ) == everything
    relative = "data:\n  name: TOKEN\n  value: ${oc.env:${.name}}\n"
    assert env_replacements(
        [relative], OmegaConf.create(relative), environ
    ) == everything


def test_short_value() -> None:
    """
    短い値は前後が英数字でない所だけを置き換えることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    replacements = env_replacements(["n: ${oc.env:N}\n"], environ={"N": "1"})
    assert redact("epochs (1) と 10 と a1", replacements) == (
        "epochs (${oc.env:N}) と 10 と a1"
    )

    # 置き換えた参照の中は再び置き換えない
    replacements = [("long-secret", "${oc.env:A}"), ("A", "${oc.env:B}")]
    assert redact("long-secret A", replacements) == (
        "${oc.env:A} ${oc.env:B}"
    )


def test_special_characters() -> None:
    """
    正規表現の特殊な文字を含む値もそのままの文字で置き換えることを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    replacements = [("a.b*c(d", "${oc.env:A}"), ("+", "${oc.env:B}")]
    assert redact("x a.b*c(d y axbbc(d 1+2 +", replacements) == (
        "x ${oc.env:A} y axbbc(d 1+2 ${oc.env:B}"
    )


def test_missing_and_cycle() -> None:
    """
    必須の印 (???) と循環する参照があっても, 書いたままで返すことを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    cfg = OmegaConf.create({
        "required": "???", "a": "${b}", "b": "${a}",
        "to_missing": "${required}", "plain": "${value}", "value": 3
    })
    assert config_without_env(cfg) == {
        "required": "???", "a": "${b}", "b": "${a}",
        "to_missing": "${required}", "plain": 3, "value": 3
    }
