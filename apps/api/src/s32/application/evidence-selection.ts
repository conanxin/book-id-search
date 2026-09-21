import { readProjectId } from '../domain/project.js';
import { readResearchIssueId } from '../domain/research-issue.js';
import { readCandidateClaimId, type CandidateClaim } from '../domain/candidate-claim.js';
import { normalizeEvidencePreviewInput, buildEvidenceManifestDraft, type EvidenceDraftInputItem, type EvidenceManifestDraft } from '../domain/evidence-selection.js';

export class EvidenceSelectionScopeNotFoundError extends Error {}
export class EvidenceTargetNotAvailableError extends Error {}
export class EvidenceSelectionIntegrityError extends Error {}
export class EvidenceSelectionStoreUnavailableError extends Error {}

export interface EvidenceClaimContext {
  id: string;
  statement: string;
  lifecycleState: 'ACTIVE' | 'ARCHIVED';
}

export type EvidenceSourceType =
  | 'PUBLICATION' | 'WEB_PAGE' | 'ARCHIVAL_RECORD' | 'DATABASE_RECORD'
  | 'MUSEUM_OBJECT' | 'EXHIBITION_LABEL' | 'EMAIL'
  | 'FIELD_OBSERVATION' | 'INTERVIEW' | 'OTHER';

export type EvidenceAssetType =
  | 'DOCUMENT' | 'IMAGE' | 'AUDIO' | 'VIDEO'
  | 'WEB_SNAPSHOT' | 'TEXT' | 'DATA' | 'OTHER';

export type EvidenceCandidate =
  | {
      targetType: 'SOURCE';
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceType: EvidenceSourceType;
      sourceLifecycleState: 'ACTIVE' | 'ARCHIVED';
      observedAt: string;
    }
  | {
      targetType: 'SOURCE_ASSET';
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceId: string;
      assetType: EvidenceAssetType;
      assetRole: 'ORIGINAL' | 'DERIVED';
      storageMode: 'LOCAL' | 'REMOTE' | 'HYBRID';
      createdAt: string;
    }
  | {
      targetType: 'NOTE_REVISION';
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      noteId: string;
      revisionNo: number;
      contentFormat: 'MARKDOWN' | 'PLAIN_TEXT';
      createdAt: string;
    };

export interface EvidenceSelectionStore {
  candidates(input: {
    projectId: string;
    issueId: string;
    claimId: string;
  }): Promise<{ claim: EvidenceClaimContext; candidates: EvidenceCandidate[] } | null>;
  authorizePreview(input: {
    projectId: string;
    issueId: string;
    claimId: string;
    items: EvidenceDraftInputItem[];
  }): Promise<{ claim: EvidenceClaimContext } | null>;
}

export function createEvidenceSelectionService(store: EvidenceSelectionStore) {
  return {
    async candidates(project: unknown, issue: unknown, claim: unknown) {
      return store.candidates({
        projectId: readProjectId(project).toLowerCase(),
        issueId: readResearchIssueId(issue),
        claimId: readCandidateClaimId(claim),
      });
    },
    async preview(project: unknown, issue: unknown, claim: unknown, body: unknown) {
      const projectId = readProjectId(project).toLowerCase();
      const issueId = readResearchIssueId(issue);
      const claimId = readCandidateClaimId(claim);
      const items = normalizeEvidencePreviewInput(body);
      const authorized = await store.authorizePreview({ projectId, issueId, claimId, items });
      if (!authorized) throw new EvidenceSelectionScopeNotFoundError('PROJECT_ISSUE_OR_CLAIM_NOT_FOUND');
      return {
        claim: { id: authorized.claim.id, statement: authorized.claim.statement },
        draft: buildEvidenceManifestDraft(items),
        persisted: false as const,
      };
    },
  };
}

export type EvidenceSelectionService = ReturnType<typeof createEvidenceSelectionService>;
