from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"


def _text(relative: str) -> str:
    return (ROOT / relative).read_text()


def test_optional_agent_room_product_code_is_not_owned_by_protoagent_core():
    for relative in (
        "apps/web/src/app/AgentRoomMode.tsx",
        "apps/web/src/app/AgentRoomMode.test.ts",
        "apps/web/src/app/AgentRoomControls.tsx",
        "apps/web/src/app/agent-room-lifecycle.css",
    ):
        assert not (ROOT / relative).exists(), f"Agent Room plugin code remains in core: {relative}"

    forbidden_by_file = {
        "apps/web/src/app/App.tsx": ("RoomsSurface", 'case "rooms"'),
        "apps/web/src/app/coreSurfaces.tsx": ('id: "rooms"', "MessagesSquare"),
        "apps/web/src/app/FleetRoom.tsx": ("AgentRoom", "agentRoom", "canonical shared Room"),
        "apps/web/src/app/fleet-room.css": (".flr--agent-room", ".flr-room__"),
        "apps/web/src/lib/api.ts": ("AgentRoom", "agentRoomList", "/api/plugins/agent-room"),
        "apps/web/src/lib/types.ts": ("export type AgentRoom", "AgentRoomMember", "AgentRoomMessage"),
        "apps/web/e2e/fleet.spec.ts": ("x-e2e-agent-room", "/api/plugins/agent-room"),
        "apps/web/e2e/mock-server.mjs": ("x-e2e-agent-room", "/api/plugins/agent-room"),
    }
    for relative, tokens in forbidden_by_file.items():
        source = _text(relative)
        for token in tokens:
            assert token not in source, f"Agent Room token {token!r} remains in core file {relative}"


def test_generic_plugin_view_host_remains_the_only_rooms_ui_seam():
    app = _text("apps/web/src/app/App.tsx")
    plugin_view = _text("apps/web/src/app/PluginView.tsx")
    guide = _text("docs/guides/building-react-plugin-views.md")

    assert "allPluginViews" in app
    assert "<PluginView" in app
    assert "protoagent:init" in plugin_view
    assert "apiFetch" in guide
    assert "No host build, no shared bundle" in guide
