import {
  readMembershipBookIds,
  type CatalogBookMembership,
} from "../domain/rediscover.js";

export class ResearchMembershipStoreUnavailableError extends Error {}
export class ResearchMembershipIntegrityError extends Error {}

export interface ResearchMembershipStore {
  lookup(bookIds: string[]): Promise<Map<string, CatalogBookMembership[]>>;
}

function textCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareMemberships(a: CatalogBookMembership, b: CatalogBookMembership): number {
  if (a.projectLifecycleState !== b.projectLifecycleState) {
    return a.projectLifecycleState === "ACTIVE" ? -1 : 1;
  }

  if (a.noteUpdatedAt !== b.noteUpdatedAt) {
    if (a.noteUpdatedAt === null) return 1;
    if (b.noteUpdatedAt === null) return -1;
    const timestamp = textCompare(b.noteUpdatedAt, a.noteUpdatedAt);
    if (timestamp !== 0) return timestamp;
  }

  const byName = textCompare(a.projectName, b.projectName);
  return byName !== 0 ? byName : textCompare(a.projectId, b.projectId);
}

export function createResearchMembershipService(store: ResearchMembershipStore) {
  return {
    async lookup(input: unknown) {
      const bookIds = readMembershipBookIds(input);
      const memberships = Object.create(null) as Record<string, CatalogBookMembership[]>;
      if (bookIds.length === 0) return { memberships };

      const found = await store.lookup(bookIds);
      for (const bookId of bookIds) {
        memberships[bookId] = [...(found.get(bookId) ?? [])].sort(compareMemberships);
      }
      return { memberships };
    },
  };
}

export type ResearchMembershipService = ReturnType<typeof createResearchMembershipService>;
