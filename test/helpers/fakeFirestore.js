/**
 * Minimal in-memory Firestore double for auth unit tests.
 *
 * Only the surface used by the auth routes is implemented. The important
 * semantic is `create()`: existence is checked synchronously at call time, so
 * concurrent claims behave like a single-document transactional write — exactly
 * one succeeds and the rest fail with gRPC code 6 (ALREADY_EXISTS).
 */

function alreadyExistsError(id) {
  const error = new Error(`ALREADY_EXISTS: document usernames/${id} already exists`);
  error.code = 6;
  return error;
}

function snapshot(id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : structuredClone(data))
  };
}

function createFakeFirestore(seed = {}) {
  const stores = new Map();
  for (const [name, docs] of Object.entries(seed)) {
    stores.set(name, new Map(Object.entries(docs).map(([id, data]) => [id, structuredClone(data)])));
  }

  // Injected infrastructure faults, so a test can make one document read or write
  // fail exactly the way a dropped Firestore connection would.
  const faults = new Set();
  function checkFault(name, id, operation) {
    const key = `${name}/${id}#${operation}`;
    if (!faults.has(key)) return;
    const error = new Error(`injected failure: ${operation} on ${key}`);
    error.code = 14; // gRPC UNAVAILABLE
    throw error;
  }

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function reference(name, id) {
    return {
      id,
      path: `${name}/${id}`,
      __store: name,
      // Subcollections are keyed by their full path, matching how a document
      // reference exposes `.collection()` in the real SDK.
      collection: sub => collection(`${name}/${id}/${sub}`),
      async get() {
        checkFault(name, id, 'get');
        return snapshot(id, store(name).get(id));
      },
      async create(data) {
        checkFault(name, id, 'create');
        const docs = store(name);
        if (docs.has(id)) throw alreadyExistsError(id);
        docs.set(id, structuredClone(data));
        return { writeTime: 'fake' };
      },
      async set(data, options = {}) {
        checkFault(name, id, 'set');
        const docs = store(name);
        docs.set(id, options.merge
          ? { ...(docs.get(id) || {}), ...structuredClone(data) }
          : structuredClone(data));
        return { writeTime: 'fake' };
      },
      async delete() {
        checkFault(name, id, 'delete');
        store(name).delete(id);
        return { writeTime: 'fake' };
      }
    };
  }

  function collection(name) {
    return {
      id: name,
      doc: id => reference(name, id),
      async get() {
        const docs = [...store(name).entries()].map(([id, data]) => snapshot(id, data));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
      where(field, operator, value) {
        let limit = Infinity;
        const query = {
          limit(n) {
            limit = n;
            return query;
          },
          async get() {
            if (operator !== '==') throw new Error(`Unsupported operator in fake: ${operator}`);
            const matches = [...store(name).entries()]
              .filter(([, data]) => data[field] === value)
              .slice(0, limit)
              .map(([id, data]) => snapshot(id, data));
            return { empty: matches.length === 0, size: matches.length, docs: matches };
          }
        };
        return query;
      }
    };
  }

  async function runTransaction(work) {
    const writes = [];
    const transaction = {
      async get(ref) {
        return ref.get();
      },
      set(ref, data, options) {
        writes.push({ ref, data, options });
        return null;
      },
      delete(ref) {
        writes.push({ ref, remove: true });
        return null;
      }
    };

    const result = await work(transaction);
    // A real commit is all-or-nothing: if applying one write fails, nothing lands.
    // Each write is therefore undoable, so an injected fault leaves every document
    // exactly as it was before the transaction ran.
    const applied = [];
    try {
      for (const write of writes) {
        const docs = store(write.ref.__store);
        applied.push({ store: write.ref.__store, id: write.ref.id, before: docs.get(write.ref.id) });
        if (write.remove) await write.ref.delete();
        else await write.ref.set(write.data, write.options);
      }
    } catch (error) {
      for (const entry of applied.reverse()) {
        const docs = store(entry.store);
        if (entry.before === undefined) docs.delete(entry.id);
        else docs.set(entry.id, structuredClone(entry.before));
      }
      throw error;
    }
    return result;
  }

  return {
    collection,
    runTransaction,
    __fail(name, id, operation) {
      faults.add(`${name}/${id}#${operation}`);
    },
    __heal(name, id, operation) {
      faults.delete(`${name}/${id}#${operation}`);
    },
    __seed(name, id, data) {
      store(name).set(id, structuredClone(data));
    },
    __peek(name, id) {
      return store(name).get(id);
    },
    __names() {
      return [...stores.keys()];
    }
  };
}

module.exports = { createFakeFirestore, alreadyExistsError };
