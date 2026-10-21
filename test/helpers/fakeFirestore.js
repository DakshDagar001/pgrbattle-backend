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

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function reference(name, id) {
    return {
      collection: name,
      id,
      async get() {
        return snapshot(id, store(name).get(id));
      },
      async create(data) {
        const docs = store(name);
        if (docs.has(id)) throw alreadyExistsError(id);
        docs.set(id, structuredClone(data));
        return { writeTime: 'fake' };
      },
      async set(data, options = {}) {
        const docs = store(name);
        docs.set(id, options.merge
          ? { ...(docs.get(id) || {}), ...structuredClone(data) }
          : structuredClone(data));
        return { writeTime: 'fake' };
      },
      async delete() {
        store(name).delete(id);
        return { writeTime: 'fake' };
      }
    };
  }

  function collection(name) {
    return {
      id: name,
      doc: id => reference(name, id),
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
      }
    };

    const result = await work(transaction);
    for (const write of writes) await write.ref.set(write.data, write.options);
    return result;
  }

  return {
    collection,
    runTransaction,
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
