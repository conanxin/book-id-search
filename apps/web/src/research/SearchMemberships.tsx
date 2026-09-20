import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useS32Token } from "./access";
import { getResearchMemberships, ProjectApiError, type ResearchMembership } from "./api";

export type MembershipLoadState = "no-token" | "loading" | "ready" | "auth-error" | "unavailable";

export function useSearchMemberships(bookIds: string[]) {
  const token = useS32Token();
  const requestKey = JSON.stringify(Array.from(new Set(bookIds.filter(Boolean))));
  const uniqueBookIds = useMemo<string[]>(() => JSON.parse(requestKey), [requestKey]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<MembershipLoadState>(token ? "loading" : "no-token");
  const [memberships, setMemberships] = useState<Record<string, ResearchMembership[]>>({});

  useEffect(() => {
    setMemberships({});
    if (!token) {
      setState("no-token");
      return;
    }
    if (uniqueBookIds.length === 0) {
      setState("ready");
      return;
    }

    const request = new AbortController();
    setState("loading");
    getResearchMemberships(token, uniqueBookIds, request.signal)
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
  }, [token, requestKey, refreshVersion]);

  const refresh = useCallback(() => setRefreshVersion(version => version + 1), []);
  return { state, memberships, refresh };
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

  if (state === "no-token") return null;
  if (state === "loading") return <p className="research-membership-status">正在确认研究状态…</p>;
  if (state === "auth-error") return <p className="research-membership-status research-membership-status--error">研究项目访问凭据已失效，请重新设置。</p>;
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
