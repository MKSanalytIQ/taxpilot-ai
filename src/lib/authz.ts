export function canAccessReturn(ownerId: string, session: { userId: string; role: string }) {
  return session.role === "ADMIN" || ownerId === session.userId;
}

export function canAccessDocument(ownerId: string, session: { userId: string; role: string }) {
  return canAccessReturn(ownerId, session);
}

export function canAccessTaxFact(ownerId: string, session: { userId: string; role: string }) {
  return canAccessDocument(ownerId, session);
}

export function canAccessConflict(ownerId: string, session: { userId: string; role: string }) {
  return canAccessDocument(ownerId, session);
}
