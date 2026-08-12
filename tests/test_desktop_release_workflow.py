from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "desktop-build.yml"


def test_tagged_desktop_build_refreshes_marketing_after_assets_are_live() -> None:
    """The public download page advances only after a complete desktop release."""
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    job = workflow["jobs"]["refresh-marketing"]

    assert set(job["needs"]) == {"build", "updater-manifest"}

    condition = " ".join(job["if"].split())
    assert condition == (
        "always() && "
        "inputs.tag != '' && "
        "github.repository == 'protoLabsAI/protoAgent' && "
        "needs.build.result == 'success' && "
        "needs.updater-manifest.result == 'success'"
    )

    assert job["permissions"] == {"actions": "write", "contents": "read"}

    dispatch = job["steps"][0]
    assert dispatch["env"] == {"GH_TOKEN": "${{ github.token }}"}
    command = dispatch["run"]
    assert "gh workflow run marketing-deploy.yml" in command
    assert '--repo "${{ github.repository }}"' in command
    assert "--ref main" in command
