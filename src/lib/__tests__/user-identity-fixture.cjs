// Identity-aware fixtures for tests whose focus is account policy or settings.
// Persistence and rename behavior are exercised against the real storage facade.
function createIdentityFixture(getUsers, owner = process.env.USERNAME) {
  const identities = new Map();
  let lastUid = 0n;
  const numericUid = /^[1-9][0-9]*$/;
  const legacyUid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

  function allocateUserUid() {
    for (const entry of [...getUsers(), ...identities.values()]) {
      if (typeof entry.uid === 'string' && numericUid.test(entry.uid)) {
        const used = BigInt(entry.uid);
        if (used > lastUid) lastUid = used;
      }
    }
    lastUid++;
    return String(lastUid);
  }

  function identityFor(username) {
    const user = getUsers().find((entry) => entry.username === username);
    if (!user && (!owner || username !== owner)) return null;
    let identity = identities.get(username);
    if (!identity || (user?.uid && identity.uid !== user.uid)) {
      identity = {
        // Explicit UUID overrides keep migration fixtures meaningful.
        uid: user?.uid || allocateUserUid(),
        username,
        storageKey: username,
        sessionVersion: user?.sessionVersion ?? 0,
        ...(user?.legacyUids ? { legacyUids: [...user.legacyUids] } : {}),
      };
      identities.set(username, identity);
    }
    return identity;
  }

  function matchesUid(identity, uid) {
    return identity?.uid === uid || identity?.legacyUids?.includes(uid);
  }

  return {
    findUser(reference) {
      const uidReference = numericUid.test(reference) || legacyUid.test(reference);
      return getUsers().find(
        (user) => matchesUid(identityFor(user.username), reference) ||
          (!uidReference && user.username === reference),
      );
    },
    async allocateUserUid() {
      return allocateUserUid();
    },
    async getAllUserIdentities() {
      const usernames = new Set(getUsers().map((user) => user.username));
      if (owner) usernames.add(owner);
      return [...usernames].map(identityFor).filter(Boolean);
    },
    async getUserIdentity(username) {
      return identityFor(username);
    },
    async getUserIdentityByUid(uid) {
      const usernames = new Set(getUsers().map((user) => user.username));
      if (owner) usernames.add(owner);
      for (const username of usernames) {
        const identity = identityFor(username);
        if (matchesUid(identity, uid)) return identity;
      }
      return null;
    },
    async isLegacyUsernameRetired() {
      return false;
    },
  };
}

module.exports = { createIdentityFixture };
