import { useState, useEffect, useCallback } from 'react';
import { collection, onSnapshot, query, orderBy, where } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Hook genérico para escuchar una colección de Firestore en tiempo real.
 * Mismo patrón que AutoBOM Pro usa inline en useEffect.
 *
 * @param {string} collectionName - Nombre de la colección
 * @param {object} options - { orderByField, orderDirection, whereConditions }
 */
export function useCollection(collectionName, options = {}) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(n => n + 1), []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const constraints = [];

    if (options.whereConditions) {
      options.whereConditions.forEach(([field, op, value]) => {
        constraints.push(where(field, op, value));
      });
    }

    if (options.orderByField) {
      constraints.push(orderBy(options.orderByField, options.orderDirection || 'asc'));
    }

    const q = constraints.length > 0
      ? query(collection(db, collectionName), ...constraints)
      : collection(db, collectionName);

    // Si Firestore no responde (red/proxy bloqueando), no dejar el skeleton para siempre
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        setError(new Error('timeout'));
        setLoading(false);
      }
    }, 15000);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      settled = true;
      clearTimeout(timer);
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setData(docs);
      setError(null);
      setLoading(false);
    }, (err) => {
      settled = true;
      clearTimeout(timer);
      console.error(`[useCollection:${collectionName}]`, err);
      setError(err);
      setLoading(false);
    });

    return () => { clearTimeout(timer); unsubscribe(); };
  }, [collectionName, JSON.stringify(options), attempt]);

  return { data, loading, error, retry };
}
