import { useState, useEffect } from 'react';
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

  useEffect(() => {
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

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setData(docs);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [collectionName, JSON.stringify(options)]);

  return { data, loading };
}
