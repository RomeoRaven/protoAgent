from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "desktop-build.yml"


def test_tagged_desktop_build_refreshes_marketing_after_assets_are_live() -> None:
    """The public download page advances only after a complete desktop release."""
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    job = workflow["jobs"]["refresh-marketing"]

    assert set(job["needs"]) == {"build", "updater-manifest"}

    condition = job["if"]
    assert "always()" in condition
    assert "inputs.tag != ''" in condition
    assert "needs.build.result == 'success'" in condition
    assert "needs.updater-manifest.result == 'success'" in condition

    assert job["permissions"] == {"actions": "write", "contents": "read"}

    dispatch = job["steps"][0]
    assert dispatch["env"] == {"GH_TOKEN": "${{ github.token }}"}
    command = dispatch["run"]
    assert "gh workflow run marketing-deploy.yml" in command
    assert '--repo "${{ github.repository }}"' in command
    assert "--ref main" in command
