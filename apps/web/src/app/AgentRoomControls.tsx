import { useRef, useState } from "react";
import { ChevronDown, MoreHorizontal, Plus, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { AgentRoom, AgentRoomSearchResult } from "../lib/types";
import "./agent-room-lifecycle.css";

type Props = {
  rooms: AgentRoom[];
  room: AgentRoom;
  onSelect: (roomId: string, aroundSequence?: number) => void;
};

type FormMode = "create" | "rename" | "archive" | "reset" | null;

export function AgentRoomControls({ rooms, room, onSelect }: Props) {
  const queryClient = useQueryClient();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [roomTab, setRoomTab] = useState<"active" | "archived">("active");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [name, setName] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"current" | "all" | "archived">("current");
  const [searchHistory, setSearchHistory] = useState(false);
  const [searchResults, setSearchResults] = useState<AgentRoomSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const switcherButtonRef = useRef<HTMLButtonElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const formReturnRef = useRef<HTMLButtonElement | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["agent-room", "rooms"] });
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const restoreFocus = (target: HTMLButtonElement | null) => globalThis.requestAnimationFrame(() => target?.focus());
  const closeForm = () => {
    setFormMode(null);
    setName("");
    setError("");
    restoreFocus(formReturnRef.current);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    restoreFocus(searchButtonRef.current);
  };
  const openForm = (mode: Exclude<FormMode, null>) => {
    formReturnRef.current = mode === "create" ? switcherButtonRef.current : actionsButtonRef.current;
    setActionsOpen(false);
    setSwitcherOpen(false);
    setName(mode === "rename" ? room.name : "");
    setError("");
    setFormMode(mode);
  };

  const submitName = (event: React.FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    void run(async () => {
      if (formMode === "create") {
        const created = await api.agentRoomCreate(value);
        await refresh();
        closeForm();
        onSelect(created.result.room.id);
      } else if (formMode === "rename") {
        await api.agentRoomRename(room.id, value);
        await refresh();
        closeForm();
      }
    });
  };

  const lifecycle = (mode: "archive" | "reset") => {
    void run(async () => {
      if (mode === "archive") await api.agentRoomArchive(room.id);
      else await api.agentRoomReset(room.id);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ["agent-room", room.id, "messages"] });
      closeForm();
    });
  };

  const restore = (target: AgentRoom) => {
    void run(async () => {
      await api.agentRoomRestore(target.id);
      await refresh();
      setRoomTab("active");
      setSwitcherOpen(false);
      onSelect(target.id);
    });
  };

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    void run(async () => {
      const response = await api.agentRoomSearch({
        query: searchQuery.trim(),
        scope: searchScope,
        roomId: searchScope === "current" ? room.id : undefined,
        history: searchHistory,
      });
      setSearchResults(response.result.results);
      setSearched(true);
    });
  };

  const visibleRooms = rooms.filter((candidate) => candidate.status === roomTab);

  return (
    <div className="flr-room__controls" onKeyDown={(event) => {
      if (event.key === "Tab" && (searchOpen || formMode)) {
        const modal = event.currentTarget.querySelector<HTMLElement>(".flr-room__modal");
        const focusable = modal
          ? [...modal.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")]
          : [];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      if (formMode) closeForm();
      else if (searchOpen) closeSearch();
      else if (switcherOpen) { setSwitcherOpen(false); restoreFocus(switcherButtonRef.current); }
      else if (actionsOpen) { setActionsOpen(false); restoreFocus(actionsButtonRef.current); }
      else return;
      event.stopPropagation();
    }}>
      <button
        ref={switcherButtonRef}
        className="flr-room__room-switch"
        type="button"
        aria-label={`Switch room, current: ${room.name}`}
        aria-expanded={switcherOpen}
        aria-haspopup="dialog"
        aria-controls="agent-room-switcher"
        onClick={() => { setSwitcherOpen((value) => !value); setActionsOpen(false); }}
      >
        <span>{room.name}</span><ChevronDown size={14} aria-hidden />
      </button>
      <button ref={searchButtonRef} className="flr-room__control" type="button" aria-label="Search rooms" aria-haspopup="dialog" aria-controls="agent-room-search" onClick={() => { setSearchOpen(true); setSearchResults([]); setSearched(false); setError(""); setActionsOpen(false); setSwitcherOpen(false); }}>
        <Search size={15} aria-hidden />
      </button>
      <button ref={actionsButtonRef} className="flr-room__control" type="button" aria-label="Room actions" aria-expanded={actionsOpen} aria-haspopup="menu" aria-controls="agent-room-actions" onClick={() => { setActionsOpen((value) => !value); setSwitcherOpen(false); }}>
        <MoreHorizontal size={16} aria-hidden />
      </button>

      {switcherOpen && (
        <div id="agent-room-switcher" className="flr-room__popover flr-room__switcher" role="dialog" aria-label="Room switcher">
          <div className="flr-room__popover-head">
            <div className="flr-room__tabs" aria-label="Room status">
              <button type="button" aria-pressed={roomTab === "active"} onClick={() => setRoomTab("active")}>Active</button>
              <button type="button" aria-pressed={roomTab === "archived"} onClick={() => setRoomTab("archived")}>Archived</button>
            </div>
            {roomTab === "active" && <button type="button" onClick={() => openForm("create")}><Plus size={13} aria-hidden /> New room</button>}
          </div>
          <div className="flr-room__room-list">
            {visibleRooms.length === 0 && <p>No {roomTab} rooms.</p>}
            {visibleRooms.map((candidate) => (
              <div className="flr-room__room-row" key={candidate.id}>
                <button type="button" className={candidate.id === room.id ? "is-current" : ""} onClick={() => { setSwitcherOpen(false); onSelect(candidate.id); }}>
                  <span>{candidate.name}</span>
                  <small>{candidate.unread_mentions ? `${candidate.unread_mentions} mention${candidate.unread_mentions === 1 ? "" : "s"}` : candidate.unread_count ? `${candidate.unread_count} unread` : candidate.status}</small>
                </button>
                {candidate.status === "archived" && <button type="button" aria-label={`Restore ${candidate.name}`} onClick={() => restore(candidate)}>Restore</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {actionsOpen && (
        <div id="agent-room-actions" className="flr-room__menu" role="menu">
          {room.status === "active" ? <>
            <button role="menuitem" type="button" onClick={() => openForm("rename")}>Rename room</button>
            <button role="menuitem" type="button" onClick={() => openForm("reset")}>Start fresh</button>
            <button role="menuitem" type="button" onClick={() => openForm("archive")}>Archive room</button>
          </> : <button role="menuitem" type="button" onClick={() => restore(room)}>Restore room</button>}
        </div>
      )}

      {(formMode === "create" || formMode === "rename") && (
        <div className="flr-room__modal" role="dialog" aria-modal="true" aria-label={formMode === "create" ? "Create room" : "Rename room"} onKeyDown={(event) => { if (event.key === "Escape") closeForm(); }}>
          <form onSubmit={submitName}>
            <h3>{formMode === "create" ? "Create room" : "Rename room"}</h3>
            <label>Room name<input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
            {error && <p role="alert">{error}</p>}
            <div><button type="button" onClick={closeForm}>Cancel</button><button type="submit" disabled={busy || !name.trim()}>{formMode === "create" ? "Create" : "Save"}</button></div>
          </form>
        </div>
      )}

      {(formMode === "archive" || formMode === "reset") && (
        <div className="flr-room__modal" role="dialog" aria-modal="true" aria-label={formMode === "archive" ? "Archive room" : "Start fresh"} onKeyDown={(event) => { if (event.key === "Escape") closeForm(); }}>
          <div>
            <h3>{formMode === "archive" ? "Archive room" : "Start fresh"}</h3>
            <p>{formMode === "archive" ? "This room becomes read-only and stays searchable until restored." : "Earlier history remains searchable and viewable. New messages start with a clean working transcript."}</p>
            {error && <p role="alert">{error}</p>}
            <div><button type="button" onClick={closeForm}>Cancel</button><button type="button" disabled={busy} onClick={() => lifecycle(formMode)}>{formMode === "archive" ? "Archive" : "Start fresh"}</button></div>
          </div>
        </div>
      )}

      {searchOpen && (
        <div id="agent-room-search" className="flr-room__modal flr-room__search" role="dialog" aria-modal="true" aria-label="Search rooms">
          <form onSubmit={search}>
            <div className="flr-room__search-head"><h3>Search rooms</h3><button type="button" onClick={closeSearch}>Close</button></div>
            <label>Search messages<input autoFocus value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearched(false); }} /></label>
            <label>Search scope<select value={searchScope} onChange={(event) => setSearchScope(event.target.value as typeof searchScope)}><option value="current">Current room</option><option value="all">All active rooms</option><option value="archived">Archived rooms</option></select></label>
            <label className="flr-room__check"><input type="checkbox" checked={searchHistory} onChange={(event) => setSearchHistory(event.target.checked)} /> Include earlier history</label>
            <button type="submit" disabled={busy || !searchQuery.trim()}>Search</button>
            {error && <p role="alert">{error}</p>}
          </form>
          <div className="flr-room__search-results" aria-live="polite">
            {searchResults.map((result) => (
              <button key={result.id} type="button" aria-label={`${result.room_name}: ${result.body}`} onClick={() => { setSearchOpen(false); onSelect(result.room_id, result.sequence); }}>
                <strong>{result.room_name}</strong><span>#{result.sequence}{result.earlier ? " · earlier history" : ""}</span><p>{result.snippet}</p>
              </button>
            ))}
            {searched && !busy && searchResults.length === 0 && <p>No matching messages.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
