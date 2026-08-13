from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "desktop-build.yml"
MARKETING_WORKFLOW = ROOT / ".github" / "workflows" / "marketing-deploy.yml"


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

    assert job["permissions"] == {"contents": "read"}
    assert job["uses"] == "./.github/workflows/marketing-deploy.yml"
    assert job["secrets"] == "inherit"
    assert "runs-on" not in job
    assert "steps" not in job

    marketing = yaml.safe_load(MARKETING_WORKFLOW.read_text(encoding="utf-8"))
    triggers = marketing.get("on") or marketing.get(True)
    assert "workflow_call" in triggers
