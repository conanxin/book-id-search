import { useState } from "react";
import { Link } from "react-router-dom";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { AddToProject } from "./AddToProject";
import { ResearchMembershipChips, useSearchMemberships } from "./SearchMemberships";
import type { ProjectResearchItem, ResearchMembership } from "./api";

type ConfirmedBinding = Pick<ProjectResearchItem, "projectId" | "bindingId">;

/**
 * Book Detail only. Source and route identity are checked by DetailPage before
 * mounting this component; React keys invalidate the scope on Book/Owner changes.
 */
export function BookDetailResearchActions({ bookId, bookTitle }: {
  bookId: string;
  bookTitle: string;
}) {
  const session = useWebAuthSession();
  const relation = useSearchMemberships([bookId]);
  const [added, setAdded] = useState<ConfirmedBinding | null>(null);
  const currentMemberships: ResearchMembership[] =
    Object.hasOwn(relation.memberships, bookId) && Array.isArray(relation.memberships[bookId])
      ? relation.memberships[bookId]
      : [];

  return <section className="detail-research" aria-label="本书的研究操作">
    <h2>本书的研究操作</h2>
    <p className="research-muted">关联书目版本与研究项目；不表示已经获得全文或完成阅读。</p>
    <ResearchMembershipChips state={relation.state} memberships={currentMemberships} />
    <AddToProject
      bookId={bookId}
      bookTitle={bookTitle}
      membershipState={relation.state}
      memberships={relation.state === "ready" ? currentMemberships : undefined}
      onMembershipInvalidated={relation.refresh}
      onAdded={(item) => setAdded({ projectId: item.projectId, bindingId: item.bindingId })}
    />
    {session.status === "authenticated" && added ? <p className="detail-research__continue">
      <Link to={`/research/projects/${encodeURIComponent(added.projectId)}?item=${encodeURIComponent(added.bindingId)}`}>
        查看这本书在项目中的资料
      </Link>
    </p> : null}
  </section>;
}
