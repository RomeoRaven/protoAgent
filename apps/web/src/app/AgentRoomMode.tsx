import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { AgentRoom, AgentRoomMember, AgentRoomMention } from "../lib/types";

const ROOM_TOKEN = /(?<![^\s(\[{])@[^\s,;:!?()[\]{}]*/g;
const ALL_WAKEABLE: AgentRoomMember = {
  principal: "__all__",
  kind: "virtual",
  display_name: "All wakeable agents",
  role: "broadcast",
  mention_token: "@all",
  host: "room",
  can_post: false,
  can_mention: false,
  mentionable: true,
};

export function groupRoomMembers(members: AgentRoomMember[]) {
  return {
    wakeableAgents: members.filter((member) => member.kind === "agent" && member.mentionable),
    otherMembers: members.filter((member) => member.kind !== "agent" || !member.mentionable),
  };
}

export function getMemberAction(member: AgentRoomMember, roomStatus: string) {
  if (roomStatus === "archived") {
    return { canWake: false, label: null, state: "Room archived — wake-up unavailable" };
  }
  if (member.kind !== "agent" || !member.mentionable) {
    return { canWake: false, label: null, state: "Not configured for wake-up" };
  }
  return {
    canWake: true,
    label: `Wake ${member.mention_token}`,
    state: `Wake as ${member.mention_token}`,
  };
}

const profileList = (values: string[] | undefined, fallback: string) => {
  const listed = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return listed.length ? listed : [fallback];
};

export function buildMemberProfile(member: AgentRoomMember) {
  const profile = member.profile;
  return {
    purpose: profile?.summary.trim() || `${member.display_name} serves this room in the ${member.role} role.`,
    capabilities: profileList(profile?.capabilities, "No capabilities listed."),
    bestFor: profileList(profile?.best_for, "No best-fit work listed."),
    boundaries: profileList(profile?.boundaries, "No boundaries listed."),
    fallback: profile?.fallback.trim() || "No fallback guidance listed.",
    host: member.host,
    policy: [
      member.can_post ? "Can post to the room" : "Cannot post to the room",
      member.can_mention ? "Can mention room members" : "Cannot mention room members",
      member.kind === "agent" && member.mentionable
        ? `Wakeable as ${member.mention_token}`
        : "Not wakeable from this room",
    ],
  };
}

export function tokensIn(text: string, knownTokens: Iterable<string> = []): string[] {
  const known = new Map(Array.from(knownTokens, (token) => [token.toLocaleLowerCase(), token]));
  return Array.from(text.matchAll(ROOM_TOKEN), (match) => {
    let token = match[0];
    while (token.endsWith(".") && !known.has(token.toLocaleLowerCase())) token = token.slice(0, -1);
    return known.get(token.toLocaleLowerCase()) ?? token;
  });
}

export function insertExactMention(draft: string, mentionToken: string): string {
  const exact = tokensIn(draft, [mentionToken]).some(
    (token) => token.toLocaleLowerCase() === mentionToken.toLocaleLowerCase(),
  );
  if (exact) return draft;
  const prefix = draft.trimEnd();
  return `${prefix}${prefix ? " " : ""}${mentionToken} `;
}

function MemberProfileRow({
  member,
  roomStatus,
  onWake,
}: {
  member: AgentRoomMember;
  roomStatus: "active" | "archived";
  onWake: (member: AgentRoomMember) => void;
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const profile = buildMemberProfile(member);
  const action = getMemberAction(member, roomStatus);
  const tokenDiffers = member.mention_token.slice(1).toLocaleLowerCase() !== member.display_name.toLocaleLowerCase();
  const profileId = `room-member-profile-${member.principal.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const identity = (
    <span className="flr__who">
      <span className="flr__name">{member.display_name}</span>
      {tokenDiffers && <span className="flr-room__member-token">{member.mention_token}</span>}
      <span className="flr__meta">{member.role} · {member.host}</span>
      <span className="flr-room__member-state">{action.state}</span>
    </span>
  );

  return (
    <div className="flr-room__member-profile">
      <div className="flr__member flr-room__member-summary">
        {action.canWake ? (
          <button
            className="flr-room__member-action"
            type="button"
            aria-label={`Wake ${member.display_name} as ${member.mention_token}`}
            onClick={() => onWake(member)}
          >
            {identity}
          </button>
        ) : (
          <span className="flr-room__member-identity">{identity}</span>
        )}
        <button
          className="flr-room__profile-cue"
          type="button"
          aria-expanded={profileOpen}
          aria-controls={profileId}
          aria-label={`${profileOpen ? "Hide" : "Show"} ${member.display_name} profile`}
          onClick={() => setProfileOpen((current) => !current)}
        >
          Profile
        </button>
      </div>
      {profileOpen && <div id={profileId} className="flr-room__profile-body" role="region" aria-label={`${member.display_name} profile`}>
        <section className="flr-room__profile-purpose" aria-label="Purpose">
          <span>Purpose</span>
          <p>{profile.purpose}</p>
        </section>
        <div className="flr-room__profile-columns">
          <section>
            <h3>Capabilities</h3>
            <ul>{profile.capabilities.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section>
            <h3>Best for</h3>
            <ul>{profile.bestFor.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section>
            <h3>Boundaries</h3>
            <ul>{profile.boundaries.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        </div>
        <section className="flr-room__profile-fallback">
          <h3>Fallback</h3>
          <p>{profile.fallback}</p>
        </section>
        <dl className="flr-room__profile-policy">
          <div><dt>Host</dt><dd>{profile.host}</dd></div>
          <div><dt>Policy</dt><dd>{profile.policy.join(" · ")}</dd></div>
        </dl>
      </div>}
    </div>
  );
}

export function AgentRoomMode({
  room,
  fullHeight = false,
  controls,
  aroundSequence,
  onReturnLatest,
}: {
  room: AgentRoom;
  fullHeight?: boolean;
  controls?: ReactNode;
  aroundSequence?: number;
  onReturnLatest?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [suggestionsClosed, setSuggestionsClosed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const lifecycleAvailable = room.status != null;
  const roomStatus = room.status ?? "active";
  const messages = useInfiniteQuery({
    queryKey: ["agent-room", room.id, "messages", room.active_from_sequence ?? 1, history, aroundSequence ?? null],
    queryFn: ({ pageParam }) => api.agentRoomSync(room.id, !lifecycleAvailable
      ? { after: pageParam ?? 0, limit: 100 }
      : aroundSequence
        ? { around: aroundSequence, limit: 21, history: true }
        : { before: pageParam ?? undefined, limit: 50, history }),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => !lifecycleAvailable
      ? lastPage.result.has_more ? lastPage.result.next_sequence : undefined
      : !aroundSequence && lastPage.result.has_older
        ? lastPage.result.oldest_sequence ?? undefined
        : undefined,
    refetchInterval: 2_000,
  });
  const members = useQuery({
    queryKey: ["agent-room", room.id, "members"],
    queryFn: () => api.agentRoomMembers(room.id),
    refetchInterval: 15_000,
  });
  const ordered = useMemo(
    () => (messages.data?.pages.flatMap((page) => page.result.messages) ?? []).sort((a, b) => a.sequence - b.sequence),
    [messages.data],
  );
  const latestPage = messages.data?.pages[messages.data.pages.length - 1];
  const ownerOnline = latestPage?.result.owner_online ?? room.owner_online ?? true;
  const pendingPosts = latestPage?.result.pending_posts ?? [];
  const mentionsBySource = useMemo(() => {
    const grouped = new Map<string, AgentRoomMention[]>();
    for (const mention of messages.data?.pages.flatMap((page) => page.result.mentions ?? []) ?? []) {
      const current = grouped.get(mention.source_message_id) ?? [];
      current.push(mention);
      grouped.set(mention.source_message_id, current);
    }
    return grouped;
  }, [messages.data]);
  const names = useMemo(
    () => new Map((members.data?.result.members ?? []).map((member) => [member.principal, member.display_name])),
    [members.data],
  );
  const roomMembers = members.data?.result.members ?? [];
  const memberGroups = useMemo(() => groupRoomMembers(roomMembers), [roomMembers]);
  const mentionable = useMemo(() => roomMembers.filter((member) => member.mentionable), [roomMembers]);
  const memberTokens = useMemo(
    () => new Map([...roomMembers, ALL_WAKEABLE].map((member) => [member.mention_token.toLocaleLowerCase(), member])),
    [roomMembers],
  );
  const draftTokens = useMemo(() => tokensIn(draft, memberTokens.keys()), [draft, memberTokens]);
  const selectedMembers = useMemo(() => {
    if (draftTokens.some((token) => token.toLocaleLowerCase() === ALL_WAKEABLE.mention_token)) return mentionable;
    const byToken = new Map(mentionable.map((member) => [member.mention_token.toLocaleLowerCase(), member]));
    const seen = new Set<string>();
    return draftTokens.flatMap((token) => {
      const member = byToken.get(token.toLocaleLowerCase());
      if (!member || seen.has(member.principal)) return [];
      seen.add(member.principal);
      return [member];
    });
  }, [draftTokens, mentionable]);
  const invalidTokens = useMemo(
    () => draftTokens.filter((token) => !memberTokens.get(token.toLocaleLowerCase())?.mentionable),
    [draftTokens, memberTokens],
  );
  const mentionTrigger = useMemo(() => {
    const match = /(?<![^\s(\[{])@([^\s,;:!?()[\]{}]*)$/.exec(draft);
    if (!match) return null;
    const at = (match.index ?? 0) + match[0].lastIndexOf("@");
    return { start: at, query: match[1].toLocaleLowerCase() };
  }, [draft]);
  const suggestions = useMemo(() => {
    if (!mentionTrigger) return [];
    const selectedBeforeTrigger = new Set(
      tokensIn(draft.slice(0, mentionTrigger.start)).map((token) => token.toLocaleLowerCase()),
    );
    return [...mentionable, ALL_WAKEABLE].filter(
      (member) =>
        !selectedBeforeTrigger.has(member.mention_token.toLocaleLowerCase()) &&
        (member.display_name.toLocaleLowerCase().includes(mentionTrigger.query) ||
          member.mention_token.slice(1).toLocaleLowerCase().includes(mentionTrigger.query)),
    );
  }, [draft, mentionTrigger, mentionable]);
  const showSuggestions = Boolean(mentionTrigger && suggestions.length && !suggestionsClosed);
  const activeSuggestionIndex =
    activeSuggestion >= 0 && activeSuggestion < suggestions.length ? activeSuggestion : -1;
  const post = useMutation({
    mutationFn: (body: string) =>
      api.agentRoomPost(room.id, {
        client_message_id: globalThis.crypto?.randomUUID?.() ?? `room-${Date.now()}`,
        body,
      }),
    onSuccess: async () => {
      setDraft("");
      await messages.refetch();
      await queryClient.invalidateQueries({ queryKey: ["agent-room", "rooms"] });
    },
  });

  useEffect(() => { setHistory(false); setDraft(""); }, [room.id]);

  const latest = ordered.length ? ordered[ordered.length - 1].sequence : 0;
  useEffect(() => {
    if (!aroundSequence && latest > 0) {
      void api.agentRoomAck(room.id, latest)
        .then(() => queryClient.invalidateQueries({ queryKey: ["agent-room", "rooms"] }))
        .catch(() => {});
    }
  }, [aroundSequence, latest, queryClient, room.id]);

  useEffect(() => setActiveSuggestion(-1), [mentionTrigger?.start, mentionTrigger?.query]);
  useEffect(() => {
    if (!aroundSequence || !ordered.some((message) => message.sequence === aroundSequence)) return;
    globalThis.requestAnimationFrame(() => {
      roomRef.current?.querySelector<HTMLElement>(`[data-room-sequence="${aroundSequence}"]`)?.focus();
    });
  }, [aroundSequence, ordered]);

  const focusComposer = () => globalThis.requestAnimationFrame(() => inputRef.current?.focus());

  const loadOlder = async () => {
    const container = messagesRef.current;
    const anchor = container?.querySelector<HTMLElement>("[data-room-sequence]") ?? null;
    const beforeY = anchor?.getBoundingClientRect().top ?? 0;
    await messages.fetchNextPage();
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => {
      if (container && anchor) container.scrollTop += anchor.getBoundingClientRect().top - beforeY;
    }));
  };

  const insertMemberMention = (member: AgentRoomMember) => {
    setDraft((current) => insertExactMention(current, member.mention_token));
    setSuggestionsClosed(false);
    focusComposer();
  };

  const pickSuggestion = (member: AgentRoomMember) => {
    if (!mentionTrigger) return;
    setDraft((current) =>
      `${current.slice(0, mentionTrigger.start)}${member.mention_token} ${current.slice(mentionTrigger.start + mentionTrigger.query.length + 1)}`,
    );
    setSuggestionsClosed(false);
    focusComposer();
  };

  const recipientGuidance = invalidTokens.length
    ? `${memberTokens.has(invalidTokens[0].toLocaleLowerCase()) ? "Cannot notify" : "Unknown agent"} ${invalidTokens.join(", ")} — choose a suggested agent`
    : selectedMembers.length
      ? `Will notify ${selectedMembers.map((member) => member.display_name).join(", ")}`
      : "Post to room only — no agents notified";

  const submit = () => {
    const body = draft.trim();
    if (body && !post.isPending && invalidTokens.length === 0) post.mutate(body);
  };

  return (
    <div ref={roomRef} className={`flr flr--agent-room${fullHeight ? " flr--full-height" : ""}`}>
      <div className="flr__cols">
        <div className="flr__col flr__roster">
          <div className="flr__colhead">
            <h2>Members</h2>
            <span className="flr__count">{members.data?.result.members.length ?? 0}</span>
          </div>
          <div className="flr__list" role="list" aria-label="Room members">
            <section className="flr-room__member-group" aria-labelledby="wakeable-agent-members">
              <h3 id="wakeable-agent-members">
                <span>Wakeable agents</span>
                <span>{memberGroups.wakeableAgents.length}</span>
              </h3>
              {memberGroups.wakeableAgents.length ? (
                <div role="presentation">
                  {memberGroups.wakeableAgents.map((member) => (
                    <div key={member.principal} role="listitem">
                      <MemberProfileRow member={member} roomStatus={roomStatus} onWake={insertMemberMention} />
                    </div>
                  ))}
                </div>
              ) : <p className="flr-room__member-empty">No agents can be woken from this room.</p>}
            </section>
            <section className="flr-room__member-group" aria-labelledby="other-room-members">
              <h3 id="other-room-members">
                <span>Other members</span>
                <span>{memberGroups.otherMembers.length}</span>
              </h3>
              {memberGroups.otherMembers.length ? (
                <div role="presentation">
                  {memberGroups.otherMembers.map((member) => (
                    <div key={member.principal} role="listitem">
                      <MemberProfileRow member={member} roomStatus={roomStatus} onWake={insertMemberMention} />
                    </div>
                  ))}
                </div>
              ) : <p className="flr-room__member-empty">No other members.</p>}
            </section>
          </div>
        </div>

        <div className="flr__col flr__activity flr-room">
          <div className="flr__colhead">
            {controls ? <><h2 className="flr-room__sr-only">{room.name}</h2>{controls}</> : <h2>{room.name}</h2>}
            <span className="flr__count">#{room.latest_sequence || latest || 0}</span>
          </div>
          <div ref={messagesRef} className="flr-room__messages">
            {room.client_mode && !ownerOnline && <div className="flr-room__history-banner" role="status" aria-label="Room owner status">S1 Room owner offline — new posts remain pending on PC1.</div>}
            {aroundSequence && <div className="flr-room__history-banner"><span>Search result context</span><button type="button" onClick={onReturnLatest}>Return to latest</button></div>}
            {!aroundSequence && lifecycleAvailable && room.history_available && !history && <button className="flr-room__history-action" type="button" onClick={() => setHistory(true)}>Show earlier history</button>}
            {!aroundSequence && history && <button className="flr-room__history-action" type="button" onClick={() => setHistory(false)}>Show current messages</button>}
            {messages.hasNextPage && <button className="flr-room__history-action" type="button" disabled={messages.isFetchingNextPage} onClick={() => void loadOlder()}>Load older messages</button>}
            {messages.isLoading && <div className="flr-room__state">Loading room…</div>}
            {messages.error && <div className="flr-room__state is-error">Room messages unavailable.</div>}
            {!messages.isLoading && !messages.error && ordered.length === 0 && (
              <div className="flr-room__state">No messages yet. Post the first update below.</div>
            )}
            {ordered.map((message) => {
              const delivery = mentionsBySource.get(message.id) ?? [];
              return <article
                className={`flr-room__message${aroundSequence === message.sequence ? " is-search-target" : ""}`}
                data-room-sequence={message.sequence}
                tabIndex={-1}
                key={message.id}
              >
                <header>
                  <strong>{names.get(message.author_principal) ?? message.author_principal}</strong>
                  <span>#{message.sequence}</span>
                </header>
                <p>{message.body}</p>
                {delivery.length > 0 && (
                  <ul className="flr-room__mentions" aria-label={`Mention delivery for message ${message.sequence}`}>
                    {delivery.map((mention) => (
                      <li className={`is-${mention.status}`} key={mention.id}>
                        {names.get(mention.target_principal) ?? mention.target_principal} · {mention.status}
                        {mention.error ? ` · ${mention.error}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </article>;
            })}
            {pendingPosts.map((pending) => <article className="flr-room__message is-pending" key={`pending:${pending.client_message_id}`}>
              <header><strong>You</strong><span>pending</span></header>
              <p>{pending.body}</p>
              <div className="flr-room__recipient-guide" role="status">Pending — will send when S1 reconnects</div>
            </article>)}
          </div>
        </div>
      </div>

      {roomStatus === "archived" ? (
        <div className="flr-room__recipient-guide" role="status">Archived room — restore to post</div>
      ) : <>
        <div
          className={`flr-room__recipient-guide${invalidTokens.length ? " is-error" : selectedMembers.length ? " is-notify" : ""}`}
          role={invalidTokens.length ? "alert" : "status"}
        >
          {recipientGuidance}
        </div>
        <div className="flr__composer flr-room__composer">
        <input
          ref={inputRef}
          className="flr__input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSuggestionsClosed(false);
          }}
          onKeyDown={(event) => {
            if (showSuggestions && event.key === "ArrowDown") {
              event.preventDefault();
              setActiveSuggestion((current) => (current + 1) % suggestions.length);
              return;
            }
            if (showSuggestions && event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSuggestion((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
              return;
            }
            if (showSuggestions && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              pickSuggestion(suggestions[activeSuggestionIndex >= 0 ? activeSuggestionIndex : 0]);
              return;
            }
            if (showSuggestions && event.key === "Escape") {
              event.preventDefault();
              setSuggestionsClosed(true);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Post to the room, or type @ to notify an agent…"
          aria-label="Room message"
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? "agent-room-mention-suggestions" : undefined}
          aria-activedescendant={showSuggestions && activeSuggestionIndex >= 0 ? `agent-room-mention-${suggestions[activeSuggestionIndex].principal}` : undefined}
        />
        {showSuggestions && (
          <div className="flr-room__mention-picker" id="agent-room-mention-suggestions" role="listbox" aria-label="Mention an agent">
            {suggestions.map((member, index) => (
              <button
                id={`agent-room-mention-${member.principal}`}
                className="flr-room__mention-option"
                type="button"
                role="option"
                aria-selected={activeSuggestionIndex === index}
                key={member.principal}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickSuggestion(member)}
              >
                <strong>{member.display_name}</strong>
                <span>{member.mention_token}</span>
              </button>
            ))}
          </div>
        )}
        <button className="flr__send" type="button" onClick={submit} disabled={!draft.trim() || post.isPending || invalidTokens.length > 0} aria-label="Post message">
          <Send size={15} />
        </button>
        </div>
      </>}
      {post.error && <div className="flr-room__post-error">Message was not posted. Try again.</div>}
    </div>
  );
}
