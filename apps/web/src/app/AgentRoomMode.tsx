import { useEffect, useMemo, useState } from "react";
import { Send } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { AgentRoom } from "../lib/types";

export function AgentRoomMode({ room }: { room: AgentRoom }) {
  const [draft, setDraft] = useState("");
  const messages = useInfiniteQuery({
    queryKey: ["agent-room", room.id, "messages"],
    queryFn: ({ pageParam }) => api.agentRoomSync(room.id, pageParam, 100),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.result.has_more ? lastPage.result.next_sequence : undefined,
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
  const names = useMemo(
    () => new Map((members.data?.result.members ?? []).map((member) => [member.principal, member.display_name])),
    [members.data],
  );
  const post = useMutation({
    mutationFn: (body: string) =>
      api.agentRoomPost(room.id, {
        client_message_id: globalThis.crypto?.randomUUID?.() ?? `room-${Date.now()}`,
        body,
      }),
    onSuccess: async () => {
      setDraft("");
      await messages.refetch();
    },
  });

  useEffect(() => {
    if (messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
  }, [messages.hasNextPage, messages.isFetchingNextPage, messages.fetchNextPage]);

  const latest = ordered.length ? ordered[ordered.length - 1].sequence : 0;
  useEffect(() => {
    if (latest > 0) void api.agentRoomAck(room.id, latest).catch(() => {});
  }, [latest, room.id]);

  const submit = () => {
    const body = draft.trim();
    if (body && !post.isPending) post.mutate(body);
  };

  return (
    <div className="flr">
      <div className="flr__cols">
        <div className="flr__col flr__roster">
          <div className="flr__colhead">
            <h2>Members</h2>
            <span className="flr__count">{members.data?.result.members.length ?? 0}</span>
          </div>
          <div className="flr__list" role="list" aria-label="Room members">
            {(members.data?.result.members ?? []).map((member) => (
              <div key={member.principal} className="flr__member" role="listitem">
                <span className="flr__dot" aria-hidden />
                <div className="flr__who">
                  <span className="flr__name">{member.display_name}</span>
                  <span className="flr__meta">{member.role} · {member.host}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flr__col flr__activity flr-room">
          <div className="flr__colhead">
            <h2>{room.name}</h2>
            <span className="flr__count">#{latest || 0}</span>
          </div>
          <div className="flr-room__messages" aria-live="polite">
            {messages.isLoading && <div className="flr-room__state">Loading room…</div>}
            {messages.error && <div className="flr-room__state is-error">Room messages unavailable.</div>}
            {!messages.isLoading && !messages.error && ordered.length === 0 && (
              <div className="flr-room__state">No messages yet. Post the first update below.</div>
            )}
            {ordered.map((message) => (
              <article className="flr-room__message" key={message.id}>
                <header>
                  <strong>{names.get(message.author_principal) ?? message.author_principal}</strong>
                  <span>#{message.sequence}</span>
                </header>
                <p>{message.body}</p>
              </article>
            ))}
          </div>
        </div>
      </div>

      <div className="flr__composer">
        <span className="flr__target is-cast" title="Plain room text wakes no agent">
          Room · no wake
        </span>
        <input
          className="flr__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Post a room update…"
          aria-label="Room message"
        />
        <button className="flr__send" type="button" onClick={submit} disabled={!draft.trim() || post.isPending} aria-label="Post message">
          <Send size={15} />
        </button>
      </div>
      {post.error && <div className="flr-room__post-error">Message was not posted. Try again.</div>}
    </div>
  );
}
