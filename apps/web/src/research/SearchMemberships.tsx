import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { getWebAuthAuthGeneration } from "../auth/session";
import { getResearchMemberships, ProjectApiError, type ResearchMembership } from "./api";

export type MembershipLoadState = "unauthenticated" | "loading" | "ready" | "auth-error" | "unavailable";

export function useSearchMemberships(bookIds: string[]) {
  const session = useWebAuthSession();
  const requestKey = JSON.stringify(Array.from(new Set(bookIds.filter(Boolean))));
  const uniqueBookIds = useMemo<string[]>(() => JSON.parse(requestKey), [requestKey]);
  const authGeneration = getWebAuthAuthGeneration();
  const scopeKey = JSON.stringify([authGeneration, requestKey]);
  const [visibleScope, setVisibleScope] = useState(scopeKey);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<MembershipLoadState>(session.status === "authenticated" ? "loading" : "unauthenticated");
  const [memberships, setMemberships] = useState<Record<string, ResearchMembership[]>>({});

  useEffect(() => {
    // Hide private data before the new request can be settled.
    setVisibleScope(scopeKey);
    setMemberships({});
    if (session.status !== "authenticated") {
      setState("unauthenticated");
      return;
    }
    if (uniqueBookIds.length === 0) {
      setState("ready");
      return;
    }

    const request = new AbortController();
    setState("loading");
    getResearchMemberships(uniqueBookIds, request.signal)
      .then(data => {
        if (!request.signal.aborted) {
          setMemberships(data.memberships);
          setState("ready");
        }
      })
      .catch(error => {
        if (request.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setMemberships({});
        setState(error instanceof ProjectApiError && (error.status === 401 || error.status === 403) ? "auth-error" : "unavailable");
      });
    return () => request.abort();
  }, [requestKey, refreshVersion, session.status, scopeKey]);

  const refresh = useCallback(() => setRefreshVersion(version => version + 1), []);
  // React commits before useEffect runs. Mask old private data synchronously
  // during a same-status Owner session rotation or a different book request.
  const visible = session.status === "authenticated" && visibleScope === scopeKey;
  return {
    state: session.status !== "authenticated" ? "unauthenticated" : visible ? state : "loading",
    memberships: visible ? memberships : {},
    refresh,
  };
}

export function ResearchMembershipChips({
  state,
  memberships,
}: {
  state: MembershipLoadState;
  memberships: ResearchMembership[];
}) {
  const [expanded, setExpanded] = useState(false);
  const membershipKey = memberships.map(item => `${item.projectId}:${item.bindingId}`).join("|");
  useEffect(() => setExpanded(false), [membershipKey]);

  if (state === "unauthenticated") return null;
  if (state === "loading") return <p className="research-membership-status">正在确认研究状态…</p>;
  if (state === "auth-error") return <p className="research-membership-status research-membership-status--error">登录已失效，请重新登录。</p>;
  if (state === "unavailable") return <p className="research-membership-status research-membership-status--error">研究状态暂不可用</p>;

  const active = memberships.filter(item => item.projectLifecycleState === "ACTIVE");
  const archived = memberships.filter(item => item.projectLifecycleState === "ARCHIVED");
  if (active.length === 0 && archived.length === 0) return null;
  const visibleActive = expanded ? active : active.slice(0, 2);
  const visibleArchived = expanded ? archived : archived.slice(0, 1);
  const hiddenCount = memberships.length - visibleActive.length - visibleArchived.length;
  const renderChip = (item: ResearchMembership) => (
    <Link
      key={item.bindingId}
      className={`research-membership-chip research-membership-chip--${item.projectLifecycleState.toLowerCase()}`}
      to={`/research/projects/${item.projectId}?item=${encodeURIComponent(item.bindingId)}`}
    >
      {item.projectName}
    </Link>
  );

  return <div className="research-memberships">
    {visibleActive.length ? <div className="research-membership-group"><span>已在研究</span>{visibleActive.map(renderChip)}</div> : null}
    {visibleArchived.length ? <div className="research-membership-group"><span>曾用于研究</span>{visibleArchived.map(renderChip)}</div> : null}
    {!expanded && hiddenCount > 0 ? <button type="button" className="research-membership-more" onClick={() => setExpanded(true)} aria-label={`展开其余 ${hiddenCount} 个项目`}>+{hiddenCount}</button> : null}
  </div>;
}
